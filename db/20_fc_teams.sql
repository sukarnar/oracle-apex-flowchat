-- FC_TEAMS: run flows from Microsoft Teams through an outgoing webhook. Optional.
--
-- People @mention the webhook in a channel thread; each thread and person is one conversation. Teams
-- signs every message with HMAC-SHA256 and waits up to 5 seconds for the answer, which this package
-- returns from FC_CLIENT's turn-by-turn API (render / reply). Mirrors tools/flowchat-teams.js
-- (tested in tests/teams.test.js). The REST endpoint is in 21_fc_teams_ords.sql.
--
--   FC_TEAMS_WEBHOOKS       one row per outgoing webhook: its security token (from Teams) and the
--                           flow it runs. Add rows with fc_teams.add_webhook.
--   FC_TEAMS_USERS          Teams account (Entra object id) -> the APEX user the flow runs as.
--                           Add rows with fc_teams.map_user, or set USER_RESOLVER on the webhook.
--   FC_TEAMS_CONVERSATIONS  the FlowChat session of each thread and person.
--
-- Needs EXECUTE on SYS.DBMS_CRYPTO (already a FlowChat prerequisite). Safe to re-run: existing
-- tables and rows are kept.
set define off

declare
  l_n pls_integer;
begin
  select count(*) into l_n from user_tables where table_name = 'FC_TEAMS_WEBHOOKS';
  if l_n = 0 then
    execute immediate q'[
      create table fc_teams_webhooks (
        webhook_id     varchar2(100)  not null,
        security_token varchar2(200)  not null,
        flow_id        varchar2(100)  not null,
        flow_version   number,
        context        clob,
        tenant_id      varchar2(100),
        user_resolver  varchar2(400),
        max_age_secs   number         default 300 not null,
        description    varchar2(4000),
        enabled        varchar2(1)    default 'Y' not null,
        last_error     varchar2(4000),
        last_error_at  timestamp with time zone,
        created_at     timestamp with time zone default systimestamp not null,
        constraint fc_teams_webhooks_pk primary key (webhook_id),
        constraint fc_teams_webhooks_id_ck check (regexp_like(webhook_id, '^[A-Za-z0-9_-]+$')),
        constraint fc_teams_webhooks_ctx_ck check (context is json),
        constraint fc_teams_webhooks_en_ck check (enabled in ('Y', 'N'))
      )]';
    execute immediate q'[comment on table fc_teams_webhooks is 'FlowChat: Teams outgoing webhooks and the flow each one runs']';
    execute immediate q'[comment on column fc_teams_webhooks.security_token is 'The security token Teams shows when the outgoing webhook is created (base64 HMAC key)']';
    execute immediate q'[comment on column fc_teams_webhooks.tenant_id is 'Accept messages only from this Microsoft Entra tenant (null = any)']';
    execute immediate q'[comment on column fc_teams_webhooks.user_resolver is 'Optional function (aad_object_id, display_name) return the APEX user; else FC_TEAMS_USERS']';
    execute immediate q'[comment on column fc_teams_webhooks.max_age_secs is 'Refuse messages whose timestamp is older than this (replays); 0 = no check']';
  end if;

  select count(*) into l_n from user_tables where table_name = 'FC_TEAMS_USERS';
  if l_n = 0 then
    execute immediate q'[
      create table fc_teams_users (
        aad_object_id varchar2(64)  not null,
        app_user      varchar2(255) not null,
        display_name  varchar2(400),
        enabled       varchar2(1)   default 'Y' not null,
        created_at    timestamp with time zone default systimestamp not null,
        constraint fc_teams_users_pk primary key (aad_object_id),
        constraint fc_teams_users_en_ck check (enabled in ('Y', 'N'))
      )]';
    execute immediate q'[comment on table fc_teams_users is 'FlowChat: Teams accounts (Entra object id) and the APEX user each one runs flows as']';
  end if;

  select count(*) into l_n from user_tables where table_name = 'FC_TEAMS_CONVERSATIONS';
  if l_n = 0 then
    execute immediate q'[
      create table fc_teams_conversations (
        webhook_id       varchar2(100)  not null,
        conversation_id  varchar2(1000) not null,
        aad_object_id    varchar2(64)   not null,
        session_id       varchar2(32),
        status           varchar2(20)   default 'active' not null,
        last_turn        clob,
        last_activity_id varchar2(200),
        last_response    clob,
        created_at       timestamp with time zone default systimestamp not null,
        updated_at       timestamp with time zone default systimestamp not null,
        constraint fc_teams_conv_pk primary key (webhook_id, conversation_id, aad_object_id),
        constraint fc_teams_conv_st_ck check (status in ('active', 'done')),
        constraint fc_teams_conv_fk foreign key (webhook_id) references fc_teams_webhooks (webhook_id) on delete cascade
      )]';
    execute immediate q'[comment on table fc_teams_conversations is 'FlowChat: the session of each Teams thread and person']';
  end if;
end;
/

create or replace package fc_teams authid definer as

  -- Handles one POST from a Teams outgoing webhook: checks the signature (Authorization: HMAC ...),
  -- the tenant and the message's age, finds the person's APEX user and conversation, then starts
  -- the flow or replies to it. p_status: 200 (p_response is the Teams message), 401 (bad signature or
  -- too old), 403 (another tenant), 404 (no such webhook) or 400 (not a Teams message).
  -- It commits: each message is its own transaction.
  procedure handle (p_webhook_id    in  varchar2,
                    p_body          in  blob,
                    p_authorization in  varchar2,
                    p_status        out number,
                    p_response      out clob);

  -- The ORDS handler (21_fc_teams_ords.sql): HANDLE, then writes the HTTP response.
  procedure ords_handle (p_webhook_id in varchar2, p_body in blob, p_authorization in varchar2);

  -- Adds or changes a webhook. p_security_token is the token Teams shows once when you create the
  -- outgoing webhook. p_context: JSON passed to the flow as its start context.
  procedure add_webhook (p_webhook_id     in varchar2,
                         p_security_token in varchar2,
                         p_flow_id        in varchar2,
                         p_flow_version   in number   default null,
                         p_context        in clob     default null,
                         p_tenant_id      in varchar2 default null,
                         p_description    in varchar2 default null);

  -- Links a Teams account (its Microsoft Entra object id, shown to unknown users) to an APEX user.
  procedure map_user (p_aad_object_id in varchar2, p_app_user in varchar2, p_display_name in varchar2 default null);

  -- The text a person typed: the @mention and HTML removed, entities decoded, spaces collapsed.
  function clean_text (p_text in varchar2) return varchar2;
  -- Plain text (FC_CLIENT.RENDER) as Teams message HTML: escaped, one line per <br>.
  function to_html (p_text in clob) return clob;
  -- True when p_authorization is "HMAC " + base64(HMAC-SHA256(base64-decoded token, body)).
  function signature_ok (p_body in blob, p_authorization in varchar2, p_security_token in varchar2) return boolean;
end fc_teams;
/

create or replace package body fc_teams as

  c_help_hint constant varchar2(200) := 'Reply in this thread and mention me each time. HELP lists what you can say.';

  function str (p_obj in json_object_t, p_key in varchar2) return varchar2 is
  begin
    if p_obj is null or not p_obj.has(p_key) or p_obj.get(p_key).is_null then return null; end if;
    if p_obj.get(p_key).is_string then return p_obj.get_string(p_key); end if;
    return substr(p_obj.get(p_key).to_string, 1, 4000);
  end str;

  function ob (p_obj in json_object_t, p_key in varchar2) return json_object_t is
  begin
    if p_obj is not null and p_obj.has(p_key) and p_obj.get(p_key).is_object then return p_obj.get_object(p_key); end if;
    return null;
  end ob;

  function signature_ok (p_body in blob, p_authorization in varchar2, p_security_token in varchar2) return boolean is
    l_given    varchar2(400) := trim(p_authorization);
    l_expected varchar2(400);
    l_diff     pls_integer := 0;
  begin
    if p_body is null or p_security_token is null or l_given is null
       or upper(substr(l_given, 1, 5)) <> 'HMAC ' then
      return false;
    end if;
    l_given    := trim(substr(l_given, 6));
    l_expected := utl_raw.cast_to_varchar2(utl_encode.base64_encode(
                    dbms_crypto.mac(src => p_body,
                                    typ => dbms_crypto.hmac_sh256,
                                    key => utl_encode.base64_decode(utl_raw.cast_to_raw(p_security_token)))));
    l_expected := replace(replace(l_expected, chr(13)), chr(10));
    if length(l_given) <> length(l_expected) then return false; end if;
    for i in 1 .. length(l_expected) loop   -- compares every character, so the time taken reveals nothing
      if substr(l_given, i, 1) <> substr(l_expected, i, 1) then l_diff := l_diff + 1; end if;
    end loop;
    return l_diff = 0;
  end signature_ok;

  function clean_text (p_text in varchar2) return varchar2 is
    l varchar2(32767) := p_text;
  begin
    l := regexp_replace(l, '<at>.*?</at>', ' ', 1, 0, 'in');
    l := regexp_replace(l, '<[^>]*>', ' ');
    l := replace(l, '&nbsp;', ' ');
    l := replace(l, '&lt;', '<');
    l := replace(l, '&gt;', '>');
    l := replace(l, '&quot;', '"');
    l := replace(l, '&#39;', '''');
    l := replace(l, '&apos;', '''');
    l := replace(l, '&amp;', '&');
    l := regexp_replace(l, '\s+', ' ');
    return trim(l);
  end clean_text;

  function to_html (p_text in clob) return clob is
  begin
    if p_text is null then return null; end if;
    return replace(replace(replace(replace(replace(p_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
                           chr(13)), chr(10), '<br>');
  end to_html;

  function message (p_text in clob) return clob is
    l json_object_t := json_object_t();
  begin
    l.put('type', 'message');
    l.put('text', to_html(p_text));
    return l.to_clob;
  end message;

  function error_body (p_text in varchar2) return clob is
    l json_object_t := json_object_t();
  begin
    l.put('error', p_text);
    return l.to_clob;
  end error_body;

  -- Older than p_max seconds (Teams' timestamp is UTC, e.g. 2026-11-28T09:15:02.1234567Z).
  function too_old (p_timestamp in varchar2, p_max in number) return boolean is
    l_at   timestamp;
    l_diff interval day(9) to second(0);
  begin
    if p_timestamp is null or nvl(p_max, 0) <= 0 then return false; end if;
    l_at   := to_timestamp(substr(p_timestamp, 1, 19), 'YYYY-MM-DD"T"HH24:MI:SS');
    l_diff := sys_extract_utc(systimestamp) - l_at;
    return abs(extract(day from l_diff) * 86400 + extract(hour from l_diff) * 3600
               + extract(minute from l_diff) * 60 + extract(second from l_diff)) > p_max;
  exception when others then
    return true;   -- not a timestamp we can read
  end too_old;

  procedure log_error (p_webhook_id in varchar2, p_error in varchar2) is
    pragma autonomous_transaction;
  begin
    update fc_teams_webhooks
       set last_error = substr(p_error, 1, 4000), last_error_at = systimestamp
     where webhook_id = p_webhook_id;
    commit;
  end log_error;

  function app_user_for (p_hook in fc_teams_webhooks%rowtype, p_aad in varchar2, p_name in varchar2) return varchar2 is
    l_user varchar2(255);
  begin
    if p_hook.user_resolver is not null then
      execute immediate 'begin :u := ' || dbms_assert.qualified_sql_name(p_hook.user_resolver) || '(:a, :n); end;'
        using out l_user, in p_aad, in p_name;
      return l_user;
    end if;
    select app_user into l_user from fc_teams_users where aad_object_id = lower(p_aad) and enabled = 'Y';
    return l_user;
  exception when no_data_found then
    return null;
  end app_user_for;

  function session_alive (p_session_id in varchar2) return boolean is
    l_n pls_integer;
  begin
    if p_session_id is null then return false; end if;
    select count(*) into l_n from fc_sessions
     where session_id = p_session_id and status = 'in_progress'
       and (expires_at is null or expires_at > systimestamp);
    return l_n > 0;
  end session_alive;

  function help_text (p_active in boolean) return varchar2 is
  begin
    return case when p_active then
             'Answer the question, or reply with an option''s number.' || chr(10)
             || 'BACK goes to the previous question, RESTART starts over, STOP ends the conversation.' || chr(10)
             || 'In a list: ADD, DONE, EDIT n, REMOVE n. At the summary: CONFIRM or EDIT n.' || chr(10)
             || 'Mention me each time you reply.'
           else
             'Mention me in a thread to start. Each thread is its own conversation.'
           end;
  end help_text;

  procedure handle (p_webhook_id    in  varchar2,
                    p_body          in  blob,
                    p_authorization in  varchar2,
                    p_status        out number,
                    p_response      out clob) is
    l_hook    fc_teams_webhooks%rowtype;
    l_row     fc_teams_conversations%rowtype;
    l_act     json_object_t;
    l_from    json_object_t;
    l_conv    json_object_t;
    l_aad     varchar2(64);
    l_name    varchar2(400);
    l_conv_id varchar2(1000);
    l_act_id  varchar2(200);
    l_tenant  varchar2(100);
    l_user    varchar2(255);
    l_text    varchar2(32767);
    l_cmd     varchar2(100);
    l_has     boolean := false;
    l_active  boolean;
    l_out     clob;
    t         fc_client.t_turn;
  begin
    p_status := 200;
    begin
      select * into l_hook from fc_teams_webhooks where webhook_id = p_webhook_id and enabled = 'Y';
    exception when no_data_found then
      p_status := 404; p_response := error_body('There is no such webhook.'); return;
    end;
    if not signature_ok(p_body, p_authorization, l_hook.security_token) then
      p_status := 401; p_response := error_body('The signature is not valid.'); return;
    end if;

    begin
      l_act := json_object_t.parse(p_body);
    exception when others then
      p_status := 400; p_response := error_body('The body is not JSON.'); return;
    end;
    l_from    := ob(l_act, 'from');
    l_conv    := ob(l_act, 'conversation');
    l_aad     := substr(str(l_from, 'aadObjectId'), 1, 64);
    l_name    := substr(str(l_from, 'name'), 1, 400);
    l_conv_id := substr(str(l_conv, 'id'), 1, 1000);
    l_act_id  := substr(str(l_act, 'id'), 1, 200);
    l_tenant  := substr(coalesce(str(l_conv, 'tenantId'), str(ob(ob(l_act, 'channelData'), 'tenant'), 'id')), 1, 100);
    if l_aad is null or l_conv_id is null then
      p_status := 400; p_response := error_body('This is not a Teams message.'); return;
    end if;
    if l_hook.tenant_id is not null and nvl(lower(l_tenant), '-') <> lower(l_hook.tenant_id) then
      p_status := 403; p_response := error_body('This tenant is not allowed.'); return;
    end if;
    if too_old(str(l_act, 'timestamp'), l_hook.max_age_secs) then
      p_status := 401; p_response := error_body('The message is too old.'); return;
    end if;

    savepoint fc_teams_message;
    begin
      l_user := app_user_for(l_hook, l_aad, l_name);
      if l_user is null then
        p_response := message('I don''t know your Teams account yet. Please ask an administrator to link it to your user. '
                              || 'Your account id is ' || l_aad || '.');
        return;
      end if;

      begin
        select * into l_row from fc_teams_conversations
         where webhook_id = l_hook.webhook_id and conversation_id = l_conv_id and aad_object_id = l_aad
           for update;
        l_has := true;
      exception when no_data_found then
        l_has := false;
      end;
      -- Teams sent the same message again: answer as before, without answering the flow twice.
      if l_has and l_act_id is not null and l_row.last_activity_id = l_act_id then
        p_response := l_row.last_response;
        return;
      end if;

      l_text   := clean_text(str(l_act, 'text'));
      l_cmd    := lower(substr(l_text, 1, 100));
      l_active := l_has and l_row.status = 'active' and session_alive(l_row.session_id);

      if l_cmd in ('help', '?') then
        l_out := help_text(l_active);
      elsif l_cmd in ('stop', 'quit', 'exit') then
        if l_active then
          l_row.status := 'done';
          l_out := 'Okay, I stopped. Mention me again to start over.';
        else
          l_out := 'There''s nothing to stop. Mention me to start.';
        end if;
      elsif not l_active then
        t := fc_client.start_flow(l_hook.flow_id, l_hook.context, l_hook.flow_version, l_user);
        l_out := fc_client.render(t);
        if t.status = 'in_progress' then l_out := l_out || chr(10) || c_help_hint; end if;
      else
        t := fc_client.reply(fc_client.describe(l_row.last_turn), l_text, l_user);
        l_out := fc_client.render(t);
      end if;

      if t.session_id is not null then
        l_row.session_id := t.session_id;
        l_row.last_turn  := t.turn_json;
        if t.status = 'in_progress' then
          l_row.status := 'active';
          if t.secret then
            l_out := l_out || chr(10) || 'Careful: everyone in this channel can read your answer.';
          end if;
        else
          l_row.status := 'done';
          l_out := l_out || chr(10) || 'Mention me again to start over.';
        end if;
      end if;

      p_response := message(l_out);
      if l_has then
        update fc_teams_conversations
           set session_id = l_row.session_id, status = l_row.status, last_turn = l_row.last_turn,
               last_activity_id = l_act_id, last_response = p_response, updated_at = systimestamp
         where webhook_id = l_hook.webhook_id and conversation_id = l_conv_id and aad_object_id = l_aad;
      else
        insert into fc_teams_conversations (webhook_id, conversation_id, aad_object_id, session_id, status,
                                            last_turn, last_activity_id, last_response)
        values (l_hook.webhook_id, l_conv_id, l_aad, l_row.session_id, nvl(l_row.status, 'done'),
                l_row.last_turn, l_act_id, p_response);
      end if;
      commit;
    exception when others then
      rollback to fc_teams_message;
      log_error(l_hook.webhook_id, sqlerrm || chr(10) || dbms_utility.format_error_backtrace);
      p_status   := 200;
      p_response := message('Sorry, something went wrong. Please try again.');
    end;
  end handle;

  procedure ords_handle (p_webhook_id in varchar2, p_body in blob, p_authorization in varchar2) is
    l_status number;
    l_resp   clob;
    l_len    pls_integer;
    l_pos    pls_integer := 1;
  begin
    handle(p_webhook_id, p_body, p_authorization, l_status, l_resp);
    owa_util.status_line(l_status, null, false);
    owa_util.mime_header('application/json', false, 'utf-8');
    owa_util.http_header_close;
    l_len := nvl(dbms_lob.getlength(l_resp), 0);
    while l_pos <= l_len loop
      htp.prn(dbms_lob.substr(l_resp, 8000, l_pos));
      l_pos := l_pos + 8000;
    end loop;
  end ords_handle;

  procedure add_webhook (p_webhook_id     in varchar2,
                         p_security_token in varchar2,
                         p_flow_id        in varchar2,
                         p_flow_version   in number   default null,
                         p_context        in clob     default null,
                         p_tenant_id      in varchar2 default null,
                         p_description    in varchar2 default null) is
  begin
    merge into fc_teams_webhooks w
    using (select p_webhook_id webhook_id from dual) s
       on (w.webhook_id = s.webhook_id)
     when matched then update
          set security_token = p_security_token, flow_id = p_flow_id, flow_version = p_flow_version,
              context = p_context, tenant_id = p_tenant_id, description = p_description, enabled = 'Y'
     when not matched then insert (webhook_id, security_token, flow_id, flow_version, context, tenant_id, description)
          values (p_webhook_id, p_security_token, p_flow_id, p_flow_version, p_context, p_tenant_id, p_description);
  end add_webhook;

  procedure map_user (p_aad_object_id in varchar2, p_app_user in varchar2, p_display_name in varchar2 default null) is
  begin
    merge into fc_teams_users u
    using (select lower(p_aad_object_id) aad_object_id from dual) s
       on (u.aad_object_id = s.aad_object_id)
     when matched then update set app_user = p_app_user, display_name = nvl(p_display_name, u.display_name), enabled = 'Y'
     when not matched then insert (aad_object_id, app_user, display_name)
          values (s.aad_object_id, p_app_user, p_display_name);
  end map_user;

end fc_teams;
/
