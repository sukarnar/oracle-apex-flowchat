-- FC_CLIENT: run a flow from PL/SQL with every answer given up front (batch mode), for scheduler jobs,
-- imports from other systems and regression tests. It drives FC_ENGINE exactly like the widget does,
-- so the flow's checks, connectors, lookups, emails and workflows all run as in a conversation.
-- Mirrors FlowChatEngine.runBatch in widget/flowchat-engine.js (tested in tests/batch.test.js).
-- Also turn by turn (START_FLOW, REPLY, RENDER ...): a chat channel, a Forms screen or a test drives
-- a conversation one answer at a time, without the widget (tests/turns.test.js).
--
-- Security: RUN can act as any user (p_app_user), and connectors trust appUser. Grant EXECUTE on
-- FC_CLIENT only to schemas that are allowed to do that. FC_ENGINE's set_app_user / session_slots are
-- ACCESSIBLE BY (package fc_client), so nothing else can call them.
set define off

create or replace package fc_client authid definer as

  type t_result is record (
    status     varchar2(20),    -- completed | failed | refused | needs_input
    session_id varchar2(32),
    node_id    varchar2(200),   -- the step it stopped at (refused / needs_input)
    slot       varchar2(200),   -- the field it stopped at, e.g. "clr_level" or "destinations.country"
    question   varchar2(4000),  -- needs_input: the question that has no answer
    error      varchar2(4000),  -- refused: the engine's message; failed: why
    slots      clob,            -- {slot: value, ...}: the answers and the values connectors returned
    transcript clob,            -- [{from: bot|user, type, text}, ...]
    turns      pls_integer);

  -- Runs flow p_flow_id, answering each question from p_answers (JSON):
  --   "slot": value          an Ask or a Menu with a slot; a choice by its value or its label;
  --                          yes/no as Y/N, yes/no or true/false; dates as YYYY-MM-DD
  --   "nodeId": value        a Menu without a slot, a record pick (title text or 1-based number),
  --                          a bulk update ("confirm" / "cancel")
  --   "list": [{...}, ...]   a Repeat: one object per item, keyed by the item's fields
  --   "changeNodeId": {...}  a Change fields step: {field: new value, ...}
  -- A question with no answer stops the run with needs_input (an optional one is skipped). An answer
  -- the flow refuses stops it with refused and the flow's message. Summaries are confirmed.
  --
  -- p_app_user         the signed-in user to run as when there is no APEX session (e.g. in a job);
  --                    null = the APEX session's user, else the database user.
  -- p_confirm          false: stop at a summary or bulk update (needs_input) instead of confirming.
  -- p_lists            'replace' (a list given in p_answers replaces items already there, e.g. loaded
  --                    by a lookup) or 'append' (adds to them).
  -- p_undo_incomplete  true: a run that doesn't complete is rolled back to where it started, so it
  --                    leaves nothing behind (its FC_SESSIONS and FC_EVENTS rows included). The result
  --                    still has the transcript. false: keep it (e.g. to look at FC_EVENTS).
  -- RUN never commits: commit after it, so a batch can be one transaction.
  function run (p_flow_id         in varchar2,
                p_answers         in clob,
                p_context         in clob        default null,
                p_version         in number      default null,
                p_app_user        in varchar2    default null,
                p_confirm         in boolean     default true,
                p_lists           in varchar2    default 'replace',
                p_max_turns       in pls_integer default 200,
                p_undo_incomplete in boolean     default true) return t_result;

  -- The result as JSON: {status, sessionId, nodeId, slot, question, error, slots, transcript, turns}.
  function to_json (p_result in t_result) return clob;

  -- Prints the result and the transcript with DBMS_OUTPUT (SQL*Plus, SQLcl, SQL Workshop).
  procedure put_result (p_result in t_result);

  -- =================================================================================================
  -- Turn by turn: drive a conversation one answer at a time without the widget, e.g. from a chat
  -- channel (Teams, Slack, SMS, email), an Oracle Forms screen or a test. Mirrors describeTurn,
  -- renderTurn and replyInput in widget/flowchat-engine.js (tested in tests/turns.test.js).
  --
  --   t := fc_client.start_flow('trip_booking', p_app_user => 'JDOE');
  --   while t.status = 'in_progress' loop
  --     send_to_channel(fc_client.render(t));
  --     t := fc_client.reply(t, wait_for_reply);   -- "2", "Berlin", "back", "edit 1", "done", "confirm"
  --   end loop;
  --
  -- Every call returns the next turn. Like FC_ENGINE they never commit: commit after each call when
  -- the next one may come from another database session (a REST handler, a job, the next request).
  -- p_app_user: who the conversation runs as. START_FLOW stores it on the session; later calls run as
  -- that user when p_app_user is null, and a different user is refused (ORA-20060).

  type t_option is record (
    value   varchar2(4000),       -- what to send back: a choice's value, a record's token, an item's
                                  -- index (lists), a field name (fields), a slot (summary)
    label   varchar2(4000),
    detail  varchar2(4000),       -- a record's subtitle, a field's current value, a summary answer
    enabled boolean := true,      -- fields: false when it can't be changed now (reason says why)
    reason  varchar2(4000),
    changed boolean := false);    -- fields: changed since the record was loaded or the item opened
  type t_options is table of t_option index by pls_integer;      -- 1, 2, 3 ... as rendered

  type t_message is record (
    msg_type varchar2(30),        -- text | error | success | summary | changes | record | list
    text     varchar2(32767),
    body     varchar2(32767));    -- the items of a summary, record or list as plain text lines
  type t_messages is table of t_message index by pls_integer;

  type t_turn is record (
    session_id     varchar2(32),
    flow_id        varchar2(200),
    version        number,
    status         varchar2(30),     -- in_progress | completed | failed | ...
    kind           varchar2(30),     -- what is asked: text | email | number | date | choice | yesno | file | code |
                                     -- pick | list | fields | summary | confirm | none (finished)
    node_id        varchar2(200),
    slot           varchar2(200),    -- e.g. "travel_type" or "destinations.city"
    label          varchar2(4000),
    question       varchar2(32767),  -- the last thing the bot said (else the label)
    value          varchar2(32767),  -- the current answer when it's asked again (null for hidden ones)
    required       boolean := false,
    can_skip       boolean := false, -- an optional question, or a record pick with "None of these"
    secret         boolean := false, -- a hidden answer or a one-time code: don't echo or log it
    item           pls_integer,      -- the list item being added or changed (1-based)
    note           varchar2(4000),   -- an information note shown with the question
    note_style     varchar2(20),     -- info | tip | warning
    options        t_options,
    messages       t_messages,
    error          varchar2(4000),   -- the answer just sent was refused: why
    can_go_back    boolean := false,
    can_add        boolean := false, -- lists
    can_done       boolean := false,
    can_edit       boolean := false,
    add_label      varchar2(400),
    done_label     varchar2(400),
    edit_label     varchar2(400),
    remove_label   varchar2(400),
    confirm_label  varchar2(400),
    cancel_label   varchar2(400),
    none_label     varchar2(400),
    progress_done  pls_integer,
    progress_total pls_integer,
    turn_json      clob);            -- the engine's turn, unchanged

  function start_flow (p_flow_id  in varchar2,
                       p_context  in clob     default null,
                       p_version  in number   default null,
                       p_app_user in varchar2 default null) return t_turn;

  -- The conversation where it stands ("Welcome back..." and the question again), e.g. after a pause.
  function current_turn (p_session_id in varchar2, p_app_user in varchar2 default null) return t_turn;

  -- A typed reply, read the way a person means it:
  --   any step     back, restart (or "start over")
  --   choice/yesno the option's number, value or label
  --   pick         the record's number, NONE, or text matching its title
  --   list         ADD, DONE, EDIT n, REMOVE n (n as listed)
  --   fields       the field's number, or DONE
  --   summary      CONFIRM, or EDIT n (n as in the hint)
  --   confirm      CONFIRM / YES, CANCEL / NO
  --   code         the code, or RESEND
  --   other        the answer; SKIP leaves an optional one empty
  -- With the turn the reply answers, or with the session id (then CURRENT_TURN is read first).
  function reply (p_turn in t_turn, p_text in varchar2, p_app_user in varchar2 default null) return t_turn;
  function reply (p_session_id in varchar2, p_text in varchar2, p_app_user in varchar2 default null) return t_turn;

  -- One step, explicitly. Items are numbered from 1.
  function answer       (p_session_id in varchar2, p_value in varchar2, p_app_user in varchar2 default null) return t_turn;
  function pick         (p_session_id in varchar2, p_token in varchar2, p_app_user in varchar2 default null) return t_turn;  -- null: none of these
  function back         (p_session_id in varchar2, p_app_user in varchar2 default null) return t_turn;
  function restart      (p_session_id in varchar2, p_app_user in varchar2 default null) return t_turn;
  function edit         (p_session_id in varchar2, p_slot in varchar2, p_app_user in varchar2 default null) return t_turn;
  function add_item     (p_session_id in varchar2, p_app_user in varchar2 default null) return t_turn;
  function edit_item    (p_session_id in varchar2, p_item in pls_integer, p_app_user in varchar2 default null) return t_turn;
  function remove_item  (p_session_id in varchar2, p_item in pls_integer, p_app_user in varchar2 default null) return t_turn;
  function change_field (p_session_id in varchar2, p_field in varchar2, p_app_user in varchar2 default null) return t_turn;
  function done         (p_session_id in varchar2, p_app_user in varchar2 default null) return t_turn;
  function confirm      (p_session_id in varchar2, p_app_user in varchar2 default null) return t_turn;
  function cancel       (p_session_id in varchar2, p_app_user in varchar2 default null) return t_turn;
  function resend_code  (p_session_id in varchar2, p_app_user in varchar2 default null) return t_turn;
  -- Any input of the turn protocol, as JSON (e.g. {"command":"editItem","index":0}).
  function send         (p_session_id in varchar2, p_input in clob, p_app_user in varchar2 default null) return t_turn;

  -- A turn's JSON (from FC_ENGINE) as a T_TURN.
  function describe (p_turn_json in clob) return t_turn;
  -- The turn as plain text: the messages, the note, numbered options and (p_hints) what to reply.
  function render (p_turn in t_turn, p_hints in boolean default true) return clob;
  -- Prints RENDER with DBMS_OUTPUT.
  procedure put_turn (p_turn in t_turn, p_hints in boolean default true);
end fc_client;
/

create or replace package body fc_client as

  function s (p_obj in json_object_t, p_key in varchar2) return varchar2 is
    l_el json_element_t;
  begin
    if p_obj is null or p_key is null or not p_obj.has(p_key) then return null; end if;
    l_el := p_obj.get(p_key);
    if l_el is null or l_el.is_null then return null;
    elsif l_el.is_string then return p_obj.get_string(p_key);
    elsif l_el.is_true then return 'true';
    elsif l_el.is_false then return 'false';
    elsif l_el.is_number then return to_char(p_obj.get_number(p_key), 'TM9', 'nls_numeric_characters=''.,''');
    else return substr(l_el.to_string, 1, 32767);
    end if;
  end s;

  function run (p_flow_id         in varchar2,
                p_answers         in clob,
                p_context         in clob        default null,
                p_version         in number      default null,
                p_app_user        in varchar2    default null,
                p_confirm         in boolean     default true,
                p_lists           in varchar2    default 'replace',
                p_max_turns       in pls_integer default 200,
                p_undo_incomplete in boolean     default true) return t_result is
    l_ans      json_object_t;
    l_turn     json_object_t;
    l_aw       json_object_t;
    l_input    json_object_t;
    l_sid      varchar2(32);
    l_trans    json_array_t  := json_array_t();
    l_turns    pls_integer   := 0;
    l_max      pls_integer   := nvl(p_max_turns, 200);
    l_append   boolean       := lower(nvl(p_lists, 'replace')) = 'append';
    l_pending  varchar2(1000);
    l_pos      json_object_t := json_object_t();   -- list slot -> index of the item being added
    l_done     json_object_t := json_object_t();   -- list slot -> true once all its items are in
    l_changed  json_object_t := json_object_t();   -- Change fields node -> {field: true} already sent
    l_chval    json_element_t;                     -- the value for the Change fields field just picked
    l_has_ch   boolean       := false;
    l_type     varchar2(30);
    l_slot     varchar2(200);
    l_node     varchar2(200);
    l_list     varchar2(200);
    l_field    varchar2(200);
    l_dot      pls_integer;
    l_n        pls_integer;
    l_val      json_element_t;
    l_item     json_object_t;
    l_given    json_array_t;
    l_ch       json_object_t;
    l_sent     json_object_t;
    l_keys     json_key_list;
    l_next     varchar2(200);
    l_res      t_result;

    function txt (p_el in json_element_t) return varchar2 is
      l json_object_t := json_object_t();
    begin
      if p_el is null then return null; end if;
      l.put('v', p_el);
      return s(l, 'v');
    end txt;

    function has_ans (p_key in varchar2) return boolean is
    begin
      return p_key is not null and l_ans.has(p_key);
    end has_ans;

    function key_of (p_aw in json_object_t) return varchar2 is
    begin
      if p_aw is null then return null; end if;
      return s(p_aw, 'type') || '|' || s(p_aw, 'nodeId') || '|' || s(p_aw, 'slot');
    end key_of;

    function messages return json_array_t is
    begin
      if l_turn is not null and l_turn.has('messages') and l_turn.get('messages').is_array then
        return l_turn.get_array('messages');
      end if;
      return json_array_t();
    end messages;

    function last_of (p_type in varchar2) return varchar2 is
      l_ms json_array_t := messages;
      l_m  json_object_t;
    begin
      for i in reverse 0 .. l_ms.get_size - 1 loop
        l_m := treat(l_ms.get(i) as json_object_t);
        if s(l_m, 'type') = p_type and s(l_m, 'text') is not null then return s(l_m, 'text'); end if;
      end loop;
      return null;
    end last_of;

    function has_error return boolean is
      l_ms json_array_t := messages;
    begin
      for i in 0 .. l_ms.get_size - 1 loop
        if s(treat(l_ms.get(i) as json_object_t), 'type') = 'error' then return true; end if;
      end loop;
      return false;
    end has_error;

    procedure log_turn is
      l_ms json_array_t := messages;
      l_m  json_object_t;
      l_e  json_object_t;
    begin
      for i in 0 .. l_ms.get_size - 1 loop
        l_m := treat(l_ms.get(i) as json_object_t);
        l_e := json_object_t();
        l_e.put('from', 'bot');
        l_e.put('type', s(l_m, 'type'));
        l_e.put('text', nvl(s(l_m, 'text'), ''));
        l_trans.append(l_e);
      end loop;
    end log_turn;

    procedure send (p_in in json_object_t, p_shown in varchar2) is
      l_e json_object_t := json_object_t();
    begin
      l_e.put('from', 'user');
      l_e.put('type', 'answer');
      l_e.put('text', nvl(p_shown, ''));
      l_trans.append(l_e);
      l_turns := l_turns + 1;
      l_turn := json_object_t.parse(fc_engine.handle_input(l_sid, p_in.to_clob));
      log_turn;
    end send;

    procedure send_value (p_val in json_element_t) is
      l_in json_object_t := json_object_t();
    begin
      if p_val is null or p_val.is_null then
        l_in.put('value', '');
      elsif p_val.is_object or p_val.is_array then
        l_in.put('value', p_val.to_string);
      else
        l_in.put('value', p_val);
      end if;
      send(l_in, txt(p_val));
    end send_value;

    procedure send_cmd (p_cmd in varchar2, p_shown in varchar2, p_index in pls_integer default null) is
      l_in json_object_t := json_object_t();
    begin
      l_in.put('command', p_cmd);
      if p_index is not null then l_in.put('index', p_index); end if;
      send(l_in, p_shown);
    end send_cmd;

    procedure send_field (p_field in varchar2) is
      l_in json_object_t := json_object_t();
    begin
      l_in.put('field', p_field);
      send(l_in, 'Change ' || p_field);
    end send_field;

    function item_count return pls_integer is
    begin
      if l_aw.has('items') and l_aw.get('items').is_array then return l_aw.get_array('items').get_size; end if;
      return 0;
    end item_count;

    function first_title return varchar2 is
    begin
      return s(treat(l_aw.get_array('items').get(0) as json_object_t), 'title');
    end first_title;

    function finish (p_status in varchar2, p_error in varchar2 default null) return t_result is
      r t_result;
    begin
      r.status     := p_status;
      r.session_id := l_sid;
      r.error      := substr(p_error, 1, 4000);
      r.turns      := l_turns;
      if l_aw is not null then
        r.node_id := s(l_aw, 'nodeId');
        r.slot    := s(l_aw, 'slot');
      end if;
      if p_status = 'needs_input' then r.question := substr(last_of('text'), 1, 4000); end if;
      if l_sid is not null then r.slots := fc_engine.session_slots(l_sid); end if;
      r.transcript := l_trans.to_clob;
      return r;
    end finish;

  begin
    if p_answers is null then l_ans := json_object_t(); else l_ans := json_object_t.parse(p_answers); end if;
    savepoint fc_client_run;
    fc_engine.set_app_user(p_app_user);
    begin
      l_turn := json_object_t.parse(fc_engine.start_session(p_flow_id, p_context, p_version));
      l_sid  := s(l_turn, 'sessionId');
      log_turn;

      loop
        l_aw := null;
        if l_turn.has('await') and l_turn.get('await').is_object then l_aw := l_turn.get_object('await'); end if;

        if nvl(s(l_turn, 'status'), '-') <> 'in_progress' then
          if s(l_turn, 'status') = 'completed' then
            l_res := finish('completed');
          else
            l_res := finish('failed', nvl(last_of('error'), 'The flow failed.'));
          end if;
          exit;
        end if;
        if l_aw is null then
          l_res := finish('failed', 'The flow is waiting but asks nothing.');
          exit;
        end if;
        -- The same question again, with an error, right after an answer: the answer was refused.
        if l_pending is not null and key_of(l_aw) = l_pending and has_error then
          l_res := finish('refused', last_of('error'));
          exit;
        end if;
        if l_turns >= l_max then
          l_res := finish('failed', 'Stopped after ' || l_max || ' turns.');
          exit;
        end if;

        l_pending := key_of(l_aw);
        l_type    := s(l_aw, 'type');
        l_slot    := s(l_aw, 'slot');
        l_node    := s(l_aw, 'nodeId');
        l_dot     := nvl(instr(l_slot, '.'), 0);
        l_list    := null;
        if l_dot > 1 then l_list := substr(l_slot, 1, l_dot - 1); end if;
        l_input   := null;
        if l_aw.has('input') and l_aw.get('input').is_object then l_input := l_aw.get_object('input'); end if;

        if l_type = 'ask' then
          if l_slot = '#code' or s(l_input, 'kind') = 'file' then
            l_res := finish('needs_input', 'This step can''t be answered in batch mode.');
            exit;
          end if;
          l_val := null;
          if s(l_aw, 'sub') = 'true' and l_has_ch then
            -- a field of a Change fields step
            l_val := l_chval;
            l_has_ch := false;
          elsif l_list is not null and l_ans.has(l_list) and l_ans.get(l_list).is_array then
            -- a field of a list item; a required list starts its first item by itself
            if not l_pos.has(l_list) then l_pos.put(l_list, 0); end if;
            l_n     := l_pos.get_number(l_list);
            l_field := substr(l_slot, l_dot + 1);
            l_given := l_ans.get_array(l_list);
            l_item  := json_object_t();
            if l_n < l_given.get_size and l_given.get(l_n).is_object then
              l_item := treat(l_given.get(l_n) as json_object_t);
            end if;
            if l_item.has(l_field) then
              l_val := l_item.get(l_field);
            elsif s(l_input, 'required') = 'false' then
              l_val := null;
            else
              l_res := finish('needs_input', 'Item ' || (l_n + 1) || ' of "' || l_list || '" has no "' || l_field || '".');
              exit;
            end if;
          elsif l_slot is not null and substr(l_slot, 1, 1) <> '#' and l_ans.has(l_slot) then
            l_val := l_ans.get(l_slot);
          elsif has_ans(l_node) then
            l_val := l_ans.get(l_node);
          elsif s(l_input, 'required') = 'false' and nvl(s(l_aw, 'menu'), 'false') <> 'true' then
            l_val := null;
          else
            l_res := finish('needs_input');
            exit;
          end if;
          send_value(l_val);

        elsif l_type = 'summary' then
          if not nvl(p_confirm, true) then
            l_res := finish('needs_input');
            exit;
          end if;
          send_value(json_element_t.parse('"confirm"'));

        elsif l_type = 'listMenu' then
          l_given := null;
          if l_slot is not null and l_ans.has(l_slot) and l_ans.get(l_slot).is_array then
            l_given := l_ans.get_array(l_slot);
          end if;
          if l_given is null or l_done.has(l_slot) then
            if nvl(s(l_aw, 'canDone'), 'false') <> 'true' then
              l_res := finish('needs_input', 'The list needs more items.');
              exit;
            end if;
            send_cmd('done', nvl(s(l_aw, 'doneLabel'), 'Done'));
          elsif not l_pos.has(l_slot) and not l_append and item_count > 0 then
            send_cmd('remove', 'Remove ' || first_title, 0);   -- replace: clear what is there first
          else
            if l_pos.has(l_slot) then l_pos.put(l_slot, l_pos.get_number(l_slot) + 1); else l_pos.put(l_slot, 0); end if;
            if l_pos.get_number(l_slot) < l_given.get_size then
              send_cmd('add', nvl(s(l_aw, 'addLabel'), 'Add'));
            else
              l_done.put(l_slot, true);
              send_cmd('done', nvl(s(l_aw, 'doneLabel'), 'Done'));
            end if;
          end if;

        elsif l_type = 'fieldMenu' then
          l_ch := null;
          if has_ans(l_node) and l_ans.get(l_node).is_object then l_ch := l_ans.get_object(l_node); end if;
          if not l_changed.has(l_node) then l_changed.put(l_node, json_object_t()); end if;
          l_sent := l_changed.get_object(l_node);
          l_next := null;
          if l_ch is not null then
            l_keys := l_ch.get_keys;
            if l_keys is not null then
              for i in 1 .. l_keys.count loop
                if not l_sent.has(l_keys(i)) then
                  l_next := l_keys(i);
                  exit;
                end if;
              end loop;
            end if;
          end if;
          if l_next is null then
            send_cmd('done', nvl(s(l_aw, 'doneLabel'), 'Done'));
          else
            l_sent.put(l_next, true);
            l_changed.put(l_node, l_sent);
            l_chval  := l_ch.get(l_next);
            l_has_ch := true;
            send_field(l_next);
          end if;

        elsif l_type = 'pick' then
          if not has_ans(l_node) then
            l_res := finish('needs_input');
            exit;
          end if;
          send_value(l_ans.get(l_node));   -- a record's title text, or its 1-based number

        elsif l_type = 'confirm' then
          if has_ans(l_node) and lower(s(l_ans, l_node)) = 'cancel' then
            send_cmd('cancel', 'Cancel');
          elsif nvl(p_confirm, true) or has_ans(l_node) then
            send_cmd('confirm', nvl(s(l_aw, 'confirmLabel'), 'Confirm'));
          else
            l_res := finish('needs_input');
            exit;
          end if;

        else
          l_res := finish('needs_input', 'Batch mode can''t answer a "' || l_type || '" step.');
          exit;
        end if;
      end loop;
    exception when others then
      l_res.status     := 'failed';
      l_res.session_id := l_sid;
      l_res.error      := substr(sqlerrm, 1, 4000);
      l_res.turns      := l_turns;
      l_res.transcript := l_trans.to_clob;
    end;

    if l_res.status <> 'completed' and nvl(p_undo_incomplete, true) then
      begin
        rollback to fc_client_run;
      exception when others then
        -- ORA-01086: a connector committed during the run, so there is nothing left to undo.
        if sqlcode <> -1086 then raise; end if;
      end;
    end if;
    fc_engine.set_app_user(null);
    return l_res;
  exception when others then
    fc_engine.set_app_user(null);
    raise;
  end run;

  function to_json (p_result in t_result) return clob is
    l json_object_t := json_object_t();
  begin
    l.put('status', p_result.status);
    l.put('sessionId', p_result.session_id);
    l.put('nodeId', p_result.node_id);
    l.put('slot', p_result.slot);
    l.put('question', p_result.question);
    l.put('error', p_result.error);
    if p_result.slots is not null then l.put('slots', json_object_t.parse(p_result.slots)); else l.put_null('slots'); end if;
    if p_result.transcript is not null then l.put('transcript', json_array_t.parse(p_result.transcript)); else l.put_null('transcript'); end if;
    l.put('turns', p_result.turns);
    return l.to_clob;
  end to_json;

  procedure put_result (p_result in t_result) is
    l_t json_array_t;
    l_m json_object_t;
  begin
    dbms_output.put_line('Status: ' || p_result.status || ' after ' || p_result.turns || ' answers');
    if p_result.node_id is not null and p_result.status <> 'completed' then
      dbms_output.put_line('Stopped at: ' || p_result.node_id || case when p_result.slot is not null then ' (' || p_result.slot || ')' end);
    end if;
    if p_result.question is not null then dbms_output.put_line('Question: ' || p_result.question); end if;
    if p_result.error is not null then dbms_output.put_line('Error: ' || p_result.error); end if;
    if p_result.transcript is not null then
      l_t := json_array_t.parse(p_result.transcript);
      for i in 0 .. l_t.get_size - 1 loop
        l_m := treat(l_t.get(i) as json_object_t);
        dbms_output.put_line(case s(l_m, 'from') when 'user' then '  > ' else '    ' end || substr(s(l_m, 'text'), 1, 32000));
      end loop;
    end if;
  end put_result;

  -- ==== Turn by turn ================================================================================

  function b (p_obj in json_object_t, p_key in varchar2) return boolean is
  begin
    return nvl(s(p_obj, p_key) = 'true', false);
  end b;

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

  function num (p_text in varchar2) return number is
  begin
    return to_number(p_text, '999999999999D999999', 'nls_numeric_characters=''.,''');
  exception when others then
    return null;
  end num;

  -- p_a || p_sep || p_b, kept within a varchar2.
  function cat (p_a in varchar2, p_b in varchar2, p_sep in varchar2 default chr(10)) return varchar2 is
  begin
    if p_b is null then return p_a; end if;
    if p_a is null then return substrb(p_b, 1, 32767); end if;
    if lengthb(p_a) + lengthb(p_sep) + lengthb(p_b) > 32767 then return p_a; end if;
    return p_a || p_sep || p_b;
  end cat;

  -- The items of a summary, changes, record or list message as plain text lines.
  function message_body (p_m in json_object_t) return varchar2 is
    l_items json_array_t := arr(p_m, 'items');
    l_type  varchar2(30) := s(p_m, 'type');
    l_it    json_object_t;
    l_out   varchar2(32767);
    l_line  varchar2(32767);
  begin
    for i in 0 .. l_items.get_size - 1 loop
      l_it := treat(l_items.get(i) as json_object_t);
      if l_type = 'list' then
        l_line := (i + 1) || '. ' || substr(s(l_it, 'title'), 1, 4000);
      elsif l_type = 'changes' then
        l_line := '- ' || substr(nvl(s(l_it, 'label'), s(l_it, 'slot')), 1, 4000) || ': '
               || substr(nvl(s(l_it, 'before'), '(empty)'), 1, 4000) || ' -> ' || substr(nvl(s(l_it, 'after'), '(empty)'), 1, 4000);
      else
        l_line := '- ' || substr(nvl(s(l_it, 'label'), s(l_it, 'slot')), 1, 4000) || ': ' || substr(s(l_it, 'display'), 1, 4000);
      end if;
      l_out := cat(l_out, l_line);
    end loop;
    return l_out;
  end message_body;

  function describe (p_turn_json in clob) return t_turn is
    t      t_turn;
    l_turn json_object_t;
    l_aw   json_object_t;
    l_in   json_object_t;
    l_nt   json_object_t;
    l_pr   json_object_t;
    l_ms   json_array_t;
    l_its  json_array_t;
    l_m    json_object_t;
    l_it   json_object_t;
    l_type varchar2(30);
    l_msg  t_message;

    procedure opt (p_value in varchar2, p_label in varchar2, p_detail in varchar2 default null,
                   p_enabled in boolean default true, p_reason in varchar2 default null,
                   p_changed in boolean default false) is
      o t_option;
    begin
      o.value   := substr(p_value, 1, 4000);
      o.label   := substr(nvl(p_label, p_value), 1, 4000);
      o.detail  := substr(p_detail, 1, 4000);
      o.enabled := nvl(p_enabled, true);
      o.reason  := substr(p_reason, 1, 4000);
      o.changed := nvl(p_changed, false);
      t.options(t.options.count + 1) := o;
    end opt;
  begin
    t.turn_json := p_turn_json;
    t.kind      := 'none';
    if p_turn_json is null then return t; end if;
    l_turn := json_object_t.parse(p_turn_json);
    t.session_id  := s(l_turn, 'sessionId');
    t.flow_id     := s(l_turn, 'flowId');
    t.version     := num(s(l_turn, 'version'));
    t.status      := s(l_turn, 'status');
    t.can_go_back := b(l_turn, 'canGoBack');
    l_pr := ob(l_turn, 'progress');
    if l_pr is not null then
      t.progress_done  := num(s(l_pr, 'done'));
      t.progress_total := num(s(l_pr, 'total'));
    end if;

    l_ms := arr(l_turn, 'messages');
    for i in 0 .. l_ms.get_size - 1 loop
      l_m := treat(l_ms.get(i) as json_object_t);
      l_msg.msg_type := nvl(s(l_m, 'type'), 'text');
      l_msg.text     := s(l_m, 'text');
      l_msg.body     := message_body(l_m);
      t.messages(t.messages.count + 1) := l_msg;
      if s(l_m, 'type') = 'error' and s(l_m, 'text') is not null then t.error := substr(s(l_m, 'text'), 1, 4000); end if;
      if s(l_m, 'type') = 'text' and s(l_m, 'text') is not null then t.question := s(l_m, 'text'); end if;
    end loop;

    l_aw := ob(l_turn, 'await');
    if l_aw is null then return t; end if;
    t.node_id := s(l_aw, 'nodeId');
    t.slot    := s(l_aw, 'slot');
    t.item    := num(s(l_aw, 'item'));
    l_type    := s(l_aw, 'type');

    if l_type = 'ask' then
      l_in := ob(l_aw, 'input');
      if l_in is null then l_in := json_object_t(); end if;
      if t.slot = '#code' then t.kind := 'code';
      elsif b(l_aw, 'menu') then t.kind := 'choice';
      else t.kind := nvl(s(l_in, 'kind'), 'text');
      end if;
      t.label    := substr(nvl(s(l_aw, 'label'), t.slot), 1, 4000);
      t.value    := s(l_aw, 'value');
      t.required := b(l_aw, 'menu') or nvl(s(l_in, 'required'), 'true') <> 'false';
      t.can_skip := not t.required;
      t.secret   := nvl(s(l_aw, 'redact'), 'false') <> 'false' or b(l_aw, 'secret');
      l_nt := ob(l_aw, 'note');
      if l_nt is not null then
        t.note       := substr(s(l_nt, 'text'), 1, 4000);
        t.note_style := nvl(s(l_nt, 'style'), 'info');
      end if;
      if t.kind = 'yesno' then
        opt('Y', 'Yes');
        opt('N', 'No');
      else
        l_its := arr(l_in, 'options');
        for i in 0 .. l_its.get_size - 1 loop
          l_it := treat(l_its.get(i) as json_object_t);
          opt(s(l_it, 'value'), s(l_it, 'label'));
        end loop;
      end if;

    elsif l_type = 'pick' then
      t.kind       := 'pick';
      t.can_skip   := nvl(s(l_aw, 'allowNone'), 'true') <> 'false';
      t.none_label := substr(nvl(s(l_aw, 'noneLabel'), 'None of these'), 1, 400);
      l_its := arr(l_aw, 'items');
      for i in 0 .. l_its.get_size - 1 loop
        l_it := treat(l_its.get(i) as json_object_t);
        opt(s(l_it, 'token'), s(l_it, 'title'), s(l_it, 'subtitle'));
      end loop;

    elsif l_type = 'listMenu' then
      t.kind         := 'list';
      t.can_add      := b(l_aw, 'canAdd');
      t.can_done     := b(l_aw, 'canDone');
      t.can_edit     := b(l_aw, 'canEdit');
      t.add_label    := substr(nvl(s(l_aw, 'addLabel'), 'Add'), 1, 400);
      t.done_label   := substr(nvl(s(l_aw, 'doneLabel'), 'Done'), 1, 400);
      t.edit_label   := substr(nvl(s(l_aw, 'editLabel'), 'Edit'), 1, 400);
      t.remove_label := substr(nvl(s(l_aw, 'removeLabel'), 'Remove'), 1, 400);
      l_its := arr(l_aw, 'items');
      for i in 0 .. l_its.get_size - 1 loop
        l_it := treat(l_its.get(i) as json_object_t);
        opt(s(l_it, 'index'), s(l_it, 'title'));
      end loop;

    elsif l_type = 'fieldMenu' then
      t.kind       := 'fields';
      t.done_label := substr(nvl(s(l_aw, 'doneLabel'), 'Done'), 1, 400);
      t.label      := substr(s(l_aw, 'title'), 1, 4000);
      l_its := arr(l_aw, 'fields');
      for i in 0 .. l_its.get_size - 1 loop
        l_it := treat(l_its.get(i) as json_object_t);
        opt(s(l_it, 'field'), s(l_it, 'label'), s(l_it, 'display'),
            nvl(s(l_it, 'editable'), 'true') <> 'false', s(l_it, 'reason'), b(l_it, 'changed'));
      end loop;

    elsif l_type = 'summary' then
      t.kind          := 'summary';
      t.confirm_label := substr(nvl(s(l_aw, 'confirmLabel'), 'Confirm'), 1, 400);
      -- The answers it shows that can be changed (from its summary or changes message), in order.
      for i in 0 .. l_ms.get_size - 1 loop
        l_m := treat(l_ms.get(i) as json_object_t);
        if s(l_m, 'type') in ('summary', 'changes') then
          t.options.delete;
          l_its := arr(l_m, 'items');
          for j in 0 .. l_its.get_size - 1 loop
            l_it := treat(l_its.get(j) as json_object_t);
            if nvl(s(l_it, 'editable'), 'true') <> 'false' then
              if s(l_m, 'type') = 'changes' then
                opt(s(l_it, 'slot'), nvl(s(l_it, 'label'), s(l_it, 'slot')), s(l_it, 'after'));
              else
                opt(s(l_it, 'slot'), nvl(s(l_it, 'label'), s(l_it, 'slot')), s(l_it, 'display'));
              end if;
            end if;
          end loop;
        end if;
      end loop;

    elsif l_type = 'confirm' then
      t.kind          := 'confirm';
      t.confirm_label := substr(nvl(s(l_aw, 'confirmLabel'), 'Confirm'), 1, 400);
      t.cancel_label  := substr(nvl(s(l_aw, 'cancelLabel'), 'Cancel'), 1, 400);

    else
      t.kind := l_type;
    end if;

    if t.question is null then t.question := t.label; end if;
    return t;
  end describe;

  function render (p_turn in t_turn, p_hints in boolean default true) return clob is
    l_out   clob;
    l_shown boolean := false;
    l_opts  varchar2(32767);
    l_h     varchar2(32767);
    l_parts varchar2(4000);
    l_kind  varchar2(30) := p_turn.kind;
    l_cnt   pls_integer  := p_turn.options.count;

    procedure line (p_text in varchar2) is
    begin
      if p_text is null then return; end if;
      if l_out is null then l_out := p_text; else l_out := l_out || chr(10) || p_text; end if;
    end line;
  begin
    for i in 1 .. p_turn.messages.count loop
      line(p_turn.messages(i).text);
      line(p_turn.messages(i).body);
      if p_turn.messages(i).msg_type = 'list' then l_shown := true; end if;
    end loop;

    if p_turn.note is not null then
      line(case p_turn.note_style when 'tip' then 'Tip: ' when 'warning' then 'Warning: ' else 'Note: ' end || p_turn.note);
    end if;

    if l_kind in ('choice', 'yesno', 'pick', 'fields') or (l_kind = 'list' and not l_shown) then
      for i in 1 .. l_cnt loop
        l_opts := cat(l_opts, i || '. ' || p_turn.options(i).label
                      || case when p_turn.options(i).detail is not null then ' (' || p_turn.options(i).detail || ')' end
                      || case when not p_turn.options(i).enabled then ' [locked]' end);
      end loop;
      line(l_opts);
    end if;

    if nvl(p_hints, true) and p_turn.status = 'in_progress' then
      if l_kind in ('text', 'email', 'number') then
        if p_turn.can_skip then l_h := 'Reply SKIP to leave it empty.'; end if;
      elsif l_kind = 'date' then
        l_h := 'Reply with a date (YYYY-MM-DD).' || case when p_turn.can_skip then ' SKIP leaves it empty.' end;
      elsif l_kind in ('choice', 'yesno') then
        l_h := 'Reply with a number.';
      elsif l_kind = 'code' then
        l_h := 'Reply with the code, or RESEND for a new one.';
      elsif l_kind = 'pick' then
        l_h := 'Reply with a number' || case when p_turn.can_skip then ', or NONE.' else '.' end;
      elsif l_kind = 'list' then
        if p_turn.can_add then l_parts := cat(l_parts, 'ADD', ', '); end if;
        if p_turn.can_edit and l_cnt > 0 then l_parts := cat(l_parts, 'EDIT n', ', '); end if;
        if l_cnt > 0 then l_parts := cat(l_parts, 'REMOVE n', ', '); end if;
        if p_turn.can_done then l_parts := cat(l_parts, 'DONE', ', '); end if;
        l_h := 'Reply ' || l_parts || '.';
      elsif l_kind = 'fields' then
        l_h := 'Reply with a number to change it, or DONE.';
      elsif l_kind = 'summary' then
        l_h := 'Reply CONFIRM';
        if l_cnt > 0 then
          l_parts := null;
          for i in 1 .. l_cnt loop
            l_parts := cat(l_parts, substr(i || '. ' || p_turn.options(i).label, 1, 200), ', ');
          end loop;
          l_h := l_h || ', or EDIT n to change ' || l_parts;
        end if;
        l_h := l_h || '.';
      elsif l_kind = 'confirm' then
        l_h := 'Reply CONFIRM or CANCEL.';
      elsif l_kind = 'file' then
        l_h := 'A file can''t be sent here.';
      end if;
      if p_turn.can_go_back then l_h := cat(l_h, 'BACK goes back.', ' '); end if;
      line(l_h);
    end if;
    return l_out;
  end render;

  procedure put_turn (p_turn in t_turn, p_hints in boolean default true) is
    l_text clob := render(p_turn, p_hints);
    l_pos  pls_integer := 1;
    l_nl   pls_integer;
  begin
    if l_text is null then return; end if;
    loop
      l_nl := dbms_lob.instr(l_text, chr(10), l_pos);
      if l_nl = 0 then
        dbms_output.put_line(dbms_lob.substr(l_text, 32000, l_pos));
        exit;
      end if;
      dbms_output.put_line(dbms_lob.substr(l_text, least(l_nl - l_pos, 32000), l_pos));
      l_pos := l_nl + 1;
    end loop;
  end put_turn;

  -- A typed reply as the input the engine expects (replyInput in flowchat-engine.js).
  function reply_input (p_turn in t_turn, p_text in varchar2) return json_object_t is
    l_s    varchar2(32767) := regexp_replace(p_text, '^\s+|\s+$', '');
    l_l    varchar2(32767) := lower(regexp_replace(p_text, '^\s+|\s+$', ''));
    l_cnt  pls_integer     := p_turn.options.count;
    l_n    pls_integer;
    l_k    pls_integer;
    l_w    varchar2(400);
    l_in   json_object_t   := json_object_t();

    function matches (p_label in varchar2) return boolean is
    begin
      return p_label is not null and l_l = lower(p_label);
    end matches;

    function cmd (p_cmd in varchar2) return json_object_t is
      l json_object_t := json_object_t();
    begin
      l.put('command', p_cmd);
      return l;
    end cmd;

    function val return json_object_t is
      l json_object_t := json_object_t();
    begin
      l.put('value', l_s);
      return l;
    end val;
  begin
    if regexp_like(l_l, '^[0-9]{1,6}$') then l_n := to_number(l_l); end if;
    if l_l = 'back' then return cmd('back'); end if;
    if l_l in ('restart', 'start over') then return cmd('restart'); end if;

    if p_turn.kind = 'code' then
      if l_l = 'resend' then return cmd('resend'); end if;
      return val;

    elsif p_turn.kind in ('choice', 'yesno') then
      for i in 1 .. l_cnt loop
        if matches(p_turn.options(i).value) or matches(p_turn.options(i).label) then return val; end if;
      end loop;
      if l_n between 1 and l_cnt then
        l_in.put('value', p_turn.options(l_n).value);
        return l_in;
      end if;
      return val;

    elsif p_turn.kind = 'pick' then
      if p_turn.can_skip and (l_l = 'none' or matches(p_turn.none_label)) then
        l_in.put_null('pick');
        return l_in;
      end if;
      if l_n between 1 and l_cnt then
        l_in.put('pick', p_turn.options(l_n).value);
        return l_in;
      end if;
      return val;

    elsif p_turn.kind = 'list' then
      if l_l = 'add' or matches(p_turn.add_label) then return cmd('add'); end if;
      if l_l = 'done' or matches(p_turn.done_label) then return cmd('done'); end if;
      if regexp_like(l_l, '^\S+\s+[0-9]{1,6}$') then
        l_w := substr(regexp_substr(l_l, '^\S+'), 1, 400);
        l_k := to_number(regexp_substr(l_l, '[0-9]+$')) - 1;
        if l_w in ('edit', 'change') or l_w = lower(p_turn.edit_label) then
          l_in := cmd('editItem');
          l_in.put('index', l_k);
          return l_in;
        end if;
        if l_w in ('remove', 'delete') or l_w = lower(p_turn.remove_label) then
          l_in := cmd('remove');
          l_in.put('index', l_k);
          return l_in;
        end if;
      end if;
      return val;

    elsif p_turn.kind = 'fields' then
      if l_l in ('done', 'save') or matches(p_turn.done_label) then return cmd('done'); end if;
      if l_n between 1 and l_cnt then
        l_in.put('field', p_turn.options(l_n).value);
        return l_in;
      end if;
      return val;

    elsif p_turn.kind = 'summary' then
      if regexp_like(l_l, '^(edit|change)\s+[0-9]{1,6}$') then
        l_k := to_number(regexp_substr(l_l, '[0-9]+$'));
        if l_k between 1 and l_cnt then
          l_in := cmd('edit');
          l_in.put('slot', p_turn.options(l_k).value);
          return l_in;
        end if;
      end if;
      return val;

    elsif p_turn.kind = 'confirm' then
      if l_l in ('confirm', 'yes', 'y', 'ok') or matches(p_turn.confirm_label) then return cmd('confirm'); end if;
      if l_l in ('cancel', 'no', 'n') or matches(p_turn.cancel_label) then return cmd('cancel'); end if;
      return val;
    end if;

    if p_turn.can_skip and l_l = 'skip' then
      l_in.put('value', '');
      return l_in;
    end if;
    return val;
  end reply_input;

  -- Sends one input as the conversation's user (see the spec: p_app_user).
  function call_engine (p_session_id in varchar2, p_in in json_object_t, p_app_user in varchar2) return t_turn is
    l_owner fc_sessions.app_user%type;
    l_turn  clob;
  begin
    begin
      select app_user into l_owner from fc_sessions where session_id = p_session_id;
    exception when no_data_found then
      l_owner := null;   -- the engine says the conversation is gone
    end;
    if p_app_user is not null and l_owner is not null and upper(p_app_user) <> upper(l_owner) then
      raise_application_error(-20060, 'This conversation belongs to another user.');
    end if;
    fc_engine.set_app_user(coalesce(p_app_user, l_owner));
    l_turn := fc_engine.handle_input(p_session_id, p_in.to_clob);
    fc_engine.set_app_user(null);
    return describe(l_turn);
  exception when others then
    fc_engine.set_app_user(null);
    raise;
  end call_engine;

  function command_turn (p_session_id in varchar2, p_cmd in varchar2, p_app_user in varchar2,
                         p_index in pls_integer default null) return t_turn is
    l json_object_t := json_object_t();
  begin
    l.put('command', p_cmd);
    if p_index is not null then l.put('index', p_index); end if;
    return call_engine(p_session_id, l, p_app_user);
  end command_turn;

  function start_flow (p_flow_id  in varchar2,
                       p_context  in clob     default null,
                       p_version  in number   default null,
                       p_app_user in varchar2 default null) return t_turn is
    l_turn clob;
  begin
    fc_engine.set_app_user(p_app_user);
    l_turn := fc_engine.start_session(p_flow_id, p_context, p_version);
    fc_engine.set_app_user(null);
    return describe(l_turn);
  exception when others then
    fc_engine.set_app_user(null);
    raise;
  end start_flow;

  function current_turn (p_session_id in varchar2, p_app_user in varchar2 default null) return t_turn is
  begin
    return command_turn(p_session_id, 'resume', p_app_user);
  end current_turn;

  function reply (p_turn in t_turn, p_text in varchar2, p_app_user in varchar2 default null) return t_turn is
  begin
    return call_engine(p_turn.session_id, reply_input(p_turn, p_text), p_app_user);
  end reply;

  function reply (p_session_id in varchar2, p_text in varchar2, p_app_user in varchar2 default null) return t_turn is
  begin
    return reply(current_turn(p_session_id, p_app_user), p_text, p_app_user);
  end reply;

  function answer (p_session_id in varchar2, p_value in varchar2, p_app_user in varchar2 default null) return t_turn is
    l json_object_t := json_object_t();
  begin
    l.put('value', p_value);
    return call_engine(p_session_id, l, p_app_user);
  end answer;

  function pick (p_session_id in varchar2, p_token in varchar2, p_app_user in varchar2 default null) return t_turn is
    l json_object_t := json_object_t();
  begin
    if p_token is null then l.put_null('pick'); else l.put('pick', p_token); end if;
    return call_engine(p_session_id, l, p_app_user);
  end pick;

  function back (p_session_id in varchar2, p_app_user in varchar2 default null) return t_turn is
  begin
    return command_turn(p_session_id, 'back', p_app_user);
  end back;

  function restart (p_session_id in varchar2, p_app_user in varchar2 default null) return t_turn is
  begin
    return command_turn(p_session_id, 'restart', p_app_user);
  end restart;

  function edit (p_session_id in varchar2, p_slot in varchar2, p_app_user in varchar2 default null) return t_turn is
    l json_object_t := json_object_t();
  begin
    l.put('command', 'edit');
    l.put('slot', p_slot);
    return call_engine(p_session_id, l, p_app_user);
  end edit;

  function add_item (p_session_id in varchar2, p_app_user in varchar2 default null) return t_turn is
  begin
    return command_turn(p_session_id, 'add', p_app_user);
  end add_item;

  function edit_item (p_session_id in varchar2, p_item in pls_integer, p_app_user in varchar2 default null) return t_turn is
  begin
    return command_turn(p_session_id, 'editItem', p_app_user, p_item - 1);
  end edit_item;

  function remove_item (p_session_id in varchar2, p_item in pls_integer, p_app_user in varchar2 default null) return t_turn is
  begin
    return command_turn(p_session_id, 'remove', p_app_user, p_item - 1);
  end remove_item;

  function change_field (p_session_id in varchar2, p_field in varchar2, p_app_user in varchar2 default null) return t_turn is
    l json_object_t := json_object_t();
  begin
    l.put('field', p_field);
    return call_engine(p_session_id, l, p_app_user);
  end change_field;

  function done (p_session_id in varchar2, p_app_user in varchar2 default null) return t_turn is
  begin
    return command_turn(p_session_id, 'done', p_app_user);
  end done;

  function confirm (p_session_id in varchar2, p_app_user in varchar2 default null) return t_turn is
  begin
    return command_turn(p_session_id, 'confirm', p_app_user);
  end confirm;

  function cancel (p_session_id in varchar2, p_app_user in varchar2 default null) return t_turn is
  begin
    return command_turn(p_session_id, 'cancel', p_app_user);
  end cancel;

  function resend_code (p_session_id in varchar2, p_app_user in varchar2 default null) return t_turn is
  begin
    return command_turn(p_session_id, 'resend', p_app_user);
  end resend_code;

  function send (p_session_id in varchar2, p_input in clob, p_app_user in varchar2 default null) return t_turn is
  begin
    return call_engine(p_session_id, json_object_t.parse(p_input), p_app_user);
  end send;

end fc_client;
/
