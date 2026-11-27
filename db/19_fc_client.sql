-- FC_CLIENT: run a flow from PL/SQL with every answer given up front (batch mode), for scheduler jobs,
-- imports from other systems and regression tests. It drives FC_ENGINE exactly like the widget does,
-- so the flow's checks, connectors, lookups, emails and workflows all run as in a conversation.
-- Mirrors FlowChatEngine.runBatch in widget/flowchat-engine.js (tested in tests/batch.test.js).
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

end fc_client;
/
