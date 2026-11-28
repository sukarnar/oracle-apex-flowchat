-- FC_AUTOMATE: run flows in Teams through Power Automate and Adaptive Cards. Optional.
--
-- A Power Automate flow loops: it POSTs {flowId, user, sessionId, reply} to the endpoint
-- (24_fc_automate_ords.sql), posts the "card" it gets back to the person in a private chat with the
-- Flow bot ("Post adaptive card and wait for a response"), and sends the card's response ("data")
-- back as the next "reply", until "done" is true. Mirrors tools/flowchat-cards.js (tested in
-- tests/cards.test.js). The Power Automate steps are in the README.
--
--   FC_AUTOMATE_CLIENTS  one row per Power Automate flow (or group of flows) that may call the
--                        endpoint: the SHA-256 of its API key, the FlowChat flows it may run, and how
--                        a person's Microsoft 365 sign-in name (UPN, e.g. jane.doe@example.com)
--                        becomes the APEX user. Add rows with fc_automate.add_client.
--   FC_AUTOMATE_USERS    sign-in name -> APEX user, for clients with user_mode TABLE, and optionally the
--                        flows registered for that person (fc_automate.map_user). A sign-in name is a
--                        UPN (jane.doe@example.com) or, from the Windows client, DOMAIN\user.
--
-- The same API also serves the Windows desktop client (tools/windows-client): POST .../flows lists the
-- flows a person may run (fc_automate.list_flows).
--
-- Needs EXECUTE on SYS.DBMS_CRYPTO (already a FlowChat prerequisite). Safe to re-run: an older
-- FC_AUTOMATE_USERS gets the FLOWS column.
set define off

declare
  l_n pls_integer;
begin
  select count(*) into l_n from user_tables where table_name = 'FC_AUTOMATE_CLIENTS';
  if l_n = 0 then
    execute immediate q'[
      create table fc_automate_clients (
        client_id     varchar2(100)  not null,
        key_hash      varchar2(64)   not null,
        flows         varchar2(4000),
        default_flow  varchar2(100),
        user_mode     varchar2(10)   default 'TABLE' not null,
        user_resolver varchar2(400),
        description   varchar2(4000),
        enabled       varchar2(1)    default 'Y' not null,
        last_error    varchar2(4000),
        last_error_at timestamp with time zone,
        created_at    timestamp with time zone default systimestamp not null,
        constraint fc_automate_clients_pk primary key (client_id),
        constraint fc_automate_clients_key_uk unique (key_hash),
        constraint fc_automate_clients_um_ck check (user_mode in ('TABLE', 'UPN', 'LOCAL')),
        constraint fc_automate_clients_en_ck check (enabled in ('Y', 'N'))
      )]';
    execute immediate q'[comment on table fc_automate_clients is 'FlowChat: Power Automate flows that may run FlowChat flows (Adaptive Cards in Teams)']';
    execute immediate q'[comment on column fc_automate_clients.key_hash is 'SHA-256 (hex) of the API key sent in the X-FlowChat-Key header; the key itself is never stored']';
    execute immediate q'[comment on column fc_automate_clients.flows is 'Comma-separated flow ids this key may run; null = any flow']';
    execute immediate q'[comment on column fc_automate_clients.user_mode is 'TABLE: FC_AUTOMATE_USERS; UPN: the UPN in upper case; LOCAL: the part before the @ in upper case']';
    execute immediate q'[comment on column fc_automate_clients.user_resolver is 'Optional function (p_upn) return the APEX user; overrides user_mode']';
  end if;

  select count(*) into l_n from user_tables where table_name = 'FC_AUTOMATE_USERS';
  if l_n = 0 then
    execute immediate q'[
      create table fc_automate_users (
        upn        varchar2(320) not null,
        app_user   varchar2(255) not null,
        flows      varchar2(4000),
        enabled    varchar2(1)   default 'Y' not null,
        created_at timestamp with time zone default systimestamp not null,
        constraint fc_automate_users_pk primary key (upn),
        constraint fc_automate_users_en_ck check (enabled in ('Y', 'N'))
      )]';
    execute immediate q'[comment on table fc_automate_users is 'FlowChat: Microsoft 365 sign-in names (UPN, lower case) and the APEX user each one runs flows as']';
  end if;

  select count(*) into l_n from user_tab_columns where table_name = 'FC_AUTOMATE_USERS' and column_name = 'FLOWS';
  if l_n = 0 then
    execute immediate 'alter table fc_automate_users add (flows varchar2(4000))';
  end if;
  execute immediate q'[comment on column fc_automate_users.flows is 'Comma-separated flow ids registered for this person; null = every flow the client key allows']';
end;
/

create or replace package fc_automate authid definer as

  -- Handles one POST from Power Automate. p_api_key: the X-FlowChat-Key header. p_body:
  --   {"flowId": "it_helpdesk",            the flow to start (optional: the client's default flow)
  --    "user": "jane.doe@example.com",     the person (Power Automate's "User email" / UPN)
  --    "sessionId": "",                    empty to start; then the sessionId the last answer gave
  --    "reply": {...},                     the card's response ("data" of Post adaptive card and wait)
  --    "context": {...}}                   optional start context
  -- p_status: 200, 400 (not JSON / no flow), 401 (bad key) or 403 (a flow this key may not run, or
  -- someone else's conversation). p_response on 200:
  --   {sessionId, status, done, kind, appUser, text, card}
  -- "card" is the Adaptive Card to post; "done" is true when the flow finished (post "card" without
  -- waiting, then stop). It commits: each answer is its own transaction.
  procedure handle (p_api_key  in  varchar2,
                    p_body     in  clob,
                    p_status   out number,
                    p_response out clob);

  -- The ORDS handler (24_fc_automate_ords.sql): HANDLE, then writes the HTTP response.
  procedure ords_handle (p_api_key in varchar2, p_body in clob);

  -- Adds a client, or gives an existing one a new key. Returns the API key: it is shown only here,
  -- and only its SHA-256 is stored. p_flows: comma-separated flow ids, null = any.
  -- p_user_mode: TABLE (FC_AUTOMATE_USERS), UPN (jane.doe@example.com -> JANE.DOE@EXAMPLE.COM) or
  -- LOCAL (jane.doe@example.com -> JANE.DOE).
  function add_client (p_client_id    in varchar2,
                       p_flows        in varchar2 default null,
                       p_default_flow in varchar2 default null,
                       p_user_mode    in varchar2 default 'TABLE',
                       p_description  in varchar2 default null) return varchar2;

  -- Links a sign-in name (UPN / email, or DOMAIN\user from the Windows client) to an APEX user, for
  -- user_mode TABLE. p_flows: comma-separated flow ids registered for the person; null = every flow
  -- the client key allows. Calling it again replaces both.
  procedure map_user (p_upn in varchar2, p_app_user in varchar2, p_flows in varchar2 default null);

  -- Lists the published flows a person may run with this key (the client's flows, and in TABLE mode
  -- the person's registered flows). p_body: {"user": "jane.doe@example.com"}. p_status: 200, 400,
  -- 401 (bad key) or 403 (the person isn't linked). p_response on 200:
  --   {"user", "appUser", "defaultFlow", "flows": [{"flowId", "name", "description", "version"}]}
  procedure list_flows (p_api_key  in  varchar2,
                        p_body     in  clob,
                        p_status   out number,
                        p_response out clob);

  -- The ORDS handler for POST .../flowchat/automate/flows (24_fc_automate_ords.sql).
  procedure ords_list_flows (p_api_key in varchar2, p_body in clob);

  -- A FlowChat turn (FC_ENGINE's JSON) as an Adaptive Card (1.4).
  function build_card (p_turn_json in clob) return clob;
  -- A card's response ("data") as the engine's input, e.g. {"action":"answer","value":"Y"} -> {"value":"Y"}.
  function card_input (p_data in clob) return clob;
end fc_automate;
/

create or replace package body fc_automate as

  c_card_version constant varchar2(5) := '1.4';
  c_max_buttons  constant pls_integer := 5;

  function str (p_obj in json_object_t, p_key in varchar2) return varchar2 is
  begin
    if p_obj is null or not p_obj.has(p_key) or p_obj.get(p_key).is_null then return null; end if;
    if p_obj.get(p_key).is_string then return p_obj.get_string(p_key); end if;
    if p_obj.get(p_key).is_number then
      return to_char(p_obj.get_number(p_key), 'TM9', 'nls_numeric_characters=''.,''');
    end if;
    return substr(p_obj.get(p_key).to_string, 1, 32767);
  end str;

  function ob (p_obj in json_object_t, p_key in varchar2) return json_object_t is
  begin
    if p_obj is not null and p_obj.has(p_key) and p_obj.get(p_key).is_object then return p_obj.get_object(p_key); end if;
    return null;
  end ob;

  function arr (p_obj in json_object_t, p_key in varchar2) return json_array_t is
  begin
    if p_obj is not null and p_obj.has(p_key) and p_obj.get(p_key).is_array then return p_obj.get_array(p_key); end if;
    return json_array_t();
  end arr;

  function sha256 (p_text in varchar2) return varchar2 is
  begin
    return lower(rawtohex(dbms_crypto.hash(utl_i18n.string_to_raw(p_text, 'AL32UTF8'), dbms_crypto.hash_sh256)));
  end sha256;

  -- ==== Cards =======================================================================================

  function tb (p_text in varchar2, p_color in varchar2 default null, p_weight in varchar2 default null,
               p_size in varchar2 default null, p_subtle in boolean default false) return json_object_t is
    l json_object_t := json_object_t();
  begin
    l.put('type', 'TextBlock');
    l.put('text', p_text);
    l.put('wrap', true);
    if p_color  is not null then l.put('color', p_color); end if;
    if p_weight is not null then l.put('weight', p_weight); end if;
    if p_size   is not null then l.put('size', p_size); end if;
    if p_subtle then l.put('isSubtle', true); end if;
    return l;
  end tb;

  function submit (p_title in varchar2, p_action in varchar2, p_value in varchar2 default null,
                   p_no_inputs in boolean default false, p_has_value in boolean default false) return json_object_t is
    l json_object_t := json_object_t();
    d json_object_t := json_object_t();
  begin
    d.put('action', p_action);
    if p_has_value then d.put('value', p_value); end if;
    l.put('type', 'Action.Submit');
    l.put('title', p_title);
    l.put('data', d);
    if p_no_inputs then l.put('associatedInputs', 'none'); end if;
    return l;
  end submit;

  function choice (p_title in varchar2, p_value in varchar2) return json_object_t is
    l json_object_t := json_object_t();
  begin
    l.put('title', p_title);
    l.put('value', p_value);
    return l;
  end choice;

  function choice_set (p_id in varchar2, p_choices in json_array_t, p_style in varchar2 default null) return json_object_t is
    l json_object_t := json_object_t();
  begin
    l.put('type', 'Input.ChoiceSet');
    l.put('id', p_id);
    l.put('choices', p_choices);
    l.put('style', nvl(p_style, case when p_choices.get_size <= 8 then 'expanded' else 'compact' end));
    return l;
  end choice_set;

  procedure add_message (p_body in out nocopy json_array_t, p_m in json_object_t) is
    l_type  varchar2(30)  := str(p_m, 'type');
    l_text  varchar2(32767) := str(p_m, 'text');
    l_items json_array_t  := arr(p_m, 'items');
    l_it    json_object_t;
    l_facts json_array_t  := json_array_t();
    l_f     json_object_t;
    l_fs    json_object_t;
  begin
    if l_type = 'error' then
      if l_text is not null then p_body.append(tb(l_text, 'attention')); end if;
      return;
    elsif l_type = 'success' then
      if l_text is not null then p_body.append(tb(l_text, 'good', 'bolder')); end if;
      return;
    end if;
    if l_items.get_size = 0 then
      if l_text is not null then p_body.append(tb(l_text)); end if;
      return;
    end if;
    if l_text is not null then p_body.append(tb(l_text, null, 'bolder')); end if;
    for i in 0 .. l_items.get_size - 1 loop
      l_it := treat(l_items.get(i) as json_object_t);
      l_f  := json_object_t();
      if l_type = 'list' then
        l_f.put('title', (i + 1) || '.');
        l_f.put('value', nvl(str(l_it, 'title'), ' '));
      elsif l_type = 'changes' then
        l_f.put('title', nvl(str(l_it, 'label'), str(l_it, 'slot')));
        l_f.put('value', nvl(str(l_it, 'before'), '(empty)') || ' ' || unistr('\2192') || ' ' || nvl(str(l_it, 'after'), '(empty)'));
      else
        l_f.put('title', nvl(str(l_it, 'label'), str(l_it, 'slot')));
        l_f.put('value', nvl(str(l_it, 'display'), ' '));
      end if;
      l_facts.append(l_f);
    end loop;
    l_fs := json_object_t();
    l_fs.put('type', 'FactSet');
    l_fs.put('facts', l_facts);
    p_body.append(l_fs);
  end add_message;

  function card_object (p_turn_json in clob) return json_object_t is
    t       fc_client.t_turn := fc_client.describe(p_turn_json);
    l_turn  json_object_t    := json_object_t.parse(p_turn_json);
    l_aw    json_object_t    := ob(l_turn, 'await');
    l_inp   json_object_t;
    l_ms    json_array_t     := arr(l_turn, 'messages');
    l_card  json_object_t    := json_object_t();
    l_body  json_array_t     := json_array_t();
    l_acts  json_array_t     := json_array_t();
    l_in    json_object_t;
    l_ch    json_array_t;
    l_note  json_object_t;
    l_items json_array_t;
    l_ml    number;
    l_lock  varchar2(32767);
    c_req   constant varchar2(30) := 'Please answer this.';
  begin
    l_inp := ob(l_aw, 'input');
    if l_inp is null then l_inp := json_object_t(); end if;
    for i in 0 .. l_ms.get_size - 1 loop
      add_message(l_body, treat(l_ms.get(i) as json_object_t));
    end loop;
    if t.note is not null then
      l_note  := json_object_t();
      l_items := json_array_t();
      l_items.append(tb(case t.note_style when 'tip' then 'Tip: ' when 'warning' then 'Warning: ' else 'Note: ' end || t.note,
                        p_size => 'small'));
      l_note.put('type', 'Container');
      l_note.put('style', case t.note_style when 'tip' then 'good' when 'warning' then 'warning' else 'accent' end);
      l_note.put('items', l_items);
      l_body.append(l_note);
    end if;

    if nvl(t.status, '-') = 'in_progress' then
      if t.kind in ('text', 'email', 'code') then
        l_ml := null;
        if l_inp.has('maxLength') and l_inp.get('maxLength').is_number then l_ml := l_inp.get_number('maxLength'); end if;
        l_in := json_object_t();
        l_in.put('type', 'Input.Text');
        l_in.put('id', 'answer');
        if t.label is not null then l_in.put('label', t.label); end if;
        if t.kind = 'email' then l_in.put('style', 'email'); end if;
        l_in.put('isRequired', t.required);
        l_in.put('errorMessage', c_req);
        l_in.put('isMultiline', nvl(l_ml > 200, false));
        if l_ml is not null then l_in.put('maxLength', l_ml); end if;
        if str(l_inp, 'placeholder') is not null then l_in.put('placeholder', str(l_inp, 'placeholder')); end if;
        if t.value is not null and not t.secret then l_in.put('value', t.value); end if;
        l_body.append(l_in);
        l_acts.append(submit('Next', 'answer'));
        if t.kind = 'code' then l_acts.append(submit('Send a new code', 'resend', p_no_inputs => true)); end if;

      elsif t.kind = 'number' then
        l_in := json_object_t();
        l_in.put('type', 'Input.Number');
        l_in.put('id', 'answer');
        if t.label is not null then l_in.put('label', t.label); end if;
        l_in.put('isRequired', t.required);
        l_in.put('errorMessage', c_req);
        if l_inp.has('min') and l_inp.get('min').is_number then l_in.put('min', l_inp.get_number('min')); end if;
        if l_inp.has('max') and l_inp.get('max').is_number then l_in.put('max', l_inp.get_number('max')); end if;
        if l_aw.has('value') and l_aw.get('value').is_number then l_in.put('value', l_aw.get_number('value')); end if;
        l_body.append(l_in);
        l_acts.append(submit('Next', 'answer'));

      elsif t.kind = 'date' then
        l_in := json_object_t();
        l_in.put('type', 'Input.Date');
        l_in.put('id', 'answer');
        if t.label is not null then l_in.put('label', t.label); end if;
        l_in.put('isRequired', t.required);
        l_in.put('errorMessage', c_req);
        if t.value is not null then l_in.put('value', t.value); end if;
        l_body.append(l_in);
        l_acts.append(submit('Next', 'answer'));

      elsif t.kind in ('choice', 'yesno') then
        if t.options.count <= c_max_buttons then
          for i in 1 .. t.options.count loop
            l_acts.append(submit(t.options(i).label, 'answer', t.options(i).value, p_no_inputs => true, p_has_value => true));
          end loop;
        else
          l_ch := json_array_t();
          for i in 1 .. t.options.count loop l_ch.append(choice(t.options(i).label, t.options(i).value)); end loop;
          l_in := choice_set('answer', l_ch);
          if t.label is not null then l_in.put('label', t.label); end if;
          l_in.put('isRequired', true);
          l_in.put('errorMessage', 'Please choose one.');
          if t.value is not null then l_in.put('value', t.value); end if;
          l_body.append(l_in);
          l_acts.append(submit('Next', 'answer'));
        end if;

      elsif t.kind = 'pick' then
        l_ch := json_array_t();
        for i in 1 .. t.options.count loop
          l_ch.append(choice(t.options(i).label || case when t.options(i).detail is not null then ' (' || t.options(i).detail || ')' end,
                             t.options(i).value));
        end loop;
        l_in := choice_set('pick', l_ch);
        l_in.put('isRequired', true);
        l_in.put('errorMessage', 'Please choose one.');
        l_body.append(l_in);
        l_acts.append(submit('Open', 'pick'));
        if t.can_skip then l_acts.append(submit(t.none_label, 'none', p_no_inputs => true)); end if;

      elsif t.kind = 'list' then
        if t.options.count > 0 then
          l_ch := json_array_t();
          for i in 1 .. t.options.count loop l_ch.append(choice(t.options(i).label, t.options(i).value)); end loop;
          l_in := choice_set('item', l_ch, 'compact');
          l_in.put('placeholder', 'Choose an item to change or remove');
          l_body.append(l_in);
        end if;
        if t.can_add then l_acts.append(submit(t.add_label, 'add', p_no_inputs => true)); end if;
        if t.options.count > 0 and t.can_edit then l_acts.append(submit(t.edit_label, 'editItem')); end if;
        if t.options.count > 0 then l_acts.append(submit(t.remove_label, 'remove')); end if;
        if t.can_done then l_acts.append(submit(t.done_label, 'done', p_no_inputs => true)); end if;

      elsif t.kind = 'fields' then
        l_ch   := json_array_t();
        l_lock := null;
        for i in 1 .. t.options.count loop
          if t.options(i).enabled then
            l_ch.append(choice(t.options(i).label || case when t.options(i).detail is not null then ': ' || t.options(i).detail end,
                               t.options(i).value));
          elsif nvl(lengthb(l_lock), 0) < 30000 then
            l_lock := l_lock || case when l_lock is not null then chr(10) end
                      || t.options(i).label || ': ' || nvl(t.options(i).reason, 'can''t be changed now');
          end if;
        end loop;
        l_in := choice_set('field', l_ch);
        l_in.put('isRequired', true);
        l_in.put('errorMessage', 'Please choose what to change.');
        l_body.append(l_in);
        if l_lock is not null then l_body.append(tb(l_lock, p_size => 'small', p_subtle => true)); end if;
        l_acts.append(submit('Change', 'field'));
        l_acts.append(submit(t.done_label, 'done', p_no_inputs => true));

      elsif t.kind = 'summary' then
        l_acts.append(submit(t.confirm_label, 'answer', 'confirm', p_no_inputs => true, p_has_value => true));
        if t.options.count > 0 then
          l_ch := json_array_t();
          for i in 1 .. t.options.count loop l_ch.append(choice(t.options(i).label, t.options(i).value)); end loop;
          l_in := choice_set('editSlot', l_ch, 'compact');
          l_in.put('placeholder', 'Change an answer' || unistr('\2026'));
          l_in.put('isRequired', true);
          l_in.put('errorMessage', 'Choose the answer to change.');
          l_body.append(l_in);
          l_acts.append(submit('Change', 'edit'));
        end if;

      elsif t.kind = 'confirm' then
        l_acts.append(submit(t.confirm_label, 'confirm', p_no_inputs => true));
        l_acts.append(submit(t.cancel_label, 'cancel', p_no_inputs => true));

      else   -- a file, or anything a card can't ask
        l_body.append(tb('This step can''t be answered in Teams. Please finish it on the web page.', 'attention'));
      end if;
      if t.can_go_back then l_acts.append(submit('Back', 'back', p_no_inputs => true)); end if;
    end if;

    l_card.put('type', 'AdaptiveCard');
    l_card.put('$schema', 'http://adaptivecards.io/schemas/adaptive-card.json');
    l_card.put('version', c_card_version);
    l_card.put('body', l_body);
    l_card.put('actions', l_acts);
    return l_card;
  end card_object;

  function build_card (p_turn_json in clob) return clob is
  begin
    return card_object(p_turn_json).to_clob;
  end build_card;

  function input_object (p_data in json_object_t) return json_object_t is
    l    json_object_t := json_object_t();
    l_a  varchar2(100) := substr(str(p_data, 'action'), 1, 100);
  begin
    if l_a = 'answer' then
      if p_data.has('value') then l.put('value', nvl(str(p_data, 'value'), ''));
      else l.put('value', nvl(str(p_data, 'answer'), ''));
      end if;
    elsif l_a = 'skip' then
      l.put('value', '');
    elsif l_a in ('back', 'restart', 'add', 'done', 'confirm', 'cancel', 'resend') then
      l.put('command', l_a);
    elsif l_a in ('editItem', 'remove') then
      l.put('command', l_a);
      if regexp_like(str(p_data, 'item'), '^[0-9]{1,6}$') then l.put('index', to_number(str(p_data, 'item')));
      else l.put('index', -1);
      end if;
    elsif l_a = 'field' then
      l.put('field', nvl(str(p_data, 'field'), ''));
    elsif l_a = 'edit' then
      l.put('command', 'edit');
      l.put('slot', nvl(str(p_data, 'editSlot'), ''));
    elsif l_a = 'pick' then
      l.put('pick', nvl(str(p_data, 'pick'), ''));
    elsif l_a = 'none' then
      l.put_null('pick');
    else
      l.put('command', 'resume');
    end if;
    return l;
  end input_object;

  function card_input (p_data in clob) return clob is
    l_data json_object_t;
  begin
    begin
      l_data := json_object_t.parse(nvl(p_data, '{}'));
    exception when others then
      l_data := json_object_t();
    end;
    return input_object(l_data).to_clob;
  end card_input;

  -- ==== The endpoint ================================================================================

  procedure log_error (p_client_id in varchar2, p_error in varchar2) is
    pragma autonomous_transaction;
  begin
    update fc_automate_clients
       set last_error = substr(p_error, 1, 4000), last_error_at = systimestamp
     where client_id = p_client_id;
    commit;
  end log_error;

  function app_user_for (p_client in fc_automate_clients%rowtype, p_upn in varchar2) return varchar2 is
    l_upn  varchar2(320) := lower(trim(p_upn));
    l_user varchar2(255);
  begin
    if l_upn is null then return null; end if;
    if p_client.user_resolver is not null then
      execute immediate 'begin :u := ' || dbms_assert.qualified_sql_name(p_client.user_resolver) || '(:p); end;'
        using out l_user, in l_upn;
      return l_user;
    end if;
    if p_client.user_mode = 'UPN' then return upper(l_upn); end if;
    if p_client.user_mode = 'LOCAL' then
      -- DOMAIN\jdoe or jdoe@example.com -> JDOE
      return upper(regexp_substr(regexp_replace(l_upn, '^.*\\', ''), '^[^@]+'));
    end if;
    select app_user into l_user from fc_automate_users where upn = l_upn and enabled = 'Y';
    return l_user;
  exception when no_data_found then
    return null;
  end app_user_for;

  function in_list (p_list in varchar2, p_flow_id in varchar2) return boolean is
  begin
    return p_list is null
        or instr(',' || replace(lower(p_list), ' ') || ',', ',' || lower(p_flow_id) || ',') > 0;
  end in_list;

  function flow_allowed (p_client in fc_automate_clients%rowtype, p_flow_id in varchar2) return boolean is
  begin
    return in_list(p_client.flows, p_flow_id);
  end flow_allowed;

  -- The flows registered for the person (user_mode TABLE only); null = every flow the key allows.
  function user_flows (p_client in fc_automate_clients%rowtype, p_upn in varchar2) return varchar2 is
    l_flows fc_automate_users.flows%type;
    l_upn   varchar2(320) := lower(trim(p_upn));
  begin
    if p_client.user_resolver is not null or p_client.user_mode <> 'TABLE' then return null; end if;
    select flows into l_flows from fc_automate_users where upn = l_upn and enabled = 'Y';
    return l_flows;
  exception when no_data_found then
    return null;
  end user_flows;

  function error_body (p_text in varchar2) return clob is
    l json_object_t := json_object_t();
  begin
    l.put('error', p_text);
    return l.to_clob;
  end error_body;

  -- A finished conversation that only shows p_text (unknown person, ended conversation, an error).
  function done_with (p_text in varchar2) return clob is
    l   json_object_t := json_object_t();
    l_t json_object_t := json_object_t();
    l_m json_array_t  := json_array_t();
    l_e json_object_t := json_object_t();
  begin
    l_e.put('type', 'error');
    l_e.put('text', p_text);
    l_m.append(l_e);
    l_t.put('status', 'refused');
    l_t.put('messages', l_m);
    l.put_null('sessionId');
    l.put('status', 'refused');
    l.put('done', true);
    l.put('kind', 'none');
    l.put('text', p_text);
    l.put('card', card_object(l_t.to_clob));
    return l.to_clob;
  end done_with;

  function turn_body (p_turn in fc_client.t_turn, p_app_user in varchar2) return clob is
    l json_object_t := json_object_t();
  begin
    l.put('sessionId', p_turn.session_id);
    l.put('status', p_turn.status);
    l.put('done', nvl(p_turn.status, '-') <> 'in_progress');
    l.put('kind', p_turn.kind);
    l.put('appUser', p_app_user);
    l.put('text', fc_client.render(p_turn, false));
    l.put('card', card_object(p_turn.turn_json));
    return l.to_clob;
  end turn_body;

  procedure handle (p_api_key  in  varchar2,
                    p_body     in  clob,
                    p_status   out number,
                    p_response out clob) is
    l_client  fc_automate_clients%rowtype;
    l_b       json_object_t;
    l_user    varchar2(255);
    l_sid     varchar2(32);
    l_flow    varchar2(100);
    l_owner   varchar2(255);
    l_reply   json_object_t;
    l_ctx     clob;
    l_ctx_obj json_object_t;
    l_hash    varchar2(64);
    t         fc_client.t_turn;
  begin
    p_status := 200;
    if p_api_key is null then
      p_status := 401; p_response := error_body('The API key is not valid.'); return;
    end if;
    l_hash := sha256(p_api_key);   -- a private function can't be called inside SQL
    begin
      select * into l_client from fc_automate_clients
       where key_hash = l_hash and enabled = 'Y';
    exception when no_data_found then
      p_status := 401; p_response := error_body('The API key is not valid.'); return;
    end;
    begin
      l_b := json_object_t.parse(nvl(p_body, '{}'));
    exception when others then
      p_status := 400; p_response := error_body('The body is not JSON.'); return;
    end;

    savepoint fc_automate_turn;
    begin
      l_user := app_user_for(l_client, str(l_b, 'user'));
      if l_user is null then
        p_response := done_with('I don''t know your account yet. Please ask an administrator to link '
                                || nvl(substr(str(l_b, 'user'), 1, 320), 'it') || ' to your user.');
        return;
      end if;
      l_sid := substr(str(l_b, 'sessionId'), 1, 32);

      if l_sid is null then
        l_flow := substr(nvl(str(l_b, 'flowId'), l_client.default_flow), 1, 100);
        if l_flow is null then
          p_status := 400; p_response := error_body('No flowId.'); return;
        end if;
        if not flow_allowed(l_client, l_flow) then
          p_status := 403; p_response := error_body('This flow is not allowed for this key.'); return;
        end if;
        if not in_list(user_flows(l_client, str(l_b, 'user')), l_flow) then
          p_status := 403; p_response := error_body('This flow is not registered for your account.'); return;
        end if;
        l_ctx_obj := ob(l_b, 'context');
        if l_ctx_obj is not null then l_ctx := l_ctx_obj.to_clob; end if;
        t := fc_client.start_flow(l_flow, l_ctx, null, l_user);
      else
        begin
          select flow_id, app_user into l_flow, l_owner from fc_sessions where session_id = l_sid;
        exception when no_data_found then
          p_response := done_with('That conversation has ended. Please start again.');
          return;
        end;
        if upper(nvl(l_owner, '-')) <> upper(l_user) then
          p_status := 403; p_response := error_body('This conversation belongs to another user.'); return;
        end if;
        if not flow_allowed(l_client, l_flow) then
          p_status := 403; p_response := error_body('This flow is not allowed for this key.'); return;
        end if;
        if not in_list(user_flows(l_client, str(l_b, 'user')), l_flow) then
          p_status := 403; p_response := error_body('This flow is not registered for your account.'); return;
        end if;
        l_reply := ob(l_b, 'reply');
        if l_reply is null then l_reply := json_object_t(); end if;
        t := fc_client.send(l_sid, input_object(l_reply).to_clob, l_user);
      end if;

      p_response := turn_body(t, l_user);
      commit;
    exception when others then
      rollback to fc_automate_turn;
      log_error(l_client.client_id, sqlerrm || chr(10) || dbms_utility.format_error_backtrace);
      p_status   := 200;
      p_response := done_with('Sorry, something went wrong. Please try again.');
    end;
  end handle;

  procedure write_json (p_status in number, p_resp in clob) is
    l_len pls_integer := nvl(dbms_lob.getlength(p_resp), 0);
    l_pos pls_integer := 1;
  begin
    owa_util.status_line(p_status, null, false);
    owa_util.mime_header('application/json', false, 'utf-8');
    owa_util.http_header_close;
    while l_pos <= l_len loop
      htp.prn(dbms_lob.substr(p_resp, 8000, l_pos));
      l_pos := l_pos + 8000;
    end loop;
  end write_json;

  procedure ords_handle (p_api_key in varchar2, p_body in clob) is
    l_status number;
    l_resp   clob;
  begin
    handle(p_api_key, p_body, l_status, l_resp);
    write_json(l_status, l_resp);
  end ords_handle;

  procedure list_flows (p_api_key  in  varchar2,
                        p_body     in  clob,
                        p_status   out number,
                        p_response out clob) is
    l_client fc_automate_clients%rowtype;
    l_b      json_object_t;
    l_hash   varchar2(64);
    l_upn    varchar2(320);
    l_user   varchar2(255);
    l_uflows varchar2(4000);
    l_out    json_object_t := json_object_t();
    l_flows  json_array_t  := json_array_t();
    l_f      json_object_t;
  begin
    p_status := 200;
    if p_api_key is null then
      p_status := 401; p_response := error_body('The API key is not valid.'); return;
    end if;
    l_hash := sha256(p_api_key);   -- a private function can't be called inside SQL
    begin
      select * into l_client from fc_automate_clients where key_hash = l_hash and enabled = 'Y';
    exception when no_data_found then
      p_status := 401; p_response := error_body('The API key is not valid.'); return;
    end;
    begin
      l_b := json_object_t.parse(nvl(p_body, '{}'));
    exception when others then
      p_status := 400; p_response := error_body('The body is not JSON.'); return;
    end;

    l_upn  := lower(trim(substr(str(l_b, 'user'), 1, 320)));
    l_user := app_user_for(l_client, l_upn);
    if l_user is null then
      p_status := 403;
      p_response := error_body('Your account ' || nvl(l_upn, '(none)')
                               || ' is not linked to a FlowChat user. Ask an administrator to register it.');
      return;
    end if;
    l_uflows := user_flows(l_client, l_upn);

    for r in (select f.flow_id, nvl(f.name, f.flow_id) name, f.description, max(v.version) version
                from fc_flows f
                join fc_flow_versions v on v.flow_id = f.flow_id and v.status = 'PUBLISHED'
               group by f.flow_id, f.name, f.description
               order by lower(nvl(f.name, f.flow_id))) loop
      if flow_allowed(l_client, r.flow_id) and in_list(l_uflows, r.flow_id) then
        l_f := json_object_t();
        l_f.put('flowId', r.flow_id);
        l_f.put('name', r.name);
        l_f.put('description', r.description);
        l_f.put('version', r.version);
        l_flows.append(l_f);
      end if;
    end loop;

    l_out.put('user', l_upn);
    l_out.put('appUser', l_user);
    if l_client.default_flow is not null and flow_allowed(l_client, l_client.default_flow)
       and in_list(l_uflows, l_client.default_flow) then
      l_out.put('defaultFlow', l_client.default_flow);
    else
      l_out.put_null('defaultFlow');
    end if;
    l_out.put('flows', l_flows);
    p_response := l_out.to_clob;
  exception when others then
    log_error(l_client.client_id, sqlerrm || chr(10) || dbms_utility.format_error_backtrace);
    p_status := 500;
    p_response := error_body('Sorry, the flows could not be listed.');
  end list_flows;

  procedure ords_list_flows (p_api_key in varchar2, p_body in clob) is
    l_status number;
    l_resp   clob;
  begin
    list_flows(p_api_key, p_body, l_status, l_resp);
    write_json(l_status, l_resp);
  end ords_list_flows;

  function add_client (p_client_id    in varchar2,
                       p_flows        in varchar2 default null,
                       p_default_flow in varchar2 default null,
                       p_user_mode    in varchar2 default 'TABLE',
                       p_description  in varchar2 default null) return varchar2 is
    l_key  varchar2(100) := 'fck_' || lower(rawtohex(dbms_crypto.randombytes(24)));
    l_hash varchar2(64)  := sha256(l_key);   -- a private function can't be called inside SQL
  begin
    merge into fc_automate_clients c
    using (select p_client_id client_id from dual) s
       on (c.client_id = s.client_id)
     when matched then update
          set key_hash = l_hash, flows = p_flows, default_flow = p_default_flow,
              user_mode = upper(p_user_mode), description = p_description, enabled = 'Y'
     when not matched then insert (client_id, key_hash, flows, default_flow, user_mode, description)
          values (p_client_id, l_hash, p_flows, p_default_flow, upper(p_user_mode), p_description);
    return l_key;
  end add_client;

  procedure map_user (p_upn in varchar2, p_app_user in varchar2, p_flows in varchar2 default null) is
    l_flows varchar2(4000) := replace(trim(p_flows), ' ');
  begin
    merge into fc_automate_users u
    using (select lower(trim(p_upn)) upn from dual) s
       on (u.upn = s.upn)
     when matched then update set app_user = p_app_user, flows = l_flows, enabled = 'Y'
     when not matched then insert (upn, app_user, flows) values (s.upn, p_app_user, l_flows);
  end map_user;

end fc_automate;
/
