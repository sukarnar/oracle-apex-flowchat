-- FC_CHANNEL: post cards to Microsoft Teams channels. Optional.
--
-- Uses the Teams Workflows template "Post to a channel when a webhook request is received": the
-- workflow gives a URL, and anything POSTed to it appears in its channel as an Adaptive Card. One way
-- only: cards can have buttons that open links (Action.OpenUrl), but nobody can answer them. For
-- conversations in Teams, see FC_TEAMS (20) and FC_AUTOMATE (23).
--
--   FC_TEAMS_CHANNELS   channel name -> the workflow URL. Add rows with fc_channel.add_channel.
--                       The URL is a secret (anyone who has it can post to the channel): don't grant
--                       SELECT on this table, and keep URLs out of flows and source control.
--
-- Flows post with the "teams" node (Post to Teams in the designer), which FC_ENGINE hands to
-- fc_channel.post_message. PL/SQL code can call fc_channel.post directly. Mirrors channelCard /
-- createTeamsPoster in tools/flowchat-cards.js (tested in tests/channel.test.js).
--
-- The schema needs a network ACL (connect, resolve) for the workflow URL's host, and HTTPS needs
-- Microsoft's root certificates in the wallet APEX uses (already there on Autonomous Database).
-- Safe to re-run: the table and its rows are kept.
set define off

declare
  l_n pls_integer;
begin
  select count(*) into l_n from user_tables where table_name = 'FC_TEAMS_CHANNELS';
  if l_n = 0 then
    execute immediate q'[
      create table fc_teams_channels (
        channel_name   varchar2(100)  not null,
        workflow_url   varchar2(2000) not null,
        description    varchar2(4000),
        enabled        varchar2(1)    default 'Y' not null,
        last_posted_at timestamp with time zone,
        last_error     varchar2(4000),
        last_error_at  timestamp with time zone,
        created_at     timestamp with time zone default systimestamp not null,
        constraint fc_teams_channels_pk primary key (channel_name),
        constraint fc_teams_channels_name_ck check (regexp_like(channel_name, '^[a-z0-9_-]+$')),
        constraint fc_teams_channels_url_ck check (workflow_url like 'https://%'),
        constraint fc_teams_channels_en_ck check (enabled in ('Y', 'N'))
      )]';
    execute immediate q'[comment on table fc_teams_channels is 'FlowChat: Teams channels a flow can post to (Workflows webhook URLs)']';
    execute immediate q'[comment on column fc_teams_channels.workflow_url is 'Secret: the URL of the Teams workflow "Post to a channel when a webhook request is received"']';
  end if;
end;
/

create or replace package fc_channel authid definer as

  -- Adds or replaces a channel. p_name: lower case letters, digits, _ and - (flows use it).
  procedure add_channel (p_name        in varchar2,
                         p_url         in varchar2,
                         p_description in varchar2 default null);

  -- The Adaptive Card (1.4) for a message {title, text, facts: [{title, value}], link, linkLabel, style}.
  function build_card (p_msg in clob) return clob;
  -- The body the workflow expects: {"type": "message", "attachments": [the card]}.
  function build_payload (p_msg in clob) return clob;

  -- Posts a message {channel, title, text, facts, link, linkLabel, style}. Returns null when Teams
  -- accepted it, else the problem. Never raises (FC_ENGINE's teams node calls it).
  function post_message (p_msg in clob) return varchar2;

  -- Posts a card; raises ORA-20070 when it fails. p_facts: {"Label": "value", ...} in display order.
  -- p_style: default, emphasis, good, attention, warning or accent (the title's background).
  procedure post (p_channel    in varchar2,
                  p_title      in varchar2,
                  p_text       in varchar2      default null,
                  p_facts      in json_object_t default null,
                  p_link       in varchar2      default null,
                  p_link_label in varchar2      default 'Open',
                  p_style      in varchar2      default null);

  -- Posts "FlowChat can post to this channel." to check the URL, ACL and wallet.
  procedure send_test (p_channel in varchar2);

end fc_channel;
/

create or replace package body fc_channel as

  c_styles constant varchar2(100) := ',emphasis,good,attention,warning,accent,';

  function str (p_obj in json_object_t, p_key in varchar2) return varchar2 is
  begin
    if p_obj is null or not p_obj.has(p_key) or p_obj.get(p_key).is_null then return null; end if;
    if p_obj.get(p_key).is_string then return p_obj.get_string(p_key); end if;
    return p_obj.get(p_key).to_string;
  end str;

  -- "[text](url)" in an answer would become a link in a post made under the workflow owner's name.
  function no_links (p in varchar2) return varchar2 is
  begin
    return regexp_replace(p, '\][[:space:]]*\(', '] (');
  end no_links;

  function cut (p in varchar2, p_max in pls_integer) return varchar2 is
  begin
    if length(p) > p_max then return substr(p, 1, p_max - 1) || unistr('\2026'); end if;
    return p;
  end cut;

  function text_block (p_text in varchar2) return json_object_t is
    l json_object_t := json_object_t();
  begin
    l.put('type', 'TextBlock');
    l.put('text', p_text);
    l.put('wrap', true);
    return l;
  end text_block;

  function card_of (p_msg in json_object_t) return json_object_t is
    l_card    json_object_t := json_object_t();
    l_body    json_array_t  := json_array_t();
    l_acts    json_array_t  := json_array_t();
    l_facts   json_array_t  := json_array_t();
    l_in      json_array_t;
    l_title   varchar2(4000) := cut(no_links(str(p_msg, 'title')), 200);
    l_text    varchar2(32767) := cut(no_links(str(p_msg, 'text')), 4000);
    l_style   varchar2(30)   := lower(str(p_msg, 'style'));
    l_link    varchar2(4000) := str(p_msg, 'link');
    l_tb      json_object_t;
    l_box     json_object_t;
    l_items   json_array_t;
    l_f       json_object_t;
    l_o       json_object_t;
  begin
    if l_title is not null then
      l_tb := text_block(l_title);
      l_tb.put('weight', 'Bolder');
      l_tb.put('size', 'Medium');
      if instr(c_styles, ',' || l_style || ',') > 0 then
        l_box := json_object_t();
        l_box.put('type', 'Container');
        l_box.put('style', l_style);
        l_box.put('bleed', true);
        l_items := json_array_t();
        l_items.append(l_tb);
        l_box.put('items', l_items);
        l_body.append(l_box);
      else
        l_body.append(l_tb);
      end if;
    end if;
    if l_text is not null then l_body.append(text_block(l_text)); end if;

    if p_msg.has('facts') and p_msg.get('facts').is_array then
      l_in := p_msg.get_array('facts');
      for i in 0 .. l_in.get_size - 1 loop
        exit when l_facts.get_size >= 20;
        if l_in.get(i).is_object then
          l_f := treat(l_in.get(i) as json_object_t);
          if str(l_f, 'title') is not null and str(l_f, 'value') is not null then
            l_o := json_object_t();
            l_o.put('title', cut(no_links(str(l_f, 'title')), 100));
            l_o.put('value', cut(no_links(str(l_f, 'value')), 1000));
            l_facts.append(l_o);
          end if;
        end if;
      end loop;
    end if;
    if l_facts.get_size > 0 then
      l_o := json_object_t();
      l_o.put('type', 'FactSet');
      l_o.put('facts', l_facts);
      l_body.append(l_o);
    end if;

    if l_link is not null then
      l_o := json_object_t();
      l_o.put('type', 'Action.OpenUrl');
      l_o.put('title', cut(nvl(str(p_msg, 'linkLabel'), 'Open'), 50));
      l_o.put('url', l_link);
      l_acts.append(l_o);
    end if;

    l_card.put('type', 'AdaptiveCard');
    l_card.put('version', '1.4');
    l_card.put('body', l_body);
    l_card.put('actions', l_acts);
    return l_card;
  end card_of;

  function payload_of (p_msg in json_object_t) return json_object_t is
    l_att  json_object_t := json_object_t();
    l_atts json_array_t  := json_array_t();
    l_out  json_object_t := json_object_t();
  begin
    l_att.put('contentType', 'application/vnd.microsoft.card.adaptive');
    l_att.put_null('contentUrl');
    l_att.put('content', card_of(p_msg));
    l_atts.append(l_att);
    l_out.put('type', 'message');
    l_out.put('attachments', l_atts);
    return l_out;
  end payload_of;

  function build_card (p_msg in clob) return clob is
  begin
    return card_of(json_object_t.parse(p_msg)).to_clob;
  end build_card;

  function build_payload (p_msg in clob) return clob is
  begin
    return payload_of(json_object_t.parse(p_msg)).to_clob;
  end build_payload;

  procedure note_result (p_channel in varchar2, p_error in varchar2) is
    pragma autonomous_transaction;
  begin
    if p_error is null then
      update fc_teams_channels set last_posted_at = systimestamp where channel_name = p_channel;
    else
      update fc_teams_channels
         set last_error = substr(p_error, 1, 4000), last_error_at = systimestamp
       where channel_name = p_channel;
    end if;
    commit;
  end note_result;

  procedure add_channel (p_name in varchar2, p_url in varchar2, p_description in varchar2 default null) is
    l_name varchar2(100) := lower(trim(p_name));
    l_url  varchar2(2000) := trim(p_url);
  begin
    if l_name is null or not regexp_like(l_name, '^[a-z0-9_-]+$') then
      raise_application_error(-20071, 'Channel names use lower case letters, digits, _ and -.');
    end if;
    if l_url is null or lower(l_url) not like 'https://%' then
      raise_application_error(-20071, 'The workflow URL must start with https://.');
    end if;
    merge into fc_teams_channels t
    using (select l_name channel_name, l_url workflow_url, p_description description from dual) s
       on (t.channel_name = s.channel_name)
     when matched then update set t.workflow_url = s.workflow_url, t.description = nvl(s.description, t.description),
                                  t.enabled = 'Y', t.last_error = null, t.last_error_at = null
     when not matched then insert (channel_name, workflow_url, description)
                           values (s.channel_name, s.workflow_url, s.description);
  end add_channel;

  function post_message (p_msg in clob) return varchar2 is
    l_msg     json_object_t;
    l_channel varchar2(100);
    l_url     fc_teams_channels.workflow_url%type;
    l_resp    clob;
    l_problem varchar2(4000);
  begin
    l_msg := json_object_t.parse(p_msg);
    l_channel := lower(trim(substr(str(l_msg, 'channel'), 1, 100)));
    begin
      select workflow_url into l_url
        from fc_teams_channels
       where channel_name = l_channel
         and enabled = 'Y';
    exception when no_data_found then
      return 'unknown Teams channel "' || l_channel || '" (add it with fc_channel.add_channel)';
    end;

    apex_web_service.g_request_headers.delete;
    apex_web_service.set_request_headers(p_name_01 => 'Content-Type', p_value_01 => 'application/json');
    l_resp := apex_web_service.make_rest_request(p_url              => l_url,
                                                 p_http_method      => 'POST',
                                                 p_body             => payload_of(l_msg).to_clob,
                                                 p_transfer_timeout => 10);
    if apex_web_service.g_status_code not in (200, 202) then
      l_problem := 'Teams workflow returned HTTP ' || apex_web_service.g_status_code
                || ': ' || substr(dbms_lob.substr(l_resp, 200, 1), 1, 200);
    end if;
    note_result(l_channel, l_problem);
    return l_problem;
  exception when others then
    l_problem := substr(sqlerrm, 1, 4000);
    if l_channel is not null then note_result(l_channel, l_problem); end if;
    return l_problem;
  end post_message;

  procedure post (p_channel    in varchar2,
                  p_title      in varchar2,
                  p_text       in varchar2      default null,
                  p_facts      in json_object_t default null,
                  p_link       in varchar2      default null,
                  p_link_label in varchar2      default 'Open',
                  p_style      in varchar2      default null) is
    l_msg   json_object_t := json_object_t();
    l_facts json_array_t  := json_array_t();
    l_keys  json_key_list;
    l_f     json_object_t;
    l_err   varchar2(4000);
  begin
    if p_facts is not null then
      l_keys := p_facts.get_keys;
      for i in 1 .. l_keys.count loop
        l_f := json_object_t();
        l_f.put('title', l_keys(i));
        l_f.put('value', str(p_facts, l_keys(i)));
        l_facts.append(l_f);
      end loop;
    end if;
    if p_link is not null and not regexp_like(p_link, '^https://[^[:space:]]+$', 'i') then
      raise_application_error(-20070, 'The link must be an https:// URL.');
    end if;
    l_msg.put('channel', p_channel);
    l_msg.put('title', p_title);
    l_msg.put('text', p_text);
    l_msg.put('facts', l_facts);
    l_msg.put('link', p_link);
    l_msg.put('linkLabel', p_link_label);
    l_msg.put('style', p_style);
    l_err := post_message(l_msg.to_clob);
    if l_err is not null then
      raise_application_error(-20070, 'Teams post to ' || p_channel || ' failed: ' || l_err);
    end if;
  end post;

  procedure send_test (p_channel in varchar2) is
    l_f json_object_t := json_object_t();
  begin
    l_f.put('Channel', lower(p_channel));
    l_f.put('Database', sys_context('userenv', 'db_name'));
    l_f.put('Schema', sys_context('userenv', 'current_schema'));
    post(p_channel => p_channel, p_title => 'FlowChat can post to this channel.', p_facts => l_f, p_style => 'good');
  end send_test;

end fc_channel;
/

show errors package body fc_channel
