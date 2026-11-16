create or replace package body fc_engine as

  c_max_steps  constant pls_integer := 200;
  c_required   constant varchar2(100) := 'This one is required. Please provide a value.';
  c_not_found  constant varchar2(100) := 'I couldn''t find a matching record.';
  c_ttl        constant interval day to second := interval '1' day;
  c_nls        constant varchar2(40) := 'NLS_NUMERIC_CHARACTERS=''.,''';

  type t_ctx is record (
    session_id    varchar2(32),
    flow          json_object_t,
    nodes         json_object_t,   -- node id -> node
    slot_nodes    json_object_t,   -- slot    -> id of the first ask node capturing it
    change_nodes  json_object_t,   -- record alias -> id of its changeFields node
    state         json_object_t,
    slots         json_object_t,
    records       json_object_t,   -- alias -> {source, key, version, original{}, current{}}  (server-side only)
    results       json_object_t,   -- findRecord node id -> [{token, key, title, subtitle}]    (server-side only)
    history       json_array_t,
    out_msgs      json_array_t,
    updates       json_array_t,    -- slots / alias.field changed during this turn
    replay        boolean,
    force_ask     varchar2(200),
    repeat_slots  json_object_t    -- slot -> id of the Repeat node that collects it
  );

  -- Lookup list options fetched during this request: "<list>|<params json>" -> [{value, label}].
  -- Reset on every request, so lists are always current.
  g_lov_cache json_object_t;

  -- Debug logging: set_debug(true) logs every conversation of this database session;
  -- a flow with "debug": true logs its own. g_dbg_sid = the conversation being logged in this request.
  g_debug   boolean := false;
  g_dbg_sid varchar2(32);

  function field_def (p_change_node in json_object_t, p_field in varchar2) return json_object_t;   -- forward

  ------------------------------------------------------------------------------
  -- scalar helpers
  ------------------------------------------------------------------------------
  function num_str (p in number) return varchar2 is
    l varchar2(100);
  begin
    if p is null then return null; end if;
    l := to_char(p, 'TM9', c_nls);
    if l like '.%' then l := '0' || l;
    elsif l like '-.%' then l := '-0' || substr(l, 2);
    end if;
    return l;
  end num_str;

  function to_num (p in varchar2) return number is
  begin
    if p is null or not regexp_like(p, '^-?[0-9]+(\.[0-9]+)?$') then return null; end if;
    return to_number(p, '999999999999999999999999999.99999999999');
  exception when others then return null;
  end to_num;

  function fmt_num (p in number) return varchar2 is
  begin
    if p is null then return null; end if;
    if p = trunc(p) then return to_char(p, 'FM999G999G999G999G990', c_nls); end if;
    return rtrim(to_char(p, 'FM999G999G999G999G990D00', c_nls), '0');
  end fmt_num;

  -- Any JSON scalar member as text (numbers in canonical '.' format), null if absent.
  function str (p_obj in json_object_t, p_key in varchar2) return varchar2 is
    l_el json_element_t;
  begin
    if p_obj is null or p_key is null or not p_obj.has(p_key) then return null; end if;
    l_el := p_obj.get(p_key);
    if l_el is null or l_el.is_null then return null;
    elsif l_el.is_string then return p_obj.get_string(p_key);
    elsif l_el.is_number then return num_str(p_obj.get_number(p_key));
    elsif l_el.is_true then return 'true';
    elsif l_el.is_false then return 'false';
    else return l_el.to_string;
    end if;
  end str;

  function el_str (p_el in json_element_t) return varchar2 is
    l json_object_t := json_object_t();
  begin
    if p_el is null then return null; end if;
    l.put('v', p_el);
    return str(l, 'v');
  end el_str;

  function obj (p_obj in json_object_t, p_key in varchar2) return json_object_t is
  begin
    if p_obj is null or not p_obj.has(p_key) or not p_obj.get(p_key).is_object then return null; end if;
    return p_obj.get_object(p_key);
  end obj;

  function arr (p_obj in json_object_t, p_key in varchar2) return json_array_t is
  begin
    if p_obj is null or not p_obj.has(p_key) or not p_obj.get(p_key).is_array then return json_array_t(); end if;
    return p_obj.get_array(p_key);
  end arr;

  function copy (p_obj in json_object_t) return json_object_t is
  begin
    if p_obj is null then return json_object_t(); end if;
    return json_object_t.parse(p_obj.to_clob);
  end copy;

  function key_count (p_obj in json_object_t) return pls_integer is
    l_keys json_key_list;
  begin
    if p_obj is null then return 0; end if;
    l_keys := p_obj.get_keys;
    return case when l_keys is null then 0 else l_keys.count end;
  end key_count;

  function same (a in varchar2, b in varchar2) return boolean is
  begin
    return nvl(a, chr(0)) = nvl(b, chr(0));
  end same;

  function get_bool (p_obj in json_object_t, p_key in varchar2) return boolean is
  begin
    return p_obj is not null and p_obj.has(p_key) and p_obj.get(p_key).is_true;
  end get_bool;

  function safe_date (p in varchar2, p_fmt in varchar2) return date is
  begin
    return to_date(p, p_fmt);
  exception when others then return null;
  end safe_date;

  function resolve_date (p in varchar2) return varchar2 is
  begin
    case lower(p)
      when 'today'    then return to_char(trunc(current_date), 'YYYY-MM-DD');
      when 'tomorrow' then return to_char(trunc(current_date) + 1, 'YYYY-MM-DD');
      else return p;
    end case;
  end resolve_date;

  -- A value as placeholder text: a list (Repeat) shows its count, a file its name.
  function text_of (p_obj in json_object_t, p_key in varchar2) return varchar2 is
    l_el json_element_t;
  begin
    if p_obj is null or p_key is null or not p_obj.has(p_key) then return null; end if;
    l_el := p_obj.get(p_key);
    if l_el is null or l_el.is_null then return null; end if;
    if l_el.is_array then return to_char(treat(l_el as json_array_t).get_size); end if;
    if l_el.is_object then return nvl(str(treat(l_el as json_object_t), 'name'), l_el.to_string); end if;
    return str(p_obj, p_key);
  end text_of;

  function size_text (p in number) return varchar2 is
  begin
    if p is null then return null; end if;
    if p < 1048576 then return greatest(1, round(p / 1024)) || ' KB'; end if;
    return num_str(round(p / 1048576, 1)) || ' MB';
  end size_text;

  -- {{slot}} and {{record.field}} placeholders.
  function interpolate (p_text in varchar2, p_values in json_object_t) return varchar2 is
    l_res varchar2(32767) := p_text;
    l_key varchar2(200);
  begin
    for i in 1 .. 50 loop
      l_key := regexp_substr(l_res, '\{\{\s*([A-Za-z0-9_.]+)\s*\}\}', 1, 1, null, 1);
      exit when l_key is null;
      l_res := regexp_replace(l_res, '\{\{\s*' || replace(l_key, '.', '\.') || '\s*\}\}',
                              replace(text_of(p_values, l_key), '\', '\\'));
    end loop;
    return l_res;
  end interpolate;

  ------------------------------------------------------------------------------
  -- context helpers
  ------------------------------------------------------------------------------
  function get_node (c in out nocopy t_ctx, p_id in varchar2) return json_object_t is
  begin
    if p_id is null or not c.nodes.has(p_id) then
      raise_application_error(-20022, 'Flow references unknown node "' || p_id || '".');
    end if;
    return c.nodes.get_object(p_id);
  end get_node;

  function input_spec (p_node in json_object_t) return json_object_t is
    l json_object_t;
  begin
    if p_node is not null and p_node.has('input') then l := p_node.get_object('input'); else l := json_object_t(); end if;
    if not l.has('kind') then l.put('kind', 'text'); end if;
    return l;
  end input_spec;

  -- Slots plus "alias.field" for every loaded record: what placeholders and conditions see.
  -- Plus the built-in app_user: the signed-in APEX user, read from the APEX session on the
  -- server, so no slot, context value or browser request can override it.
  function vals (c in out nocopy t_ctx) return json_object_t is
    l_v     json_object_t := copy(c.slots);
    l_alias json_key_list := c.records.get_keys;
    l_cur   json_object_t;
    l_flds  json_key_list;
    l_rep   json_key_list;
    l_ctx   json_object_t := obj(c.state, 'context');
    l_ck    json_key_list;
  begin
    if l_alias is not null then
      for i in 1 .. l_alias.count loop
        l_cur := obj(c.records.get_object(l_alias(i)), 'current');
        if l_cur is not null then
          l_flds := l_cur.get_keys;
          if l_flds is not null then
            for j in 1 .. l_flds.count loop
              l_v.put(l_alias(i) || '.' || l_flds(j), l_cur.get(l_flds(j)));
            end loop;
          end if;
        end if;
      end loop;
    end if;
    -- A Repeat slot also exposes its number of items as "<slot>.count" (0 when none).
    if c.repeat_slots is not null then
      l_rep := c.repeat_slots.get_keys;
      if l_rep is not null then
        for i in 1 .. l_rep.count loop
          l_v.put(l_rep(i) || '.count', arr(c.slots, l_rep(i)).get_size);
        end loop;
      end if;
    end if;
    -- Every value the page passed in (the widget's context attribute) as "context.<name>".
    if l_ctx is not null then
      l_ck := l_ctx.get_keys;
      if l_ck is not null then
        for i in 1 .. l_ck.count loop
          l_v.put('context.' || l_ck(i), l_ctx.get(l_ck(i)));
        end loop;
      end if;
    end if;
    l_v.put('app_user', coalesce(sys_context('APEX$SESSION', 'APP_USER'), user));
    return l_v;
  end vals;

  procedure add_msg (c in out nocopy t_ctx, p_type in varchar2, p_text in varchar2) is
    l json_object_t := json_object_t();
  begin
    if p_text is null then return; end if;
    l.put('type', p_type);
    l.put('text', p_text);
    c.out_msgs.append(l);
  end add_msg;

  procedure touch (c in out nocopy t_ctx, p_slot in varchar2) is
  begin
    for i in 0 .. c.updates.get_size - 1 loop
      if c.updates.get_string(i) = p_slot then return; end if;
    end loop;
    c.updates.append(p_slot);
  end touch;

  -- The input spec as the user sees it: a lookup list's options filled in from FC_LOVS
  -- (no options until every parameter the list needs is answered).
  function eff_spec (c in out nocopy t_ctx, p_spec in json_object_t) return json_object_t is
    l_lov    varchar2(100);
    l_map    json_object_t;
    l_keys   json_key_list;
    l_params json_object_t := json_object_t();
    l_v      json_object_t;
    l_val    varchar2(4000);
    l_key    varchar2(32767);
    l_out    json_object_t;
    l_ok     boolean := true;
  begin
    l_lov := str(p_spec, 'optionsFrom');
    if l_lov is null then return p_spec; end if;
    l_out := copy(p_spec);
    l_map := obj(p_spec, 'optionsParams');
    if l_map is not null then
      l_v    := vals(c);
      l_keys := l_map.get_keys;
      if l_keys is not null then
        for i in 1 .. l_keys.count loop
          l_val := str(l_v, str(l_map, l_keys(i)));
          if l_val is null then
            l_ok := false;
            exit;
          end if;
          l_params.put(l_keys(i), l_val);
        end loop;
      end if;
    end if;
    if not l_ok then
      l_out.put('options', json_array_t());
      return l_out;
    end if;
    l_key := l_lov || '|' || l_params.to_string;
    if g_lov_cache is null then g_lov_cache := json_object_t(); end if;
    if not g_lov_cache.has(l_key) then
      g_lov_cache.put(l_key, fc_data.lov_options(l_lov, l_params, obj(c.state, 'context')));
    end if;
    l_out.put('options', g_lov_cache.get_array(l_key));
    return l_out;
  end eff_spec;

  -- Input spec sent to the browser: options resolved, server-side details removed.
  function turn_input (c in out nocopy t_ctx, p_spec in json_object_t) return json_object_t is
    l json_object_t;
  begin
    l := copy(eff_spec(c, p_spec));
    l.remove('optionsFrom');
    l.remove('optionsParams');
    l.remove('staleMessage');
    l.remove('emptyMessage');
    return l;
  end turn_input;

  procedure merge_slots (c in out nocopy t_ctx, p_res in json_object_t) is
    l_obj  json_object_t;
    l_keys json_key_list;
  begin
    l_obj := obj(p_res, 'slots');
    if l_obj is null then return; end if;
    l_keys := l_obj.get_keys;
    if l_keys is null then return; end if;
    for i in 1 .. l_keys.count loop
      c.slots.put(l_keys(i), l_obj.get(l_keys(i)));
      touch(c, l_keys(i));
    end loop;
  end merge_slots;

  -- Set node: initialise or copy values into slots, in order (a later one sees the earlier ones).
  --   {"slot": "s", "value": ...} | {"slot": "s", "template": "Hi {{name}}"} | {"slot": "s", "from": "context.dept"}
  --   | {"slot": "s", "clear": true}; "onlyIfEmpty": true keeps a value that is already there.
  procedure apply_set (c in out nocopy t_ctx, p_node in json_object_t) is
    l_list json_array_t := arr(p_node, 'assign');
    l_a    json_object_t;
    l_slot varchar2(200);
    l_v    json_object_t;
    l_from varchar2(300);
    l_txt  varchar2(32767);
  begin
    for i in 0 .. l_list.get_size - 1 loop
      if l_list.get(i).is_object then
        l_a    := treat(l_list.get(i) as json_object_t);
        l_slot := str(l_a, 'slot');
        if l_slot is not null and l_slot <> 'app_user'
           and not (get_bool(l_a, 'onlyIfEmpty') and str(c.slots, l_slot) is not null) then
          l_v := vals(c);
          if get_bool(l_a, 'clear') then
            if c.slots.has(l_slot) then c.slots.remove(l_slot); end if;
          elsif l_a.has('from') then
            l_from := str(l_a, 'from');
            if str(l_v, l_from) is not null then
              c.slots.put(l_slot, l_v.get(l_from));
            elsif c.slots.has(l_slot) then
              c.slots.remove(l_slot);
            end if;
          elsif l_a.has('template') then
            l_txt := interpolate(str(l_a, 'template'), l_v);
            if l_txt is not null then
              c.slots.put(l_slot, l_txt);
            elsif c.slots.has(l_slot) then
              c.slots.remove(l_slot);
            end if;
          elsif str(l_a, 'value') is not null then
            c.slots.put(l_slot, l_a.get('value'));
          elsif c.slots.has(l_slot) then
            c.slots.remove(l_slot);
          end if;
          touch(c, l_slot);
        end if;
      end if;
    end loop;
  end apply_set;

  function failed (c in out nocopy t_ctx) return varchar2 is
  begin
    c.state.put('status', 'failed');
    c.state.put_null('current');
    return null;
  end failed;

  -- Next node id, or mark the conversation failed when the port is not connected.
  function route (c in out nocopy t_ctx, p_id in varchar2) return varchar2 is
  begin
    if p_id is null then return failed(c); end if;
    return p_id;
  end route;

  ------------------------------------------------------------------------------
  -- connectors
  ------------------------------------------------------------------------------
  function payload (c in out nocopy t_ctx, p_node_id in varchar2,
                    p_slot in varchar2 default null, p_value in json_element_t default null) return clob is
    l json_object_t := json_object_t();
  begin
    l.put('sessionId', c.session_id);
    l.put('flowId', str(c.flow, 'flowId'));
    l.put('nodeId', p_node_id);
    l.put('slots', c.slots);
    -- The signed-in user, from the APEX session (not from the browser), for REST and PL/SQL connectors.
    l.put('appUser', coalesce(sys_context('APEX$SESSION', 'APP_USER'), user));
    if c.state.has('context') then l.put('context', c.state.get_object('context')); end if;
    if p_slot is not null then l.put('slot', p_slot); end if;
    if p_value is not null then l.put('value', p_value); end if;
    return l.to_clob;
  end payload;

  function call_connector (p_connector in varchar2, p_payload in clob) return json_object_t is
    l_type   fc_connectors.connector_type%type;
    l_target fc_connectors.target%type;
    l_res    clob;
  begin
    begin
      select connector_type, target into l_type, l_target
        from fc_connectors
       where connector_id = p_connector and enabled = 'Y';
    exception when no_data_found then
      raise_application_error(-20011, 'Unknown or disabled connector "' || p_connector || '".');
    end;

    if l_type = 'PLSQL' then
      execute immediate 'begin :r := ' || dbms_assert.qualified_sql_name(l_target) || '(:p); end;'
        using out l_res, in p_payload;
    elsif l_type = 'REST' then
      apex_web_service.g_request_headers.delete;
      apex_web_service.g_request_headers(1).name  := 'Content-Type';
      apex_web_service.g_request_headers(1).value := 'application/json';
      l_res := apex_web_service.make_rest_request(p_url => l_target, p_http_method => 'POST', p_body => p_payload);
      if apex_web_service.g_status_code not between 200 and 299 then
        raise_application_error(-20012, 'Connector "' || p_connector || '" returned HTTP ' || apex_web_service.g_status_code);
      end if;
    end if;

    if l_res is null or dbms_lob.getlength(l_res) = 0 then return json_object_t(); end if;
    return json_object_t.parse(l_res);
  end call_connector;

  ------------------------------------------------------------------------------
  -- logging: PII masking and debug events (FC_EVENTS)
  ------------------------------------------------------------------------------
  -- "pii": true | "last4" on a node or field -> 'full' | 'last4' (null = not PII)
  function pii_mode (p in json_object_t) return varchar2 is
    l varchar2(30) := str(p, 'pii');
  begin
    return case when l is null or l = 'false' then null when l = 'last4' then 'last4' else 'full' end;
  end pii_mode;

  procedure add_pii (p_arr in out nocopy json_array_t, p_el in json_element_t, p_mode in varchar2) is
    l   json_object_t := json_object_t();
    l_v varchar2(4000);
  begin
    if p_el is null or p_el.is_null or p_el.is_array then return; end if;
    if p_el.is_object then l_v := str(treat(p_el as json_object_t), 'name'); else l_v := el_str(p_el); end if;
    if l_v is null or length(l_v) < 3 then return; end if;
    l.put('v', l_v);
    l.put('m', case when p_mode = 'last4' then 'last4' else 'full' end);
    p_arr.append(l);
  end add_pii;

  -- Every value that logs must never show in clear: PII answers, PII record fields and PII
  -- line-item fields, plus the flow's "piiSlots".
  function pii_pairs (c in out nocopy t_ctx) return json_array_t is
    l_out   json_array_t := json_array_t();
    l_list  json_array_t := arr(c.flow, 'piiSlots');
    l_nodes json_array_t := c.flow.get_array('nodes');
    l_n     json_object_t;
    l_type  varchar2(30);
    l_flds  json_array_t;
    l_f     json_object_t;
    l_fld   varchar2(200);
    l_mode  varchar2(10);
    l_rec   json_object_t;
    l_items json_array_t;
    l_it    json_object_t;
    l_draft json_object_t;
  begin
    for i in 0 .. l_list.get_size - 1 loop
      if c.slots.has(el_str(l_list.get(i))) then add_pii(l_out, c.slots.get(el_str(l_list.get(i))), 'full'); end if;
    end loop;
    for i in 0 .. l_nodes.get_size - 1 loop
      l_n    := treat(l_nodes.get(i) as json_object_t);
      l_type := str(l_n, 'type');
      if l_type = 'ask' then
        if pii_mode(l_n) is not null and c.slots.has(str(l_n, 'slot')) then
          add_pii(l_out, c.slots.get(str(l_n, 'slot')), pii_mode(l_n));
        end if;
      elsif l_type = 'changeFields' then
        l_rec := obj(c.records, str(l_n, 'record'));
        if l_rec is not null then
          l_flds := arr(l_n, 'fields');
          for j in 0 .. l_flds.get_size - 1 loop
            l_f    := treat(l_flds.get(j) as json_object_t);
            l_fld  := str(l_f, 'field');
            l_mode := pii_mode(l_f);
            if l_mode is not null then
              if obj(l_rec, 'current') is not null and obj(l_rec, 'current').has(l_fld) then
                add_pii(l_out, obj(l_rec, 'current').get(l_fld), l_mode);
              end if;
              if obj(l_rec, 'original') is not null and obj(l_rec, 'original').has(l_fld) then
                add_pii(l_out, obj(l_rec, 'original').get(l_fld), l_mode);
              end if;
            end if;
          end loop;
        end if;
      elsif l_type = 'repeat' then
        l_flds  := arr(l_n, 'fields');
        l_items := arr(c.slots, str(l_n, 'slot'));
        l_draft := obj(obj(obj(c.state, 'repeat'), str(l_n, 'id')), 'draft');
        for j in 0 .. l_flds.get_size - 1 loop
          l_f    := treat(l_flds.get(j) as json_object_t);
          l_fld  := str(l_f, 'field');
          l_mode := pii_mode(l_f);
          if l_mode is not null then
            for k in 0 .. l_items.get_size - 1 loop
              if l_items.get(k).is_object then
                l_it := treat(l_items.get(k) as json_object_t);
                if l_it.has(l_fld) then add_pii(l_out, l_it.get(l_fld), l_mode); end if;
              end if;
            end loop;
            if l_draft is not null and l_draft.has(l_fld) then add_pii(l_out, l_draft.get(l_fld), l_mode); end if;
          end if;
        end loop;
      end if;
    end loop;
    return l_out;
  end pii_pairs;

  -- Replaces every PII value (as it appears inside JSON text) with a mask, longest values first.
  function mask_clob (c in out nocopy t_ctx, p_text in clob) return clob is
    l_pairs json_array_t;
    l_out   clob := p_text;
    l_p     json_object_t;
    l_v     varchar2(4000);
    l_tmp   json_object_t;
    l_txt   varchar2(32767);
    l_esc   varchar2(32767);
  begin
    if p_text is null then return p_text; end if;
    l_pairs := pii_pairs(c);
    if l_pairs.get_size = 0 then return p_text; end if;
    for pass in 1 .. 3 loop
      for i in 0 .. l_pairs.get_size - 1 loop
        l_p := treat(l_pairs.get(i) as json_object_t);
        l_v := str(l_p, 'v');
        if (pass = 1 and length(l_v) >= 20) or (pass = 2 and length(l_v) between 8 and 19) or (pass = 3 and length(l_v) < 8) then
          l_tmp := json_object_t();
          l_tmp.put('v', l_v);
          l_txt := l_tmp.to_string;                      -- {"v":"<escaped>"}
          l_esc := substr(l_txt, 7, length(l_txt) - 8);
          if length(l_esc) >= 3 then
            l_out := replace(l_out, l_esc,
                       case when str(l_p, 'm') = 'last4' then to_char(unistr('\2022\2022\2022\2022')) || substr(l_v, -4) else '[redacted]' end);
          end if;
        end if;
      end loop;
    end loop;
    return l_out;
  end mask_clob;

  -- One FC_EVENTS row, PII values masked.
  procedure log_ev (c in out nocopy t_ctx, p_dir in varchar2, p_node in varchar2, p_payload in clob) is
    l_sid varchar2(32) := c.session_id;
    l_pay clob := mask_clob(c, p_payload);
  begin
    insert into fc_events (session_id, direction, node_id, payload)
    values (l_sid, p_dir, p_node, l_pay);
  end log_ev;

  function dbg_rows (c in out nocopy t_ctx) return boolean is
  begin
    return g_debug or get_bool(c.flow, 'debug');
  end dbg_rows;

  function dbg_enabled (c in out nocopy t_ctx) return boolean is
  begin
    return dbg_rows(c) or nvl(apex_application.g_debug, false);
  end dbg_enabled;

  -- A debug event: an FC_EVENTS row (direction DBG) when the flow or set_debug asks for it,
  -- and an APEX debug message whenever APEX debug is on. Masked like every other row.
  procedure dbg (c in out nocopy t_ctx, p_node in varchar2, p_ev in json_object_t) is
    l_e json_object_t := p_ev;
    l   clob;
  begin
    if not dbg_enabled(c) then return; end if;
    l_e.put('at', to_char(sys_extract_utc(systimestamp), 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'));
    l := mask_clob(c, l_e.to_clob);
    apex_debug.info('FlowChat %s: %s', c.session_id, dbms_lob.substr(l, 3800, 1));
    if dbg_rows(c) then log_ev(c, 'DBG', p_node, l); end if;
  end dbg;

  procedure dbg_kv (c in out nocopy t_ctx, p_event in varchar2, p_node in varchar2,
                    p_k1 in varchar2 default null, p_v1 in varchar2 default null,
                    p_k2 in varchar2 default null, p_v2 in varchar2 default null) is
    l json_object_t;
  begin
    if not dbg_enabled(c) then return; end if;
    l := json_object_t();
    l.put('event', p_event);
    if p_node is not null then l.put('node', p_node); end if;
    if p_k1 is not null then l.put(p_k1, p_v1); end if;
    if p_k2 is not null then l.put(p_k2, p_v2); end if;
    dbg(c, p_node, l);
  end dbg_kv;

  -- Calls a connector and, when debugging, logs the payload (no one-time code), response and time.
  function conn (c in out nocopy t_ctx, p_node in varchar2, p_connector in varchar2, p_payload in clob) return json_object_t is
    l_t0  timestamp := systimestamp;
    l_d   interval day to second;
    l_res json_object_t;
    l_e   json_object_t;
    l_pay json_object_t;
  begin
    l_res := call_connector(p_connector, p_payload);
    if dbg_enabled(c) then
      l_d   := systimestamp - l_t0;
      l_pay := json_object_t.parse(p_payload);
      if l_pay.has('code') then l_pay.put('code', '(one-time code, not logged)'); end if;
      l_e := json_object_t();
      l_e.put('event', 'connector');
      l_e.put('node', p_node);
      l_e.put('connector', p_connector);
      l_e.put('ms', round((extract(minute from l_d) * 60 + extract(second from l_d)) * 1000));
      l_e.put('payload', l_pay);
      l_e.put('response', l_res);
      dbg(c, p_node, l_e);
    end if;
    return l_res;
  end conn;

  ------------------------------------------------------------------------------
  -- parsing, display & validation
  ------------------------------------------------------------------------------
  function parse_value (p_spec in json_object_t, p_raw in varchar2) return json_object_t is
    l_res   json_object_t := json_object_t();
    l_kind  varchar2(30)  := nvl(str(p_spec, 'kind'), 'text');
    l_s     varchar2(32767) := trim(p_raw);
    l_t     varchar2(32767);
    l_n     varchar2(4000);
    l_mult  number := 1;
    l_d     date;
    l_opts  json_array_t;
    l_opt   json_object_t;
    l_list  varchar2(4000);
    l_idx   pls_integer;

    function err (p_default in varchar2) return json_object_t is
      l json_object_t := json_object_t();
    begin
      l.put('error', nvl(str(p_spec, 'parseMessage'), p_default));
      return l;
    end err;
  begin
    if l_s is null then
      l_res.put_null('value');
      return l_res;
    end if;
    l_t := lower(l_s);

    case l_kind
      when 'number' then
        l_n := regexp_replace(l_t, '[[:space:],$' || unistr('\20AC\00A3\20B9') || ']', '');
        if regexp_like(l_n, '^-?[0-9]+(\.[0-9]+)?k$') then l_mult := 1000;    l_n := substr(l_n, 1, length(l_n) - 1);
        elsif regexp_like(l_n, '^-?[0-9]+(\.[0-9]+)?m$') then l_mult := 1000000; l_n := substr(l_n, 1, length(l_n) - 1);
        end if;
        if to_num(l_n) is null then return err('I need a number here, for example 25000 or 25k.'); end if;
        l_res.put('value', round(to_num(l_n) * l_mult, 2));

      when 'email' then
        if not regexp_like(l_s, '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
          return err('That doesn''t look like a valid email address.');
        end if;
        l_res.put('value', l_t);

      when 'date' then
        if l_t in ('today', 'tomorrow') then
          l_res.put('value', resolve_date(l_t));
        else
          if regexp_like(l_s, '^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}$') then
            l_d := safe_date(l_s, 'YYYY-MM-DD');
          elsif regexp_like(l_s, '^[0-9]{1,2}[/.-][0-9]{1,2}[/.-][0-9]{4}$') then
            l_d := safe_date(regexp_replace(l_s, '[.-]', '/'), 'DD/MM/YYYY');
          end if;
          if l_d is null then return err('Please give a date like 2026-12-31 (or "today" / "tomorrow").'); end if;
          l_res.put('value', to_char(l_d, 'YYYY-MM-DD'));
        end if;

      when 'choice' then
        l_opts := arr(p_spec, 'options');
        for i in 0 .. l_opts.get_size - 1 loop
          l_opt := treat(l_opts.get(i) as json_object_t);
          if lower(str(l_opt, 'value')) = l_t or lower(nvl(str(l_opt, 'label'), str(l_opt, 'value'))) = l_t then
            l_res.put('value', str(l_opt, 'value'));
            return l_res;
          end if;
          l_list := l_list || case when i > 0 then ', ' end || nvl(str(l_opt, 'label'), str(l_opt, 'value'));
        end loop;
        if regexp_like(l_t, '^[0-9]{1,4}$') then
          l_idx := to_number(l_t);
          if l_idx between 1 and l_opts.get_size then
            l_res.put('value', str(treat(l_opts.get(l_idx - 1) as json_object_t), 'value'));
            return l_res;
          end if;
        end if;
        return err('Please pick one of: ' || l_list || '.');

      when 'yesno' then
        if l_t in ('y', 'yes', 'true', 'yeah', 'yep', 'sure', 'ok') then l_res.put('value', 'Y');
        elsif l_t in ('n', 'no', 'false', 'nope') then l_res.put('value', 'N');
        else return err('Please answer yes or no.');
        end if;

      when 'file' then
        return err('Please attach a file.');

      else
        l_res.put('value', l_s);
    end case;
    return l_res;
  end parse_value;

  function display_for (p_spec in json_object_t, p_val in varchar2) return varchar2 is
    l_opts json_array_t;
    l_opt  json_object_t;
    l_file json_object_t;
  begin
    if p_val is null then return null; end if;
    if str(p_spec, 'kind') = 'file' then
      begin
        l_file := json_object_t.parse(p_val);
        return nvl(str(l_file, 'name'), 'file') || ' (' || size_text(to_num(str(l_file, 'size'))) || ')';
      exception when others then
        return p_val;
      end;
    end if;
    case str(p_spec, 'kind')
      when 'number' then return str(p_spec, 'prefix') || nvl(fmt_num(to_num(p_val)), p_val);
      when 'yesno'  then return case p_val when 'Y' then 'Yes' when 'N' then 'No' else p_val end;
      when 'choice' then
        l_opts := arr(p_spec, 'options');
        for i in 0 .. l_opts.get_size - 1 loop
          l_opt := treat(l_opts.get(i) as json_object_t);
          if str(l_opt, 'value') = p_val then return nvl(str(l_opt, 'label'), p_val); end if;
        end loop;
        return p_val;
      else return p_val;
    end case;
  end display_for;

  function field_def (p_change_node in json_object_t, p_field in varchar2) return json_object_t is
    l_flds json_array_t := arr(p_change_node, 'fields');
    l_f    json_object_t;
  begin
    for i in 0 .. l_flds.get_size - 1 loop
      l_f := treat(l_flds.get(i) as json_object_t);
      if str(l_f, 'field') = p_field then return l_f; end if;
    end loop;
    return null;
  end field_def;

  function field_label (p_fd in json_object_t) return varchar2 is
  begin
    return nvl(str(p_fd, 'label'), str(p_fd, 'field'));
  end field_label;

  function change_node (c in out nocopy t_ctx, p_alias in varchar2) return json_object_t is
    l_id varchar2(200) := str(c.change_nodes, p_alias);
  begin
    if l_id is null then return null; end if;
    return get_node(c, l_id);
  end change_node;

  ------------------------------------------------------------------------------
  -- repeat (line items / child rows): the slot holds an array of {field: value} objects;
  -- state.repeat[nodeId] = {draft: {...}, field: n} while an item is being answered.
  ------------------------------------------------------------------------------
  function rp_items (c in out nocopy t_ctx, p_node in json_object_t) return json_array_t is
  begin
    return arr(c.slots, str(p_node, 'slot'));
  end rp_items;

  function rp_min (p_node in json_object_t) return pls_integer is
  begin
    if str(p_node, 'min') is null then return 1; end if;
    return greatest(nvl(trunc(to_num(str(p_node, 'min'))), 0), 0);
  end rp_min;

  function rp_max (p_node in json_object_t) return pls_integer is
  begin
    return least(greatest(nvl(trunc(to_num(str(p_node, 'max'))), 20), 1), 100);
  end rp_max;

  function rp_state (c in out nocopy t_ctx, p_id in varchar2) return json_object_t is
  begin
    return obj(obj(c.state, 'repeat'), p_id);
  end rp_state;

  procedure rp_put (c in out nocopy t_ctx, p_id in varchar2, p_st in json_object_t) is
    l_all json_object_t := obj(c.state, 'repeat');
  begin
    if l_all is null then l_all := json_object_t(); end if;
    if p_st is null then
      if l_all.has(p_id) then l_all.remove(p_id); end if;
    else
      l_all.put(p_id, p_st);
    end if;
    c.state.put('repeat', l_all);
  end rp_put;

  function in_history (c in out nocopy t_ctx, p_id in varchar2) return boolean is
  begin
    for i in 0 .. c.history.get_size - 1 loop
      if c.history.get_string(i) = p_id then return true; end if;
    end loop;
    return false;
  end in_history;

  -- Finished: enough items, and Done was tapped (or items exist), with no item half-answered.
  function rp_complete (c in out nocopy t_ctx, p_node in json_object_t) return boolean is
    l_n pls_integer := rp_items(c, p_node).get_size;
  begin
    return l_n >= rp_min(p_node)
       and (l_n > 0 or in_history(c, str(p_node, 'id')))
       and rp_state(c, str(p_node, 'id')) is null;
  end rp_complete;

  -- A line-item field validated like an Ask node.
  function rp_field_node (p_node in json_object_t, p_fd in json_object_t) return json_object_t is
    l json_object_t := json_object_t();
  begin
    l.put('id', str(p_node, 'id'));
    l.put('slot', str(p_node, 'slot') || '.' || str(p_fd, 'field'));
    l.put('input', input_spec(p_fd));
    if p_fd.has('validators') then l.put('validators', p_fd.get_array('validators')); end if;
    return l;
  end rp_field_node;

  function item_title (c in out nocopy t_ctx, p_node in json_object_t, p_item in json_object_t, p_i in pls_integer) return varchar2 is
    l_v    json_object_t := json_object_t();
    l_flds json_array_t  := arr(p_node, 'fields');
    l_f    json_object_t;
    l_d    varchar2(4000);
    l_t    varchar2(32767);
  begin
    l_v.put('n', p_i + 1);
    for i in 0 .. l_flds.get_size - 1 loop
      l_f := treat(l_flds.get(i) as json_object_t);
      l_d := display_for(eff_spec(c, input_spec(l_f)), str(p_item, str(l_f, 'field')));
      l_v.put(str(l_f, 'field'), l_d);
      if l_d is not null then
        l_t := l_t || case when l_t is not null then ' ' || to_char(unistr('\00B7')) || ' ' end || l_d;
      end if;
    end loop;
    if str(p_node, 'itemTitle') is not null then return interpolate(str(p_node, 'itemTitle'), l_v); end if;
    return nvl(l_t, 'Item ' || (p_i + 1));
  end item_title;

  function repeat_titles (c in out nocopy t_ctx, p_node in json_object_t) return varchar2 is
    l_items json_array_t := rp_items(c, p_node);
    l_t     varchar2(32767);
  begin
    for i in 0 .. l_items.get_size - 1 loop
      l_t := l_t || case when i > 0 then '; ' end || item_title(c, p_node, treat(l_items.get(i) as json_object_t), i);
    end loop;
    return l_t;
  end repeat_titles;

  function rp_vals (c in out nocopy t_ctx, p_node in json_object_t, p_extra in json_object_t default null) return json_object_t is
    l      json_object_t := vals(c);
    l_n    pls_integer   := rp_items(c, p_node).get_size;
    l_keys json_key_list;
  begin
    l.put('count', l_n);
    l.put('min', rp_min(p_node));
    l.put('max', rp_max(p_node));
    l.put('n', l_n + 1);
    l.put('item', nvl(str(p_node, 'itemLabel'), 'item'));
    if p_extra is not null then
      l_keys := p_extra.get_keys;
      if l_keys is not null then
        for i in 1 .. l_keys.count loop l.put(l_keys(i), p_extra.get(l_keys(i))); end loop;
      end if;
    end if;
    return l;
  end rp_vals;

  procedure rp_card (c in out nocopy t_ctx, p_node in json_object_t) is
    l_items json_array_t := rp_items(c, p_node);
    l_list  json_array_t := json_array_t();
    l_it    json_object_t;
    l_msg   json_object_t := json_object_t();
  begin
    for i in 0 .. l_items.get_size - 1 loop
      l_it := json_object_t();
      l_it.put('index', i);
      l_it.put('title', item_title(c, p_node, treat(l_items.get(i) as json_object_t), i));
      l_list.append(l_it);
    end loop;
    l_msg.put('type', 'list');
    l_msg.put('text', interpolate(nvl(str(p_node, 'listTitle'), nvl(str(p_node, 'label'), 'Items') || ' ({{count}})'), rp_vals(c, p_node)));
    l_msg.put('items', l_list);
    c.out_msgs.append(l_msg);
  end rp_card;

  procedure rp_prompt_field (c in out nocopy t_ctx, p_node in json_object_t) is
    l_rs json_object_t := rp_state(c, str(p_node, 'id'));
    l_f  json_object_t := treat(arr(p_node, 'fields').get(nvl(to_num(str(l_rs, 'field')), 0)) as json_object_t);
  begin
    add_msg(c, 'text', interpolate(nvl(str(l_f, 'prompt'), nvl(str(l_f, 'label'), str(l_f, 'field')) || ' for {{item}} {{n}}?'),
                                   rp_vals(c, p_node, obj(l_rs, 'draft'))));
  end rp_prompt_field;

  -- Shows the step as it stands: the question being answered, or the list with Add / Done.
  procedure rp_show (c in out nocopy t_ctx, p_node in json_object_t) is
    l_pr json_object_t := obj(p_node, 'prompts');
    l_n  pls_integer   := rp_items(c, p_node).get_size;
  begin
    c.state.put('current', str(p_node, 'id'));
    if rp_state(c, str(p_node, 'id')) is not null then
      rp_prompt_field(c, p_node);
      return;
    end if;
    if l_n > 0 then rp_card(c, p_node); end if;
    add_msg(c, 'text', interpolate(
      case when l_n >= rp_max(p_node) then nvl(str(l_pr, 'full'), 'That''s the most I can take ({{max}}). Tap Done to continue.')
           when l_n >= rp_min(p_node) then nvl(str(l_pr, 'menu'), 'Add another {{item}}, or tap Done.')
           when l_n > 0 then nvl(str(l_pr, 'tooFew'), 'Please add at least {{min}}.')
           else nvl(str(l_pr, 'empty'), 'Tap Add to add a {{item}}.') end,
      rp_vals(c, p_node)));
  end rp_show;

  procedure rp_start (c in out nocopy t_ctx, p_node in json_object_t) is
    l_rs json_object_t := json_object_t();
  begin
    l_rs.put('draft', json_object_t());
    l_rs.put('field', 0);
    rp_put(c, str(p_node, 'id'), l_rs);
    rp_prompt_field(c, p_node);
  end rp_start;

  -- Input spec for a slot or "alias.field" (used for display formatting).
  function spec_for (c in out nocopy t_ctx, p_name in varchar2) return json_object_t is
    l_dot pls_integer := instr(p_name, '.');
    l_cn  json_object_t;
    l_fd  json_object_t;
    l_nid varchar2(200);
  begin
    if l_dot > 1 then
      l_cn := change_node(c, substr(p_name, 1, l_dot - 1));
      if l_cn is null then return null; end if;
      l_fd := field_def(l_cn, substr(p_name, l_dot + 1));
      if l_fd is null then return null; end if;
      return eff_spec(c, input_spec(l_fd));
    end if;
    l_nid := str(c.slot_nodes, p_name);
    if l_nid is null then return null; end if;
    return eff_spec(c, input_spec(get_node(c, l_nid)));
  end spec_for;

  function display_value (c in out nocopy t_ctx, p_name in varchar2) return varchar2 is
  begin
    if c.repeat_slots is not null and c.repeat_slots.has(p_name) then
      return repeat_titles(c, get_node(c, str(c.repeat_slots, p_name)));
    end if;
    return display_for(spec_for(c, p_name), str(vals(c), p_name));
  end display_value;

  -- p_parsed = {"value": <typed value or null>}. Returns an error message or null.
  function validate (c in out nocopy t_ctx, p_node in json_object_t, p_parsed in json_object_t) return varchar2 is
    l_spec   json_object_t;
    l_kind   varchar2(30);
    l_val    varchar2(32767) := str(p_parsed, 'value');
    l_prefix varchar2(20);
    l_opts   json_array_t;
    l_found  boolean := false;
    l_num    number;
    l_lo     varchar2(30);
    l_hi     varchar2(30);
    l_vals   json_array_t;
    l_v      json_object_t;
    l_res    json_object_t;
  begin
    l_spec   := eff_spec(c, input_spec(p_node));
    l_kind   := str(l_spec, 'kind');
    l_prefix := str(l_spec, 'prefix');
    if l_val is null then
      if str(l_spec, 'required') = 'false' then return null; end if;
      return nvl(str(l_spec, 'requiredMessage'), case when l_kind = 'file' then 'Please attach a file.' else c_required end);
    end if;

    if l_kind = 'file' then
      if not p_parsed.get('value').is_object then return 'Please attach a file.'; end if;
    elsif l_kind = 'choice' then
      -- Also catches an answer a lookup list no longer offers (an answer it depends on changed).
      l_opts := arr(l_spec, 'options');
      for i in 0 .. l_opts.get_size - 1 loop
        if str(treat(l_opts.get(i) as json_object_t), 'value') = l_val then l_found := true; exit; end if;
      end loop;
      if not l_found then
        return nvl(str(l_spec, 'staleMessage'), 'Please choose one of the options shown.');
      end if;
    elsif l_kind = 'number' then
      l_num := to_num(l_val);
      if to_num(str(l_spec, 'min')) is not null and l_num < to_num(str(l_spec, 'min')) then
        return nvl(str(l_spec, 'minMessage'), 'Please enter at least ' || l_prefix || fmt_num(to_num(str(l_spec, 'min'))) || '.');
      end if;
      if to_num(str(l_spec, 'max')) is not null and l_num > to_num(str(l_spec, 'max')) then
        return nvl(str(l_spec, 'maxMessage'), 'The maximum is ' || l_prefix || fmt_num(to_num(str(l_spec, 'max'))) || '.');
      end if;
    elsif l_kind = 'date' then
      l_lo := resolve_date(str(l_spec, 'minDate'));
      l_hi := resolve_date(str(l_spec, 'maxDate'));
      if l_lo is not null and l_val < l_lo then
        return nvl(str(l_spec, 'minMessage'), 'Please choose a date on or after ' || l_lo || '.');
      end if;
      if l_hi is not null and l_val > l_hi then
        return nvl(str(l_spec, 'maxMessage'), 'Please choose a date on or before ' || l_hi || '.');
      end if;
    else
      if to_num(str(l_spec, 'minLength')) is not null and length(l_val) < to_num(str(l_spec, 'minLength')) then
        return nvl(str(l_spec, 'minMessage'), 'Please enter at least ' || str(l_spec, 'minLength') || ' characters.');
      end if;
      if to_num(str(l_spec, 'maxLength')) is not null and length(l_val) > to_num(str(l_spec, 'maxLength')) then
        return nvl(str(l_spec, 'maxMessage'), 'Please use at most ' || str(l_spec, 'maxLength') || ' characters.');
      end if;
    end if;

    l_vals := arr(p_node, 'validators');
    for i in 0 .. l_vals.get_size - 1 loop
      l_v := treat(l_vals.get(i) as json_object_t);
      if str(l_v, 'type') = 'regex' then
        if not regexp_like(l_val, str(l_v, 'pattern')) then
          return nvl(str(l_v, 'message'), 'That value isn''t in the expected format.');
        end if;
      elsif str(l_v, 'type') = 'server' then
        l_res := conn(c, str(p_node, 'id'), str(l_v, 'connector'),
                      payload(c, str(p_node, 'id'), str(p_node, 'slot'), p_parsed.get('value')));
        if str(l_res, 'valid') = 'false' then
          return coalesce(str(l_res, 'message'), str(l_v, 'message'), 'That value wasn''t accepted.');
        end if;
      end if;
    end loop;
    return null;
  end validate;

  -- Is the saved answer of a lookup-list question still one of its options?
  function still_offered (c in out nocopy t_ctx, p_node in json_object_t) return boolean is
    l_opts json_array_t;
    l_v    varchar2(4000) := str(c.slots, str(p_node, 'slot'));
  begin
    l_opts := arr(eff_spec(c, input_spec(p_node)), 'options');
    for i in 0 .. l_opts.get_size - 1 loop
      if str(treat(l_opts.get(i) as json_object_t), 'value') = l_v then return true; end if;
    end loop;
    return false;
  end still_offered;

  -- A changeFields field validated like an Ask node.
  function field_as_node (p_change_node in json_object_t, p_fd in json_object_t) return json_object_t is
    l json_object_t := json_object_t();
  begin
    l.put('id', str(p_change_node, 'id'));
    l.put('slot', str(p_change_node, 'record') || '.' || str(p_fd, 'field'));
    l.put('input', input_spec(p_fd));
    if p_fd.has('validators') then l.put('validators', p_fd.get_array('validators')); end if;
    return l;
  end field_as_node;

  ------------------------------------------------------------------------------
  -- conditions
  ------------------------------------------------------------------------------
  function eval_cond (p_values in json_object_t, p_cond in json_object_t) return boolean is
    l_arr json_array_t;
    l_op  varchar2(20);
    l_v   varchar2(32767);
    l_cv  varchar2(32767);
    l_n1  number;
    l_n2  number;
  begin
    if p_cond is null then return true; end if;
    if p_cond.has('all') then
      l_arr := p_cond.get_array('all');
      for i in 0 .. l_arr.get_size - 1 loop
        if not eval_cond(p_values, treat(l_arr.get(i) as json_object_t)) then return false; end if;
      end loop;
      return true;
    elsif p_cond.has('any') then
      l_arr := p_cond.get_array('any');
      for i in 0 .. l_arr.get_size - 1 loop
        if eval_cond(p_values, treat(l_arr.get(i) as json_object_t)) then return true; end if;
      end loop;
      return false;
    elsif p_cond.has('not') then
      return not eval_cond(p_values, p_cond.get_object('not'));
    end if;

    l_op := str(p_cond, 'op');
    l_v  := str(p_values, str(p_cond, 'slot'));
    if l_op = 'empty'    then return l_v is null; end if;
    if l_op = 'notEmpty' then return l_v is not null; end if;
    if l_op is null or l_op not in ('=', '!=', '>', '>=', '<', '<=', 'in') then
      raise_application_error(-20023, 'Unknown operator "' || l_op || '".');
    end if;
    if l_v is null then return false; end if;

    if l_op = 'in' then
      l_arr := p_cond.get_array('value');
      for i in 0 .. l_arr.get_size - 1 loop
        if el_str(l_arr.get(i)) = l_v then return true; end if;
      end loop;
      return false;
    end if;

    l_cv := str(p_cond, 'value');
    l_n1 := to_num(l_v);
    l_n2 := to_num(l_cv);
    if l_n1 is not null and l_n2 is not null then
      return case l_op
               when '='  then l_n1 =  l_n2  when '!=' then l_n1 <> l_n2
               when '>'  then l_n1 >  l_n2  when '>=' then l_n1 >= l_n2
               when '<'  then l_n1 <  l_n2  when '<=' then l_n1 <= l_n2
             end;
    end if;
    return case l_op
             when '='  then l_v =  l_cv  when '!=' then nvl(l_v <> l_cv, true)
             when '>'  then l_v >  l_cv  when '>=' then l_v >= l_cv
             when '<'  then l_v <  l_cv  when '<=' then l_v <= l_cv
           end;
  end eval_cond;

  function pick_branch (p_values in json_object_t, p_node in json_object_t) return varchar2 is
    l_br json_array_t := arr(p_node, 'branches');
    l_b  json_object_t;
  begin
    for i in 0 .. l_br.get_size - 1 loop
      l_b := treat(l_br.get(i) as json_object_t);
      if eval_cond(p_values, obj(l_b, 'when')) then return str(l_b, 'next'); end if;
    end loop;
    return str(p_node, 'else');
  end pick_branch;

  ------------------------------------------------------------------------------
  -- records (findRecord / changeFields / saveChanges)
  ------------------------------------------------------------------------------
  function record_changes (p_rec in json_object_t) return json_object_t is
    l_cur  json_object_t := obj(p_rec, 'current');
    l_org  json_object_t := obj(p_rec, 'original');
    l_keys json_key_list;
    l_out  json_object_t := json_object_t();
  begin
    if l_cur is null then return l_out; end if;
    l_keys := l_cur.get_keys;
    if l_keys is null then return l_out; end if;
    for i in 1 .. l_keys.count loop
      if not same(str(l_cur, l_keys(i)), str(l_org, l_keys(i))) then
        l_out.put(l_keys(i), l_cur.get(l_keys(i)));
      end if;
    end loop;
    return l_out;
  end record_changes;

  function field_editable (c in out nocopy t_ctx, p_change_node in json_object_t, p_fd in json_object_t) return boolean is
    l_rec json_object_t := obj(c.records, str(p_change_node, 'record'));
  begin
    if l_rec is null then return false; end if;
    if not fc_data.is_updatable(str(l_rec, 'source'), str(p_fd, 'field')) then return false; end if;
    return eval_cond(vals(c), obj(p_fd, 'editableWhen'));
  end field_editable;

  procedure prompt_field (c in out nocopy t_ctx, p_change_node in json_object_t, p_fd in json_object_t) is
    l_rec json_object_t := obj(c.records, str(p_change_node, 'record'));
    l_cur varchar2(4000);
  begin
    c.state.put('current', str(p_change_node, 'id'));
    c.state.put('editingField', str(p_fd, 'field'));
    l_cur := display_for(eff_spec(c, input_spec(p_fd)), str(obj(l_rec, 'current'), str(p_fd, 'field')));
    add_msg(c, 'text', interpolate(nvl(str(p_fd, 'prompt'),
      field_label(p_fd) || case when l_cur is not null then ' is currently ' || l_cur || '. What should it be?'
                                else ' is empty. What should it be?' end), vals(c)));
  end prompt_field;

  function load_record (c in out nocopy t_ctx, p_node in json_object_t, p_key in varchar2) return varchar2 is
    l_alias varchar2(100) := str(p_node, 'as');
    l_res   json_object_t;
    l_vals  json_object_t;
    l_rec   json_object_t := json_object_t();
    l_keys  json_key_list;
  begin
    l_res := fc_data.get_row(str(p_node, 'source'), p_key, obj(c.state, 'context'));
    if c.results.has(str(p_node, 'id')) then c.results.remove(str(p_node, 'id')); end if;
    l_vals := obj(l_res, 'values');
    if l_vals is null then
      add_msg(c, 'error', nvl(str(obj(p_node, 'prompts'), 'gone'), 'That record is no longer available.'));
      return str(p_node, 'notFound');
    end if;
    l_rec.put('source', str(p_node, 'source'));
    l_rec.put('key', p_key);
    if str(l_res, 'version') is not null then l_rec.put('version', str(l_res, 'version')); else l_rec.put_null('version'); end if;
    l_rec.put('original', copy(l_vals));
    l_rec.put('current', copy(l_vals));
    c.records.put(l_alias, l_rec);
    l_keys := l_vals.get_keys;
    if l_keys is not null then
      for i in 1 .. l_keys.count loop touch(c, l_alias || '.' || l_keys(i)); end loop;
    end if;
    add_msg(c, 'text', interpolate(str(obj(p_node, 'prompts'), 'found'), vals(c)));
    return str(p_node, 'found');
  end load_record;

  ------------------------------------------------------------------------------
  -- verify (one-time code). Only a salted SHA-256 of the code is kept in the session.
  ------------------------------------------------------------------------------
  function now_secs return number is
  begin
    return round((cast(sys_extract_utc(systimestamp) as date) - date '1970-01-01') * 86400);
  end now_secs;

  function opt_int (p_node in json_object_t, p_key in varchar2, p_default in pls_integer,
                    p_min in pls_integer, p_max in pls_integer default null) return pls_integer is
    l number := trunc(to_num(str(p_node, p_key)));
  begin
    l := greatest(nvl(l, p_default), p_min);
    if p_max is not null then l := least(l, p_max); end if;
    return l;
  end opt_int;

  function hash_code (p_salt in varchar2, p_code in varchar2) return varchar2 is
  begin
    return lower(rawtohex(dbms_crypto.hash(utl_raw.cast_to_raw(p_salt || ':' || p_code), dbms_crypto.hash_sh256)));
  end hash_code;

  function random_code (p_len in pls_integer) return varchar2 is
    l varchar2(20);
  begin
    for i in 1 .. p_len loop
      l := l || to_char(abs(mod(dbms_crypto.randominteger, 10)));
    end loop;
    return l;
  end random_code;

  -- A state member that holds an object ({} when absent).
  function st_obj (c in out nocopy t_ctx, p_key in varchar2) return json_object_t is
    l json_object_t := obj(c.state, p_key);
  begin
    if l is null then l := json_object_t(); end if;
    return l;
  end st_obj;

  -- True when the slot's current value is the one that passed verification.
  function is_verified (c in out nocopy t_ctx, p_slot in varchar2) return boolean is
    l_val varchar2(4000) := str(c.slots, p_slot);
  begin
    return l_val is not null and str(st_obj(c, 'verified'), p_slot) = l_val;
  end is_verified;

  function verify_vals (c in out nocopy t_ctx, p_node in json_object_t) return json_object_t is
    l json_object_t := vals(c);
  begin
    l.put('codeLength', opt_int(p_node, 'codeLength', 6, 4, 10));
    l.put('ttlMinutes', opt_int(p_node, 'ttlMinutes', 10, 1));
    return l;
  end verify_vals;

  -- Generates, hashes and sends a code. False when the connector reports {"ok": false}.
  function send_code (c in out nocopy t_ctx, p_node in json_object_t) return boolean is
    l_id     varchar2(200)  := str(p_node, 'id');
    l_ttl    pls_integer    := opt_int(p_node, 'ttlMinutes', 10, 1);
    l_target varchar2(4000) := str(c.slots, str(p_node, 'slot'));
    l_code   varchar2(20)   := random_code(opt_int(p_node, 'codeLength', 6, 4, 10));
    l_all    json_object_t  := st_obj(c, 'verify');
    l_prev   json_object_t  := obj(l_all, l_id);
    l_pend   json_object_t  := json_object_t();
    l_pay    json_object_t;
    l_res    json_object_t;
    l_sends  pls_integer    := 1;
  begin
    if l_prev is not null and str(l_prev, 'target') = l_target then
      l_sends := nvl(to_num(str(l_prev, 'sends')), 0) + 1;
    end if;
    l_pend.put('hash', hash_code(c.session_id || ':' || l_id, l_code));
    l_pend.put('target', l_target);
    l_pend.put('expiresAt', now_secs + l_ttl * 60);
    l_pend.put('attempts', 0);
    l_pend.put('sends', l_sends);
    l_all.put(l_id, l_pend);
    c.state.put('verify', l_all);

    l_pay := json_object_t.parse(payload(c, l_id));
    l_pay.put('channel', nvl(str(p_node, 'channel'), 'email'));
    l_pay.put('to', l_target);
    l_pay.put('code', l_code);
    l_pay.put('ttlMinutes', l_ttl);
    l_res := conn(c, l_id, str(p_node, 'connector'), l_pay.to_clob);
    if str(l_res, 'ok') = 'false' then
      l_all.remove(l_id);
      c.state.put('verify', l_all);
      add_msg(c, 'error', nvl(str(l_res, 'message'), 'Sorry, I couldn''t send the code.'));
      return false;
    end if;
    return true;
  end send_code;

  function run_verify (c in out nocopy t_ctx, p_node in json_object_t, p_await out boolean) return varchar2 is
    l_slot varchar2(200) := str(p_node, 'slot');
  begin
    p_await := false;
    if str(c.slots, l_slot) is null then
      raise_application_error(-20027, 'Verify "' || str(p_node, 'id') || '" needs a value in "' || l_slot || '".');
    end if;
    if is_verified(c, l_slot) then
      c.state.put('verifiedLast', str(c.slots, l_slot));
      fc_data.set_verified(str(c.slots, l_slot));
      return str(p_node, 'verified');
    end if;
    if c.replay then c.state.put('editing', true); end if;   -- reached while replaying an edit: resume after it
    c.replay := false;
    if not send_code(c, p_node) then
      return route(c, str(p_node, 'failed'));
    end if;
    c.state.put('current', str(p_node, 'id'));
    add_msg(c, 'text', interpolate(nvl(str(obj(p_node, 'prompts'), 'sent'),
      'I''ve sent a {{codeLength}}-digit code to {{' || l_slot || '}}. Please enter it here.'), verify_vals(c, p_node)));
    p_await := true;
    return null;
  end run_verify;

  -- Search criteria from answered slots; p_ok = false when fewer than minCriteria are answered.
  -- byRowFilter: no criteria; the data source's row filter (e.g. owner = :APP_USER) picks the rows.
  function crit_for (c in out nocopy t_ctx, p_node in json_object_t, p_ok out boolean) return json_array_t is
    l_v    json_object_t := vals(c);
    l_crit json_array_t  := json_array_t();
    l_cdef json_array_t  := arr(p_node, 'criteria');
    l_cd   json_object_t;
    l_c    json_object_t;
    l_val  varchar2(4000);
  begin
    p_ok := true;
    if nvl(str(p_node, 'byRowFilter'), 'false') = 'true' then return l_crit; end if;
    for i in 0 .. l_cdef.get_size - 1 loop
      l_cd  := treat(l_cdef.get(i) as json_object_t);
      l_val := str(l_v, str(l_cd, 'slot'));
      if l_val is not null then
        l_c := json_object_t();
        l_c.put('field', str(l_cd, 'field'));
        l_c.put('op', nvl(str(l_cd, 'op'), 'eq'));
        l_c.put('value', l_val);
        l_crit.append(l_c);
      end if;
    end loop;
    p_ok := l_crit.get_size >= nvl(to_num(str(p_node, 'minCriteria')), 1);
    return l_crit;
  end crit_for;

  function search_src (c in out nocopy t_ctx, p_node in json_object_t, p_crit in json_array_t, p_limit in pls_integer) return json_array_t is
    l_rows json_array_t;
    l_e    json_object_t;
  begin
    l_rows := fc_data.search_rows(str(p_node, 'source'), p_crit, p_limit, obj(c.state, 'context'));
    if dbg_enabled(c) then
      l_e := json_object_t();
      l_e.put('event', 'search');
      l_e.put('node', str(p_node, 'id'));
      l_e.put('source', str(p_node, 'source'));
      l_e.put('criteria', p_crit);
      l_e.put('rows', l_rows.get_size);
      dbg(c, str(p_node, 'id'), l_e);
    end if;
    return l_rows;
  end search_src;

  -- Never search for an identity that hasn't passed a Verify step (a flow design error).
  function verified_gate (c in out nocopy t_ctx, p_node in json_object_t) return boolean is
  begin
    if str(p_node, 'requireVerified') is not null and not is_verified(c, str(p_node, 'requireVerified')) then
      add_msg(c, 'error', 'I can''t look that up until it has been verified.');
      return false;
    end if;
    return true;
  end verified_gate;

  function run_find (c in out nocopy t_ctx, p_node in json_object_t, p_await out boolean) return varchar2 is
    l_v       json_object_t := vals(c);
    l_prompts json_object_t := obj(p_node, 'prompts');
    l_card    json_object_t := obj(p_node, 'card');
    l_crit    json_array_t;
    l_ok      boolean;
    l_max     pls_integer   := nvl(to_num(str(p_node, 'maxResults')), 10);
    l_rows    json_array_t;
    l_row     json_object_t;
    l_vals    json_object_t;
    l_res     json_array_t  := json_array_t();
    l_r       json_object_t;
  begin
    p_await := false;
    if not verified_gate(c, p_node) then
      return failed(c);
    end if;
    l_crit := crit_for(c, p_node, l_ok);
    if not l_ok then
      add_msg(c, 'text', interpolate(nvl(str(l_prompts, 'none'), c_not_found), l_v));
      return str(p_node, 'notFound');
    end if;

    l_rows := search_src(c, p_node, l_crit, l_max + 1);
    if l_rows.get_size = 0 then
      add_msg(c, 'text', interpolate(nvl(str(l_prompts, 'none'), c_not_found), l_v));
      return str(p_node, 'notFound');
    end if;
    if l_rows.get_size > l_max then
      add_msg(c, 'text', interpolate(nvl(str(l_prompts, 'tooMany'), 'That matches too many records. Let''s narrow it down.'), l_v));
      return nvl(str(p_node, 'tooMany'), str(p_node, 'notFound'));
    end if;
    if l_rows.get_size = 1 and nvl(str(p_node, 'autoPick'), 'true') <> 'false' then
      return load_record(c, p_node, str(treat(l_rows.get(0) as json_object_t), 'key'));
    end if;

    for i in 0 .. l_rows.get_size - 1 loop
      l_row  := treat(l_rows.get(i) as json_object_t);
      l_vals := obj(l_row, 'values');
      l_r    := json_object_t();
      l_r.put('token', 'r' || (i + 1));
      l_r.put('key', str(l_row, 'key'));
      l_r.put('title', interpolate(nvl(str(l_card, 'title'), str(l_row, 'key')), l_vals));
      l_r.put('subtitle', case when str(l_card, 'subtitle') is not null then interpolate(str(l_card, 'subtitle'), l_vals) end);
      l_res.append(l_r);
    end loop;
    c.results.put(str(p_node, 'id'), l_res);
    c.state.put('current', str(p_node, 'id'));
    l_v.put('count', l_rows.get_size);
    add_msg(c, 'text', interpolate(nvl(str(l_prompts, 'many'), 'I found {{count}} matching records. Which one?'), l_v));
    p_await := true;
    return null;
  end run_find;

  function run_save (c in out nocopy t_ctx, p_node in json_object_t, p_await out boolean) return varchar2 is
    l_alias   varchar2(100) := str(p_node, 'record');
    l_rec     json_object_t := obj(c.records, l_alias);
    l_cn      json_object_t;
    l_changes json_object_t;
    l_keys    json_key_list;
    l_fd      json_object_t;
    l_w       json_object_t;
    l_err     varchar2(4000);
    l_orig    json_object_t := json_object_t();
    l_r       json_object_t;
    l_fresh   json_object_t;
    l_cur     json_object_t;
    l_audit   json_object_t := json_object_t();
    l_all     json_key_list;
    l_sid     varchar2(32)  := c.session_id;
    l_nid     varchar2(200) := str(p_node, 'id');
    l_audit_c clob;
  begin
    p_await := false;
    if l_rec is null then
      raise_application_error(-20024, 'Save changes "' || str(p_node, 'id') || '" needs a loaded record "' || l_alias || '".');
    end if;
    l_cn      := change_node(c, l_alias);
    l_changes := record_changes(l_rec);
    l_keys    := l_changes.get_keys;
    if l_keys is null or l_keys.count = 0 then
      add_msg(c, 'text', nvl(str(p_node, 'noChangesText'), 'Nothing changed, so there was nothing to save.'));
      return nvl(str(p_node, 'noChanges'), str(p_node, 'saved'));
    end if;

    -- Defence in depth: every changed field must be declared editable and must still validate.
    for i in 1 .. l_keys.count loop
      l_fd := null;
      if l_cn is not null then l_fd := field_def(l_cn, l_keys(i)); end if;
      if l_fd is null or not field_editable(c, l_cn, l_fd) then
        add_msg(c, 'error', 'The field "' || l_keys(i) || '" cannot be changed here.');
        return route(c, str(p_node, 'forbidden'));
      end if;
      l_w := json_object_t();
      l_w.put('value', l_changes.get(l_keys(i)));
      l_err := validate(c, field_as_node(l_cn, l_fd), l_w);
      if l_err is not null then
        add_msg(c, 'error', l_err);
        prompt_field(c, l_cn, l_fd);
        p_await := true;
        return null;
      end if;
      l_orig.put(l_keys(i), obj(l_rec, 'original').get(l_keys(i)));
    end loop;

    l_r := fc_data.update_row(str(l_rec, 'source'), str(l_rec, 'key'), str(l_rec, 'version'),
                              l_orig, l_changes, obj(c.state, 'context'));

    -- audit trail (before / after) in the session transcript
    l_audit.put('action', 'update');
    l_audit.put('source', str(l_rec, 'source'));
    l_audit.put('key', str(l_rec, 'key'));
    l_audit.put('before', l_orig);
    l_audit.put('after', l_changes);
    l_audit.put('result', nvl(str(l_r, 'status'), 'error'));
    l_audit_c := l_audit.to_clob;   -- package-private functions and object methods can't appear inside SQL
    log_ev(c, 'OUT', l_nid, l_audit_c);

    case nvl(str(l_r, 'status'), 'error')
      when 'ok' then
        if str(l_r, 'version') is not null then l_rec.put('version', str(l_r, 'version')); end if;
        l_rec.put('original', copy(obj(l_rec, 'current')));
        c.records.put(l_alias, l_rec);
        add_msg(c, 'text', nvl(str(l_r, 'message'), str(p_node, 'savedText')));
        return str(p_node, 'saved');

      when 'conflict' then
        l_fresh := fc_data.get_row(str(l_rec, 'source'), str(l_rec, 'key'), obj(c.state, 'context'));
        if obj(l_fresh, 'values') is null then
          add_msg(c, 'error', 'That record is no longer available.');
          return route(c, str(p_node, 'error'));
        end if;
        l_cur := copy(obj(l_fresh, 'values'));
        for i in 1 .. l_keys.count loop l_cur.put(l_keys(i), l_changes.get(l_keys(i))); end loop;
        l_rec.put('original', copy(obj(l_fresh, 'values')));
        if str(l_fresh, 'version') is not null then l_rec.put('version', str(l_fresh, 'version')); else l_rec.put_null('version'); end if;
        l_rec.put('current', l_cur);
        c.records.put(l_alias, l_rec);
        l_all := l_cur.get_keys;
        if l_all is not null then
          for i in 1 .. l_all.count loop touch(c, l_alias || '.' || l_all(i)); end loop;
        end if;
        add_msg(c, 'error', coalesce(str(l_r, 'message'), str(p_node, 'conflictText'),
          'Someone else changed this record after you opened it. I''ve loaded the latest version with your changes on top. Please check them again.'));
        return route(c, coalesce(str(p_node, 'conflict'), str(p_node, 'error')));

      when 'forbidden' then
        add_msg(c, 'error', nvl(str(l_r, 'message'), 'You''re not allowed to change this record.'));
        return route(c, str(p_node, 'forbidden'));

      else
        add_msg(c, 'error', nvl(str(l_r, 'message'), 'Sorry, the changes could not be saved.'));
        return route(c, str(p_node, 'error'));
    end case;
  end run_save;

  ------------------------------------------------------------------------------
  -- bulk update: the same change applied to every record a search finds, after a confirmation.
  -- state.bulk[nodeId] = {keys, count, changes, changeText, preview} (keys never leave the server)
  ------------------------------------------------------------------------------
  function bulk_state (c in out nocopy t_ctx, p_id in varchar2) return json_object_t is
  begin
    return obj(obj(c.state, 'bulk'), p_id);
  end bulk_state;

  procedure bulk_put (c in out nocopy t_ctx, p_id in varchar2, p_b in json_object_t) is
    l_all json_object_t := obj(c.state, 'bulk');
  begin
    if l_all is null then l_all := json_object_t(); end if;
    if p_b is null then
      if l_all.has(p_id) then l_all.remove(p_id); end if;
    else
      l_all.put(p_id, p_b);
    end if;
    c.state.put('bulk', l_all);
  end bulk_put;

  procedure bulk_confirm (c in out nocopy t_ctx, p_node in json_object_t) is
    l_b     json_object_t := bulk_state(c, str(p_node, 'id'));
    l_pr    json_object_t := obj(p_node, 'prompts');
    l_v     json_object_t := vals(c);
    l_cnt   pls_integer   := nvl(to_num(str(l_b, 'count')), 0);
    l_prev  json_array_t  := arr(l_b, 'preview');
    l_items json_array_t  := json_array_t();
    l_it    json_object_t;
    l_p     json_object_t;
    l_msg   json_object_t := json_object_t();
  begin
    l_v.put('count', l_cnt);
    l_v.put('records', case when l_cnt = 1 then 'record' else 'records' end);
    l_v.put('changes', str(l_b, 'changeText'));
    add_msg(c, 'text', interpolate(nvl(str(l_pr, 'confirm'),
      'This will set {{changes}} on {{count}} {{records}}. Do you want to go ahead?'), l_v));
    for i in 0 .. l_prev.get_size - 1 loop
      l_p  := treat(l_prev.get(i) as json_object_t);
      l_it := json_object_t();
      l_it.put('index', i);
      l_it.put('title', str(l_p, 'title'));
      l_it.put('subtitle', str(l_p, 'subtitle'));
      l_items.append(l_it);
    end loop;
    if l_cnt > l_prev.get_size then
      l_it := json_object_t();
      l_it.put('index', -1);
      l_it.put('title', to_char(unistr('\2026')) || 'and ' || (l_cnt - l_prev.get_size) || ' more');
      l_items.append(l_it);
    end if;
    l_msg.put('type', 'list');
    l_msg.put('text', interpolate(nvl(str(l_pr, 'listTitle'), 'Records to change'), l_v));
    l_msg.put('items', l_items);
    c.out_msgs.append(l_msg);
  end bulk_confirm;

  function run_bulk (c in out nocopy t_ctx, p_node in json_object_t, p_await out boolean) return varchar2 is
    l_id      varchar2(200) := str(p_node, 'id');
    l_v       json_object_t := vals(c);
    l_pr      json_object_t := obj(p_node, 'prompts');
    l_card    json_object_t := obj(p_node, 'card');
    l_crit    json_array_t;
    l_ok      boolean;
    l_max     pls_integer   := least(greatest(nvl(trunc(to_num(str(p_node, 'maxRows'))), 50), 1), 500);
    l_rows    json_array_t;
    l_row     json_object_t;
    l_set     json_object_t := obj(p_node, 'set');
    l_skeys   json_key_list;
    l_el      json_element_t;
    l_so      json_object_t;
    l_label   varchar2(200);
    l_changes json_object_t := json_object_t();
    l_text    varchar2(4000);
    l_keys    json_array_t  := json_array_t();
    l_prev    json_array_t  := json_array_t();
    l_p       json_object_t;
    l_b       json_object_t := json_object_t();
  begin
    p_await := false;
    if not verified_gate(c, p_node) then
      return failed(c);
    end if;
    l_crit := crit_for(c, p_node, l_ok);
    if not l_ok then
      add_msg(c, 'text', interpolate(nvl(str(l_pr, 'none'), 'I couldn''t find any matching records.'), l_v));
      return route(c, str(p_node, 'none'));
    end if;
    l_rows := search_src(c, p_node, l_crit, l_max + 1);
    if l_rows.get_size = 0 then
      add_msg(c, 'text', interpolate(nvl(str(l_pr, 'none'), 'I couldn''t find any matching records.'), l_v));
      return route(c, str(p_node, 'none'));
    end if;
    if l_rows.get_size > l_max then
      l_v.put('max', l_max);
      add_msg(c, 'text', interpolate(nvl(str(l_pr, 'tooMany'),
        'That matches more than {{max}} records, which is too many to change at once.'), l_v));
      return route(c, coalesce(str(p_node, 'tooMany'), str(p_node, 'none')));
    end if;

    -- the new values: {"value": ...} literal or {"slot": "..."} from an answer
    if l_set is not null then
      l_skeys := l_set.get_keys;
      if l_skeys is not null then
        for i in 1 .. l_skeys.count loop
          l_el    := l_set.get(l_skeys(i));
          l_label := l_skeys(i);
          if l_el.is_object then
            l_so := treat(l_el as json_object_t);
            l_label := nvl(str(l_so, 'label'), l_skeys(i));
            if str(l_so, 'slot') is not null then
              if str(l_v, str(l_so, 'slot')) is not null then l_changes.put(l_skeys(i), l_v.get(str(l_so, 'slot')));
              else l_changes.put_null(l_skeys(i));
              end if;
            elsif l_so.has('value') then
              l_changes.put(l_skeys(i), l_so.get('value'));
            else
              l_changes.put_null(l_skeys(i));
            end if;
          else
            l_changes.put(l_skeys(i), l_el);
          end if;
          l_text := l_text || case when i > 1 then ', ' end || l_label || ' = ' || nvl(text_of(l_changes, l_skeys(i)), '(empty)');
        end loop;
      end if;
    end if;

    for i in 0 .. l_rows.get_size - 1 loop
      l_row := treat(l_rows.get(i) as json_object_t);
      l_keys.append(str(l_row, 'key'));
      if i < 10 then
        l_p := json_object_t();
        l_p.put('title', interpolate(nvl(str(l_card, 'title'), str(l_row, 'key')), obj(l_row, 'values')));
        l_p.put('subtitle', case when str(l_card, 'subtitle') is not null then interpolate(str(l_card, 'subtitle'), obj(l_row, 'values')) end);
        l_prev.append(l_p);
      end if;
    end loop;
    l_b.put('keys', l_keys);
    l_b.put('count', l_rows.get_size);
    l_b.put('changes', l_changes);
    l_b.put('changeText', l_text);
    l_b.put('preview', l_prev);
    bulk_put(c, l_id, l_b);
    c.state.put('current', l_id);
    bulk_confirm(c, p_node);
    p_await := true;
    return null;
  end run_bulk;

  ------------------------------------------------------------------------------
  -- runtime
  ------------------------------------------------------------------------------
  procedure add_changes (c in out nocopy t_ctx, p_node in json_object_t) is
    l_alias   varchar2(100) := str(p_node, 'record');
    l_rec     json_object_t := obj(c.records, l_alias);
    l_cn      json_object_t;
    l_changes json_object_t;
    l_keys    json_key_list;
    l_fd      json_object_t;
    l_spec    json_object_t;
    l_item    json_object_t;
    l_items   json_array_t := json_array_t();
    l_msg     json_object_t := json_object_t();
  begin
    if l_rec is null then
      raise_application_error(-20025, 'Summary "' || str(p_node, 'id') || '" needs a loaded record "' || l_alias || '".');
    end if;
    l_cn      := change_node(c, l_alias);
    l_changes := record_changes(l_rec);
    l_keys    := l_changes.get_keys;
    if l_keys is not null then
      for i in 1 .. l_keys.count loop
        l_fd := null;
        l_spec := null;
        if l_cn is not null then l_fd := field_def(l_cn, l_keys(i)); end if;
        if l_fd is not null then l_spec := eff_spec(c, input_spec(l_fd)); end if;
        l_item := json_object_t();
        l_item.put('slot', l_alias || '.' || l_keys(i));
        l_item.put('label', case when l_fd is not null then field_label(l_fd) else l_keys(i) end);
        l_item.put('before', display_for(l_spec, str(obj(l_rec, 'original'), l_keys(i))));
        l_item.put('after', display_for(l_spec, str(obj(l_rec, 'current'), l_keys(i))));
        l_item.put('editable', l_fd is not null);
        l_items.append(l_item);
      end loop;
    end if;
    l_msg.put('type', 'changes');
    l_msg.put('text', interpolate(nvl(str(p_node, 'text'),
      case when l_items.get_size > 0 then 'Please confirm these changes:' else 'You haven''t changed anything yet.' end), vals(c)));
    l_msg.put('items', l_items);
    c.out_msgs.append(l_msg);
  end add_changes;

  procedure add_summary (c in out nocopy t_ctx, p_node in json_object_t) is
    l_msg    json_object_t := json_object_t();
    l_items  json_array_t  := json_array_t();
    l_fields json_array_t;
    l_nodes  json_array_t;
    l_n      json_object_t;
    l_seen   varchar2(32767) := ',';

    procedure add_item (p_slot in varchar2) is
      l_nid  varchar2(200) := str(c.slot_nodes, p_slot);
      l_item json_object_t := json_object_t();
    begin
      if instr(l_seen, ',' || p_slot || ',') > 0 then return; end if;
      l_seen := l_seen || p_slot || ',';
      l_item.put('slot', p_slot);
      l_item.put('label', case when l_nid is not null then nvl(str(get_node(c, l_nid), 'label'), p_slot) else p_slot end);
      l_item.put('display', display_value(c, p_slot));
      l_item.put('editable', l_nid is not null);
      l_items.append(l_item);
    end add_item;
  begin
    if str(p_node, 'mode') = 'changes' then
      add_changes(c, p_node);
      return;
    end if;
    if p_node.has('fields') then
      l_fields := p_node.get_array('fields');
      for i in 0 .. l_fields.get_size - 1 loop add_item(l_fields.get_string(i)); end loop;
    else
      l_nodes := c.flow.get_array('nodes');
      for i in 0 .. l_nodes.get_size - 1 loop
        l_n := treat(l_nodes.get(i) as json_object_t);
        if str(l_n, 'type') in ('ask', 'repeat') and str(c.slots, str(l_n, 'slot')) is not null then
          add_item(str(l_n, 'slot'));
        end if;
      end loop;
    end if;
    l_msg.put('type', 'summary');
    l_msg.put('text', interpolate(nvl(str(p_node, 'text'), 'Here''s what I have. Please check:'), vals(c)));
    l_msg.put('items', l_items);
    c.out_msgs.append(l_msg);
  end add_summary;

  procedure add_record_card (c in out nocopy t_ctx, p_node in json_object_t) is
    l_rec   json_object_t := obj(c.records, str(p_node, 'record'));
    l_flds  json_array_t  := arr(p_node, 'fields');
    l_fd    json_object_t;
    l_item  json_object_t;
    l_items json_array_t  := json_array_t();
    l_msg   json_object_t := json_object_t();
  begin
    for i in 0 .. l_flds.get_size - 1 loop
      l_fd := treat(l_flds.get(i) as json_object_t);
      l_item := json_object_t();
      l_item.put('slot', str(p_node, 'record') || '.' || str(l_fd, 'field'));
      l_item.put('label', field_label(l_fd));
      l_item.put('display', display_for(eff_spec(c, input_spec(l_fd)), str(obj(l_rec, 'current'), str(l_fd, 'field'))));
      l_items.append(l_item);
    end loop;
    l_msg.put('type', 'record');
    l_msg.put('text', interpolate(nvl(str(p_node, 'cardTitle'), 'Current details'), vals(c)));
    l_msg.put('items', l_items);
    c.out_msgs.append(l_msg);
  end add_record_card;

  -- Re-check every answered question before submit. Returns the failing node id (or null).
  function revalidate (c in out nocopy t_ctx, p_err out varchar2) return varchar2 is
    l_nodes  json_array_t := c.flow.get_array('nodes');
    l_n      json_object_t;
    l_slot   varchar2(200);
    l_parsed json_object_t;
    l_items  json_array_t;
    l_it     json_object_t;
    l_flds   json_array_t;
    l_f      json_object_t;
    l_v      json_object_t;
  begin
    for i in 0 .. l_nodes.get_size - 1 loop
      l_n := treat(l_nodes.get(i) as json_object_t);
      l_slot := str(l_n, 'slot');
      if str(l_n, 'type') = 'repeat' and in_history(c, str(l_n, 'id')) then
        l_items := rp_items(c, l_n);
        if l_items.get_size < rp_min(l_n) then
          l_v := json_object_t();
          l_v.put('min', rp_min(l_n));
          p_err := interpolate(nvl(str(obj(l_n, 'prompts'), 'tooFew'), 'Please add at least {{min}}.'), l_v);
          return str(l_n, 'id');
        end if;
        l_flds := arr(l_n, 'fields');
        for j in 0 .. l_items.get_size - 1 loop
          l_it := treat(l_items.get(j) as json_object_t);
          for k in 0 .. l_flds.get_size - 1 loop
            l_f := treat(l_flds.get(k) as json_object_t);
            l_parsed := json_object_t();
            if l_it.has(str(l_f, 'field')) then l_parsed.put('value', l_it.get(str(l_f, 'field'))); else l_parsed.put_null('value'); end if;
            p_err := validate(c, rp_field_node(l_n, l_f), l_parsed);
            if p_err is not null then
              p_err := item_title(c, l_n, l_it, j) || ': ' || p_err;
              return str(l_n, 'id');
            end if;
          end loop;
        end loop;
      end if;
      if str(l_n, 'type') = 'ask' and str(c.slots, l_slot) is not null then
        l_parsed := json_object_t();
        l_parsed.put('value', c.slots.get(l_slot));
        p_err := validate(c, l_n, l_parsed);
        if p_err is not null then return str(l_n, 'id'); end if;
      end if;
    end loop;
    return null;
  end revalidate;

  procedure progress (c in out nocopy t_ctx, p_done out pls_integer, p_total out pls_integer) is
    l_id    varchar2(200) := str(c.flow, 'start');
    l_v     json_object_t := vals(c);
    l_n     json_object_t;
    l_type  varchar2(30);
    l_steps pls_integer := 0;
  begin
    p_done := 0; p_total := 0;
    while l_id is not null and l_steps < c_max_steps loop
      l_steps := l_steps + 1;
      exit when not c.nodes.has(l_id);
      l_n := c.nodes.get_object(l_id);
      l_type := str(l_n, 'type');
      if l_type = 'ask' then
        p_total := p_total + 1;
        if str(c.slots, str(l_n, 'slot')) is not null then p_done := p_done + 1; end if;
        l_id := str(l_n, 'next');
      elsif l_type = 'findRecord' then
        p_total := p_total + 1;
        if c.records.has(str(l_n, 'as')) then p_done := p_done + 1; end if;
        l_id := str(l_n, 'found');
      elsif l_type = 'changeFields' then
        p_total := p_total + 1;
        if key_count(record_changes(obj(c.records, str(l_n, 'record')))) > 0 then p_done := p_done + 1; end if;
        l_id := str(l_n, 'done');
      elsif l_type = 'repeat' then
        p_total := p_total + 1;
        if rp_complete(c, l_n) then p_done := p_done + 1; end if;
        l_id := str(l_n, 'next');
      elsif l_type = 'condition' then
        l_id := pick_branch(l_v, l_n);
      elsif l_type = 'verify' then
        l_id := str(l_n, 'verified');
      elsif l_type = 'bulkUpdate' then
        l_id := str(l_n, 'done');
      elsif l_type in ('message', 'lookup', 'set') then
        l_id := str(l_n, 'next');
      else
        exit;
      end if;
    end loop;
    if str(c.state, 'status') = 'completed' then p_done := p_total; end if;
  end progress;

  procedure run (c in out nocopy t_ctx, p_start in varchar2) is
    l_id      varchar2(200) := p_start;
    l_node    json_object_t;
    l_type    varchar2(30);
    l_slot    varchar2(200);
    l_res     json_object_t;
    l_bad     varchar2(200);
    l_err     varchar2(4000);
    l_await   boolean;
    l_steps   pls_integer := 0;
    l_skip    boolean;
    l_stale   boolean;
    l_spec    json_object_t;
    l_prev    varchar2(200);
  begin
    while l_id is not null loop
      l_steps := l_steps + 1;
      if l_steps > c_max_steps then
        raise_application_error(-20020, 'Flow exceeded ' || c_max_steps || ' steps. Check it for a loop.');
      end if;
      l_node := get_node(c, l_id);
      l_type := str(l_node, 'type');
      dbg_kv(c, 'node', l_id, 'type', l_type, 'replay', case when c.replay then 'true' end);

      case l_type
        when 'message' then
          if not c.replay then add_msg(c, 'text', interpolate(str(l_node, 'text'), vals(c))); end if;
          l_id := str(l_node, 'next');

        when 'set' then
          apply_set(c, l_node);
          l_id := str(l_node, 'next');

        when 'condition' then
          l_prev := l_id;
          l_id := pick_branch(vals(c), l_node);
          dbg_kv(c, 'branch', l_prev, 'next', l_id);

        when 'repeat' then
          if (c.replay or get_bool(l_node, 'skipIfFilled')) and nvl(c.force_ask, '~') <> l_id and rp_complete(c, l_node) then
            l_id := str(l_node, 'next');
          else
            if c.replay then c.state.put('editing', true); end if;
            c.replay := false;
            c.force_ask := null;
            c.state.put('current', l_id);
            if str(l_node, 'prompt') is not null then
              add_msg(c, 'text', interpolate(str(l_node, 'prompt'), rp_vals(c, l_node)));
            end if;
            if rp_items(c, l_node).get_size = 0 and rp_state(c, l_id) is null and rp_min(l_node) > 0 then
              rp_start(c, l_node);
            else
              rp_show(c, l_node);
            end if;
            return;
          end if;

        when 'bulkUpdate' then
          c.replay := false;
          l_id := run_bulk(c, l_node, l_await);
          if l_await then return; end if;
          if l_id is null and str(c.state, 'status') = 'failed' then return; end if;

        when 'lookup' then
          if c.replay then
            l_id := str(l_node, 'next');
          else
            l_res := conn(c, l_id, str(l_node, 'connector'), payload(c, l_id));
            merge_slots(c, l_res);
            add_msg(c, 'text', str(l_res, 'message'));
            if str(l_res, 'found') = 'false' and l_node.has('onNotFound') then
              l_id := str(l_node, 'onNotFound');
            else
              l_id := str(l_node, 'next');
            end if;
          end if;

        when 'ask' then
          l_slot  := str(l_node, 'slot');
          l_skip  := (c.replay or get_bool(l_node, 'skipIfFilled'))
                     and str(c.slots, l_slot) is not null
                     and nvl(c.force_ask, '~') <> l_id;
          l_stale := false;
          -- a lookup answer the list no longer offers (an answer it depends on changed) is asked again
          if l_skip and str(input_spec(l_node), 'optionsFrom') is not null then
            if not still_offered(c, l_node) then
              l_skip  := false;
              l_stale := true;
            end if;
          end if;
          if l_skip then
            dbg_kv(c, 'skip', l_id, 'reason', 'answered');
            l_id := str(l_node, 'next');
          else
            -- a question reached while replaying an edit keeps the replay going after it's answered
            if c.replay then c.state.put('editing', true); end if;
            c.replay := false;
            c.force_ask := null;
            c.state.put('current', l_id);
            add_msg(c, 'text', interpolate(str(l_node, 'prompt'), vals(c)));
            if str(input_spec(l_node), 'optionsFrom') is not null then
              l_spec := eff_spec(c, input_spec(l_node));
              if arr(l_spec, 'options').get_size = 0 then
                add_msg(c, 'error', nvl(str(l_spec, 'emptyMessage'), 'There''s nothing to choose from here right now.'));
              elsif l_stale then
                add_msg(c, 'error', nvl(str(l_spec, 'staleMessage'),
                        'Your earlier answer is no longer one of the options. Please choose again.'));
              end if;
            end if;
            return;
          end if;

        when 'summary' then
          c.replay := false;
          c.state.put('current', l_id);
          add_summary(c, l_node);
          return;

        when 'submit' then
          l_bad := revalidate(c, l_err);
          if l_bad is not null then
            add_msg(c, 'error', l_err);
            c.state.put('editing', true);
            c.force_ask := l_bad;
            l_id := l_bad;
          else
            l_res := conn(c, l_id, str(l_node, 'connector'), payload(c, l_id));
            merge_slots(c, l_res);
            if str(l_res, 'ok') = 'true' then
              add_msg(c, 'text', str(l_res, 'message'));
              l_id := nvl(str(l_node, 'onSuccess'), str(l_node, 'next'));
            else
              add_msg(c, 'error', nvl(str(l_res, 'message'), 'Sorry, the submission failed.'));
              l_id := route(c, str(l_node, 'onError'));
              if l_id is null then return; end if;
            end if;
          end if;

        when 'verify' then
          l_id := run_verify(c, l_node, l_await);
          if l_await then return; end if;
          if l_id is null and str(c.state, 'status') = 'failed' then return; end if;

        when 'findRecord' then
          if c.replay and c.records.has(str(l_node, 'as')) then
            l_id := str(l_node, 'found');
          else
            c.replay := false;
            l_id := run_find(c, l_node, l_await);
            if l_await then return; end if;
          end if;

        when 'changeFields' then
          if not c.records.has(str(l_node, 'record')) then
            raise_application_error(-20026, 'Change fields "' || l_id || '" needs a loaded record "' || str(l_node, 'record') || '".');
          end if;
          c.replay := false;
          c.state.put('current', l_id);
          c.state.put_null('editingField');
          add_record_card(c, l_node);
          add_msg(c, 'text', interpolate(nvl(str(l_node, 'prompt'), 'What would you like to change?'), vals(c)));
          return;

        when 'saveChanges' then
          l_id := run_save(c, l_node, l_await);
          if l_await then return; end if;
          if l_id is null and str(c.state, 'status') = 'failed' then return; end if;

        when 'end' then
          add_msg(c, 'success', interpolate(str(l_node, 'text'), vals(c)));
          c.state.put('status', 'completed');
          c.state.put_null('current');
          return;

        else
          raise_application_error(-20021, 'Unknown node type "' || l_type || '" (' || l_id || ').');
      end case;
    end loop;
    if str(c.state, 'status') = 'in_progress' then
      c.state.put('status', 'completed');
      c.state.put_null('current');
    end if;
  end run;

  function build_turn (c in out nocopy t_ctx) return clob is
    l_turn    json_object_t := json_object_t();
    l_aw      json_object_t;
    l_node    json_object_t;
    l_type    varchar2(30);
    l_updates json_array_t := json_array_t();
    l_u       json_object_t;
    l_prog    json_object_t := json_object_t();
    l_bind    json_object_t;
    l_slot    varchar2(200);
    l_cur     varchar2(200) := str(c.state, 'current');
    l_view    json_object_t := vals(c);
    l_rec     json_object_t;
    l_fd      json_object_t;
    l_flds    json_array_t;
    l_items   json_array_t;
    l_item    json_object_t;
    l_res     json_array_t;
    l_r       json_object_t;
    l_field   varchar2(100);
    l_edit    boolean;
    l_done    pls_integer;
    l_total   pls_integer;
    l_spec    json_object_t;
    l_acts    json_array_t;
    l_act     json_object_t;
    l_rs      json_object_t;
    l_ritems  json_array_t;
    l_bv      json_object_t;
  begin
    if str(c.state, 'status') = 'in_progress' and l_cur is not null then
      l_node := get_node(c, l_cur);
      l_type := str(l_node, 'type');
      l_aw := json_object_t();
      l_aw.put('nodeId', l_cur);
      l_field := str(c.state, 'editingField');

      if l_type = 'ask' then
        l_slot := str(l_node, 'slot');
        l_aw.put('type', 'ask');
        l_aw.put('slot', l_slot);
        l_aw.put('label', nvl(str(l_node, 'label'), l_slot));
        l_aw.put('input', turn_input(c, input_spec(l_node)));
        if str(c.slots, l_slot) is not null then l_aw.put('value', c.slots.get(l_slot)); else l_aw.put_null('value'); end if;

      elsif l_type = 'summary' then
        l_aw.put('type', 'summary');
        l_aw.put('confirmLabel', nvl(str(l_node, 'confirmLabel'), 'Confirm & submit'));

      elsif l_type = 'verify' then
        l_aw.put('type', 'ask');
        l_aw.put('slot', '#code');
        l_aw.put('label', nvl(str(l_node, 'label'), 'Code'));
        l_aw.put('secret', true);
        l_aw.put_null('value');
        l_spec := json_object_t();
        l_spec.put('kind', 'text');
        l_spec.put('inputMode', 'numeric');
        l_spec.put('autocomplete', 'one-time-code');
        l_spec.put('maxLength', opt_int(l_node, 'codeLength', 6, 4, 10));
        l_spec.put('placeholder', nvl(str(l_node, 'placeholder'), opt_int(l_node, 'codeLength', 6, 4, 10) || '-digit code'));
        l_aw.put('input', l_spec);
        l_act := json_object_t();
        l_act.put('command', 'resend');
        l_act.put('label', nvl(str(l_node, 'resendLabel'), 'Send a new code'));
        l_acts := json_array_t();
        l_acts.append(l_act);
        l_aw.put('actions', l_acts);

      elsif l_type = 'findRecord' then
        l_aw.put('type', 'pick');
        l_items := json_array_t();
        if c.results.has(l_cur) then
          l_res := c.results.get_array(l_cur);
          for i in 0 .. l_res.get_size - 1 loop
            l_r := treat(l_res.get(i) as json_object_t);
            l_item := json_object_t();             -- never the key: only the opaque token
            l_item.put('token', str(l_r, 'token'));
            l_item.put('title', str(l_r, 'title'));
            l_item.put('subtitle', str(l_r, 'subtitle'));
            l_items.append(l_item);
          end loop;
        end if;
        l_aw.put('items', l_items);
        l_aw.put('allowNone', nvl(str(l_node, 'allowNone'), 'true') <> 'false');
        l_aw.put('noneLabel', nvl(str(l_node, 'noneLabel'), 'None of these'));

      elsif l_type = 'changeFields' then
        l_rec := obj(c.records, str(l_node, 'record'));
        if l_field is not null then
          l_fd := field_def(l_node, l_field);
          l_aw.put('type', 'ask');
          l_aw.put('slot', str(l_node, 'record') || '.' || l_field);
          l_aw.put('label', field_label(l_fd));
          l_aw.put('input', turn_input(c, input_spec(l_fd)));
          if str(obj(l_rec, 'current'), l_field) is not null then
            l_aw.put('value', obj(l_rec, 'current').get(l_field));
          else
            l_aw.put_null('value');
          end if;
          l_aw.put('sub', true);
        else
          l_aw.put('type', 'fieldMenu');
          l_aw.put('doneLabel', nvl(str(l_node, 'doneLabel'), 'Done'));
          l_items := json_array_t();
          l_flds  := arr(l_node, 'fields');
          for i in 0 .. l_flds.get_size - 1 loop
            l_fd   := treat(l_flds.get(i) as json_object_t);
            l_edit := field_editable(c, l_node, l_fd);
            l_item := json_object_t();
            l_item.put('field', str(l_fd, 'field'));
            l_item.put('label', field_label(l_fd));
            l_item.put('display', display_for(eff_spec(c, input_spec(l_fd)), str(obj(l_rec, 'current'), str(l_fd, 'field'))));
            l_item.put('changed', not same(str(obj(l_rec, 'current'), str(l_fd, 'field')), str(obj(l_rec, 'original'), str(l_fd, 'field'))));
            l_item.put('editable', l_edit);
            if l_edit then l_item.put_null('reason');
            else l_item.put('reason', nvl(str(l_fd, 'lockedMessage'), 'This field cannot be changed right now.'));
            end if;
            l_items.append(l_item);
          end loop;
          l_aw.put('fields', l_items);
        end if;

      elsif l_type = 'repeat' then
        l_rs     := rp_state(c, l_cur);
        l_ritems := rp_items(c, l_node);
        if l_rs is not null then
          l_fd := treat(arr(l_node, 'fields').get(nvl(to_num(str(l_rs, 'field')), 0)) as json_object_t);
          l_aw.put('type', 'ask');
          l_aw.put('slot', str(l_node, 'slot') || '.' || str(l_fd, 'field'));
          l_aw.put('label', field_label(l_fd));
          l_aw.put('input', turn_input(c, input_spec(l_fd)));
          l_aw.put_null('value');
          l_aw.put('item', l_ritems.get_size + 1);
        else
          l_aw.put('type', 'listMenu');
          l_aw.put('itemLabel', nvl(str(l_node, 'itemLabel'), 'item'));
          l_items := json_array_t();
          for i in 0 .. l_ritems.get_size - 1 loop
            l_item := json_object_t();
            l_item.put('index', i);
            l_item.put('title', item_title(c, l_node, treat(l_ritems.get(i) as json_object_t), i));
            l_items.append(l_item);
          end loop;
          l_aw.put('items', l_items);
          l_aw.put('canAdd', l_ritems.get_size < rp_max(l_node));
          l_aw.put('canDone', l_ritems.get_size >= rp_min(l_node));
          l_aw.put('addLabel', case when l_ritems.get_size > 0 then nvl(str(l_node, 'addLabel'), 'Add another')
                                    else nvl(str(l_node, 'firstAddLabel'), 'Add') end);
          l_aw.put('doneLabel', nvl(str(l_node, 'doneLabel'), 'Done'));
          l_aw.put('removeLabel', nvl(str(l_node, 'removeLabel'), 'Remove'));
        end if;

      elsif l_type = 'bulkUpdate' and bulk_state(c, l_cur) is not null then
        l_bv := vals(c);
        l_bv.put('count', to_num(str(bulk_state(c, l_cur), 'count')));
        l_aw.put('type', 'confirm');
        l_aw.put('confirmLabel', interpolate(nvl(str(l_node, 'confirmLabel'), 'Update {{count}}'), l_bv));
        l_aw.put('cancelLabel', nvl(str(l_node, 'cancelLabel'), 'Cancel'));
        l_aw.put('danger', true);
      end if;
    end if;

    l_bind := obj(c.flow, 'bindings');
    for i in 0 .. c.updates.get_size - 1 loop
      l_slot := c.updates.get_string(i);
      l_u := json_object_t();
      l_u.put('slot', l_slot);
      if str(l_view, l_slot) is not null then l_u.put('value', l_view.get(l_slot)); else l_u.put_null('value'); end if;
      l_u.put('display', display_value(c, l_slot));
      if l_bind is not null and l_bind.has(l_slot) then l_u.put('binding', l_bind.get_object(l_slot)); else l_u.put_null('binding'); end if;
      l_updates.append(l_u);
    end loop;

    progress(c, l_done, l_total);
    l_prog.put('done', l_done);
    l_prog.put('total', l_total);

    l_turn.put('sessionId', c.session_id);
    l_turn.put('flowId', str(c.state, 'flowId'));
    l_turn.put('version', to_num(str(c.state, 'version')));
    l_turn.put('status', str(c.state, 'status'));
    l_turn.put('messages', c.out_msgs);
    if l_aw is not null then l_turn.put('await', l_aw); else l_turn.put_null('await'); end if;
    l_turn.put('fieldUpdates', l_updates);
    l_turn.put('progress', l_prog);
    l_turn.put('canGoBack', c.history.get_size > 0 or str(c.state, 'editingField') is not null
                            or (l_cur is not null and rp_state(c, l_cur) is not null));
    return l_turn.to_clob;
  end build_turn;

  ------------------------------------------------------------------------------
  -- persistence
  ------------------------------------------------------------------------------
  procedure log_event (p_session_id in varchar2, p_dir in varchar2, p_node in varchar2, p_payload in clob) is
  begin
    insert into fc_events (session_id, direction, node_id, payload)
    values (p_session_id, p_dir, p_node, p_payload);
  end log_event;

  procedure init_ctx (c in out nocopy t_ctx) is
  begin
    c.out_msgs  := json_array_t();
    c.updates   := json_array_t();
    c.records   := json_object_t();
    c.results   := json_object_t();
    c.replay    := false;
    c.force_ask := null;
    c.repeat_slots := json_object_t();
    g_lov_cache := json_object_t();
  end init_ctx;

  procedure load_flow (c in out nocopy t_ctx, p_flow_id in varchar2, p_version in number) is
    l_def   clob;
    l_nodes json_array_t;
    l_node  json_object_t;
    l_type  varchar2(30);
  begin
    select definition into l_def
      from fc_flow_versions
     where flow_id = p_flow_id and version = p_version;
    c.flow := json_object_t.parse(l_def);
    c.nodes := json_object_t();
    c.slot_nodes := json_object_t();
    c.change_nodes := json_object_t();
    c.repeat_slots := json_object_t();
    l_nodes := c.flow.get_array('nodes');
    for i in 0 .. l_nodes.get_size - 1 loop
      l_node := treat(l_nodes.get(i) as json_object_t);
      l_type := str(l_node, 'type');
      c.nodes.put(str(l_node, 'id'), l_node);
      if l_type = 'repeat' and not c.repeat_slots.has(str(l_node, 'slot')) then
        c.repeat_slots.put(str(l_node, 'slot'), str(l_node, 'id'));
      end if;
      if l_type in ('ask', 'repeat') and not c.slot_nodes.has(str(l_node, 'slot')) then
        c.slot_nodes.put(str(l_node, 'slot'), str(l_node, 'id'));
      elsif l_type = 'changeFields' and not c.change_nodes.has(str(l_node, 'record')) then
        c.change_nodes.put(str(l_node, 'record'), str(l_node, 'id'));
      end if;
    end loop;
  end load_flow;

  -- Context values whose key is a known slot (asked, bound, or declared in the flow's "context"
  -- list) prefill that slot. All of them are also readable as {{context.<name>}}.
  procedure seed_context (c in out nocopy t_ctx) is
    l_ctx  json_object_t := obj(c.state, 'context');
    l_bind json_object_t := obj(c.flow, 'bindings');
    l_decl json_array_t  := arr(c.flow, 'context');
    l_names varchar2(32767) := ',';
    l_keys json_key_list;
  begin
    if l_ctx is null then return; end if;
    for i in 0 .. l_decl.get_size - 1 loop
      if l_decl.get(i).is_object then
        l_names := l_names || str(treat(l_decl.get(i) as json_object_t), 'name') || ',';
      else
        l_names := l_names || el_str(l_decl.get(i)) || ',';
      end if;
    end loop;
    l_keys := l_ctx.get_keys;
    if l_keys is null then return; end if;
    for i in 1 .. l_keys.count loop
      if str(l_ctx, l_keys(i)) is not null and l_keys(i) <> 'app_user'
         and (c.slot_nodes.has(l_keys(i)) or (l_bind is not null and l_bind.has(l_keys(i)))
              or instr(l_names, ',' || l_keys(i) || ',') > 0) then
        c.slots.put(l_keys(i), l_ctx.get(l_keys(i)));
      end if;
    end loop;
  end seed_context;

  procedure save_session (c in out nocopy t_ctx) is
    l_state  clob;
    l_status varchar2(20);
  begin
    c.state.put('slots', c.slots);
    c.state.put('history', c.history);
    c.state.put('records', c.records);
    c.state.put('results', c.results);
    l_state  := c.state.to_clob;
    l_status := str(c.state, 'status');
    update fc_sessions
       set state = l_state, status = l_status,
           updated_at = systimestamp, expires_at = systimestamp + c_ttl
     where session_id = c.session_id;
  end save_session;

  procedure load_session (c in out nocopy t_ctx, p_session_id in varchar2) is
    l_flow_id fc_sessions.flow_id%type;
    l_version fc_sessions.version%type;
    l_state   clob;
    l_apex    fc_sessions.apex_session%type;
    l_expires fc_sessions.expires_at%type;
  begin
    begin
      select flow_id, version, state, apex_session, expires_at
        into l_flow_id, l_version, l_state, l_apex, l_expires
        from fc_sessions
       where session_id = p_session_id
         for update;
    exception when no_data_found then
      raise_application_error(-20002, 'Session not found or expired.');
    end;
    if l_expires < systimestamp then
      raise_application_error(-20002, 'Session not found or expired.');
    end if;
    if l_apex is not null and l_apex <> nvl(sys_context('APEX$SESSION', 'APP_SESSION'), '-') then
      raise_application_error(-20003, 'This conversation belongs to another session.');
    end if;

    init_ctx(c);
    c.session_id := p_session_id;
    load_flow(c, l_flow_id, l_version);   -- pinned version
    c.state := json_object_t.parse(l_state);
    c.slots   := obj(c.state, 'slots');
    c.records := obj(c.state, 'records');
    c.results := obj(c.state, 'results');
    if c.slots   is null then c.slots   := json_object_t(); end if;   -- NVL isn't defined for object types
    if c.records is null then c.records := json_object_t(); end if;
    if c.results is null then c.results := json_object_t(); end if;
    if c.state.has('history') then c.history := c.state.get_array('history'); else c.history := json_array_t(); end if;
    fc_data.set_verified(str(c.state, 'verifiedLast'));   -- package state may be left over from another request
    if dbg_rows(c) then g_dbg_sid := p_session_id; else g_dbg_sid := null; end if;
  end load_session;

  ------------------------------------------------------------------------------
  -- input handlers for data nodes
  ------------------------------------------------------------------------------
  procedure handle_pick (c in out nocopy t_ctx, p_node in json_object_t, p_in in json_object_t) is
    l_id      varchar2(200) := str(p_node, 'id');
    l_results json_array_t;
    l_r       json_object_t;
    l_key     varchar2(4000);
    l_token   varchar2(100);
    l_val     varchar2(4000) := lower(trim(str(p_in, 'value')));
    l_next    varchar2(200);
  begin
    if c.results.has(l_id) then l_results := c.results.get_array(l_id); else l_results := json_array_t(); end if;

    if p_in.has('pick') and p_in.get('pick').is_null then
      c.results.remove(l_id);
      add_msg(c, 'text', nvl(str(obj(p_node, 'prompts'), 'cancelled'), 'Okay.'));
      run(c, nvl(str(p_node, 'cancelled'), str(p_node, 'notFound')));
      return;
    end if;

    l_token := str(p_in, 'pick');
    for i in 0 .. l_results.get_size - 1 loop
      l_r := treat(l_results.get(i) as json_object_t);
      if (l_token is not null and str(l_r, 'token') = l_token)
         or (l_token is null and l_val is not null
             and (l_val = to_char(i + 1) or instr(lower(str(l_r, 'title')), l_val) > 0)) then
        l_key := str(l_r, 'key');
        exit;
      end if;
    end loop;

    if l_key is null then
      add_msg(c, 'error', 'Please choose one of the records shown.');
      return;
    end if;
    c.history.append(l_id);
    l_next := load_record(c, p_node, l_key);
    run(c, l_next);
  end handle_pick;

  procedure handle_verify (c in out nocopy t_ctx, p_node in json_object_t, p_in in json_object_t, p_cmd in varchar2) is
    l_id      varchar2(200) := str(p_node, 'id');
    l_slot    varchar2(200) := str(p_node, 'slot');
    l_prompts json_object_t := obj(p_node, 'prompts');
    l_all     json_object_t := st_obj(c, 'verify');
    l_pend    json_object_t := obj(l_all, l_id);
    l_max_att pls_integer   := opt_int(p_node, 'maxAttempts', 3, 1);
    l_max_rs  pls_integer   := opt_int(p_node, 'maxResends', 2, 0);
    l_code    varchar2(4000) := regexp_replace(str(p_in, 'value'), '\s', '');
    l_tries   pls_integer;
    l_v       json_object_t;
    l_vf      json_object_t;

    procedure give_up is
      l_dummy varchar2(1);
    begin
      if str(p_node, 'failed') is not null then run(c, str(p_node, 'failed')); else l_dummy := failed(c); end if;
    end give_up;

    procedure forget is
    begin
      l_all.remove(l_id);
      c.state.put('verify', l_all);
    end forget;
  begin
    if p_cmd = 'resend' or l_pend is null then
      if l_pend is not null and nvl(to_num(str(l_pend, 'sends')), 0) > l_max_rs then
        add_msg(c, 'error', nvl(str(l_prompts, 'tooManySends'), 'I can''t send any more codes. Please use the last one I sent.'));
        return;
      end if;
      if not send_code(c, p_node) then give_up; return; end if;
      add_msg(c, 'text', interpolate(nvl(str(l_prompts, 'resent'), 'I''ve sent a new code to {{' || l_slot || '}}.'), verify_vals(c, p_node)));
      return;
    end if;

    if l_code is null then
      add_msg(c, 'error', 'Please enter the code.');
      return;
    end if;

    if now_secs > to_num(str(l_pend, 'expiresAt')) then
      if nvl(to_num(str(l_pend, 'sends')), 0) > l_max_rs then
        forget;
        add_msg(c, 'error', nvl(str(l_prompts, 'locked'), 'That code has expired and I can''t send another one.'));
        give_up;
        return;
      end if;
      if not send_code(c, p_node) then give_up; return; end if;
      add_msg(c, 'error', interpolate(nvl(str(l_prompts, 'expired'),
        'That code has expired, so I''ve sent a new one to {{' || l_slot || '}}.'), verify_vals(c, p_node)));
      return;
    end if;

    if hash_code(c.session_id || ':' || l_id, l_code) <> str(l_pend, 'hash') then
      l_tries := nvl(to_num(str(l_pend, 'attempts')), 0) + 1;
      if l_max_att - l_tries <= 0 then
        forget;
        add_msg(c, 'error', nvl(str(l_prompts, 'locked'), 'That''s too many wrong codes, so I can''t continue.'));
        give_up;
        return;
      end if;
      l_pend.put('attempts', l_tries);
      l_all.put(l_id, l_pend);
      c.state.put('verify', l_all);
      l_v := verify_vals(c, p_node);
      l_v.put('remaining', l_max_att - l_tries);
      l_v.put('tries', case when l_max_att - l_tries = 1 then 'try' else 'tries' end);
      add_msg(c, 'error', interpolate(nvl(str(l_prompts, 'wrong'),
        'That code isn''t right. You have {{remaining}} more {{tries}}.'), l_v));
      return;
    end if;

    -- verified
    forget;
    l_vf := st_obj(c, 'verified');
    l_vf.put(l_slot, str(l_pend, 'target'));
    c.state.put('verified', l_vf);
    c.state.put('verifiedLast', str(l_pend, 'target'));
    fc_data.set_verified(str(l_pend, 'target'));
    c.history.append(l_id);
    add_msg(c, 'text', interpolate(str(l_prompts, 'success'), vals(c)));
    if get_bool(c.state, 'editing') then
      c.state.put('editing', false);
      c.replay := true;
      run(c, str(c.flow, 'start'));
    else
      run(c, str(p_node, 'verified'));
    end if;
  end handle_verify;

  procedure handle_change (c in out nocopy t_ctx, p_node in json_object_t, p_in in json_object_t, p_cmd in varchar2) is
    l_alias  varchar2(100) := str(p_node, 'record');
    l_rec    json_object_t := obj(c.records, l_alias);
    l_cur    json_object_t;
    l_field  varchar2(100) := str(c.state, 'editingField');
    l_fd     json_object_t;
    l_parsed json_object_t;
    l_err    varchar2(4000);
    l_val    varchar2(4000) := lower(trim(str(p_in, 'value')));
    l_flds   json_array_t;
    l_f      json_object_t;
  begin
    if l_field is not null then
      l_fd := field_def(p_node, l_field);
      l_parsed := parse_value(eff_spec(c, input_spec(l_fd)), str(p_in, 'value'));
      l_err := str(l_parsed, 'error');
      if l_err is null then l_err := validate(c, field_as_node(p_node, l_fd), l_parsed); end if;
      if l_err is not null then
        add_msg(c, 'error', l_err);
        return;
      end if;
      l_cur := obj(l_rec, 'current');
      l_cur.put(l_field, l_parsed.get('value'));
      l_rec.put('current', l_cur);
      c.records.put(l_alias, l_rec);
      touch(c, l_alias || '.' || l_field);
      c.state.put_null('editingField');
      add_msg(c, 'text', interpolate(nvl(str(p_node, 'againPrompt'), 'Got it. Anything else to change?'), vals(c)));
      return;
    end if;

    if p_cmd = 'done'
       or (str(p_in, 'field') is null and l_val is not null
           and l_val in ('done', lower(nvl(str(p_node, 'doneLabel'), 'done')))) then
      if key_count(record_changes(l_rec)) > 0 then
        run(c, str(p_node, 'done'));
      else
        add_msg(c, 'text', nvl(str(p_node, 'noChangesText'), 'You haven''t changed anything.'));
        run(c, nvl(str(p_node, 'noChanges'), str(p_node, 'done')));
      end if;
      return;
    end if;

    if str(p_in, 'field') is not null then
      l_fd := field_def(p_node, str(p_in, 'field'));
    elsif l_val is not null then
      l_flds := arr(p_node, 'fields');
      for i in 0 .. l_flds.get_size - 1 loop
        l_f := treat(l_flds.get(i) as json_object_t);
        if lower(field_label(l_f)) = l_val or str(l_f, 'field') = l_val then l_fd := l_f; exit; end if;
      end loop;
    end if;

    if l_fd is null then
      add_msg(c, 'error', 'Please choose a field to change, or ' || nvl(str(p_node, 'doneLabel'), 'Done') || '.');
    elsif not field_editable(c, p_node, l_fd) then
      add_msg(c, 'error', nvl(str(l_fd, 'lockedMessage'), 'This field cannot be changed right now.'));
    else
      prompt_field(c, p_node, l_fd);
    end if;
  end handle_change;

  procedure handle_repeat (c in out nocopy t_ctx, p_node in json_object_t, p_in in json_object_t, p_cmd in varchar2) is
    l_id     varchar2(200) := str(p_node, 'id');
    l_slot   varchar2(200) := str(p_node, 'slot');
    l_pr     json_object_t := obj(p_node, 'prompts');
    l_rs     json_object_t := rp_state(c, str(p_node, 'id'));
    l_items  json_array_t  := rp_items(c, p_node);
    l_new    json_array_t;
    l_flds   json_array_t  := arr(p_node, 'fields');
    l_f      json_object_t;
    l_fi     pls_integer;
    l_draft  json_object_t;
    l_parsed json_object_t;
    l_err    varchar2(4000);
    l_val    varchar2(4000) := lower(trim(str(p_in, 'value')));
    l_idx    pls_integer;
    l_x      json_object_t := json_object_t();
  begin
    if l_rs is not null then
      -- answering a field of the item being added
      l_fi := nvl(to_num(str(l_rs, 'field')), 0);
      l_f  := treat(l_flds.get(l_fi) as json_object_t);
      l_parsed := parse_value(eff_spec(c, input_spec(l_f)), str(p_in, 'value'));
      l_err := str(l_parsed, 'error');
      if l_err is null then l_err := validate(c, rp_field_node(p_node, l_f), l_parsed); end if;
      if l_err is not null then
        add_msg(c, 'error', l_err);
        return;
      end if;
      l_draft := obj(l_rs, 'draft');
      if l_draft is null then l_draft := json_object_t(); end if;
      l_draft.put(str(l_f, 'field'), l_parsed.get('value'));
      l_rs.put('draft', l_draft);
      if l_fi + 1 < l_flds.get_size then
        l_rs.put('field', l_fi + 1);
        rp_put(c, l_id, l_rs);
        rp_prompt_field(c, p_node);
        return;
      end if;
      l_items.append(l_draft);
      c.slots.put(l_slot, l_items);
      touch(c, l_slot);
      rp_put(c, l_id, null);
      l_x.put('title', item_title(c, p_node, l_draft, l_items.get_size - 1));
      add_msg(c, 'text', interpolate(nvl(str(l_pr, 'added'), 'Added {{title}}.'), rp_vals(c, p_node, l_x)));
      rp_show(c, p_node);
      return;
    end if;

    if p_cmd = 'add' or l_val = 'add' or l_val = lower(nvl(str(p_node, 'addLabel'), 'add another')) then
      if l_items.get_size >= rp_max(p_node) then
        add_msg(c, 'error', interpolate(nvl(str(l_pr, 'full'), 'That''s the most I can take ({{max}}). Tap Done to continue.'), rp_vals(c, p_node)));
      else
        rp_start(c, p_node);
      end if;
      return;
    end if;

    if p_cmd = 'remove' then
      l_idx := trunc(to_num(str(p_in, 'index')));
      if l_idx is null or l_idx < 0 or l_idx >= l_items.get_size then
        add_msg(c, 'error', 'There is no such item.');
        return;
      end if;
      l_x.put('title', item_title(c, p_node, treat(l_items.get(l_idx) as json_object_t), l_idx));
      l_new := json_array_t();
      for i in 0 .. l_items.get_size - 1 loop
        if i <> l_idx then l_new.append(l_items.get(i)); end if;
      end loop;
      if l_new.get_size > 0 then c.slots.put(l_slot, l_new); else c.slots.remove(l_slot); end if;
      touch(c, l_slot);
      add_msg(c, 'text', interpolate(nvl(str(l_pr, 'removed'), 'Removed {{title}}.'), l_x));
      rp_show(c, p_node);
      return;
    end if;

    if p_cmd = 'done' or l_val = 'done' or l_val = lower(nvl(str(p_node, 'doneLabel'), 'done')) then
      if l_items.get_size < rp_min(p_node) then
        add_msg(c, 'error', interpolate(nvl(str(l_pr, 'tooFew'), 'Please add at least {{min}}.'), rp_vals(c, p_node)));
        return;
      end if;
      c.history.append(l_id);
      if get_bool(c.state, 'editing') then
        c.state.put('editing', false);
        c.replay := true;
        run(c, str(c.flow, 'start'));
      else
        run(c, str(p_node, 'next'));
      end if;
      return;
    end if;

    add_msg(c, 'error', 'Tap ' || nvl(str(p_node, 'addLabel'), 'Add another') || ' or ' || nvl(str(p_node, 'doneLabel'), 'Done') || '.');
  end handle_repeat;

  -- Each record is read again and updated with its own version through FC_DATA, so the
  -- data source's updatable whitelist and row filter apply to every row.
  procedure handle_bulk (c in out nocopy t_ctx, p_node in json_object_t, p_in in json_object_t, p_cmd in varchar2) is
    l_id      varchar2(200) := str(p_node, 'id');
    l_src     varchar2(100) := str(p_node, 'source');
    l_b       json_object_t := bulk_state(c, str(p_node, 'id'));
    l_pr      json_object_t := obj(p_node, 'prompts');
    l_val     varchar2(4000) := lower(trim(str(p_in, 'value')));
    l_v       json_object_t := vals(c);
    l_keys    json_array_t;
    l_changes json_object_t;
    l_ck      json_key_list;
    l_key     varchar2(4000);
    l_row     json_object_t;
    l_cur     json_object_t;
    l_orig    json_object_t;
    l_ch      json_object_t;
    l_r       json_object_t;
    l_ok      pls_integer := 0;
    l_failed  pls_integer := 0;
    l_audit   json_object_t := json_object_t();
    l_next    varchar2(200);
    l_dummy   varchar2(1);
  begin
    if l_b is null then return; end if;
    l_v.put('count', to_num(str(l_b, 'count')));

    if p_cmd = 'cancel' or l_val in ('cancel', 'no') or l_val = lower(nvl(str(p_node, 'cancelLabel'), 'cancel')) then
      bulk_put(c, l_id, null);
      add_msg(c, 'text', nvl(str(l_pr, 'cancelled'), 'Okay, I didn''t change anything.'));
      l_next := coalesce(str(p_node, 'cancelled'), str(p_node, 'none'));
      if l_next is not null then run(c, l_next); else l_dummy := failed(c); end if;
      return;
    end if;

    if p_cmd = 'confirm' or l_val in ('confirm', 'yes', 'y', 'ok', 'go', 'update')
       or l_val = lower(interpolate(nvl(str(p_node, 'confirmLabel'), 'Update {{count}}'), l_v)) then
      c.history.append(l_id);
      l_keys    := arr(l_b, 'keys');
      l_changes := obj(l_b, 'changes');
      if l_changes is null then l_changes := json_object_t(); end if;
      l_ck := l_changes.get_keys;
      for i in 0 .. l_keys.get_size - 1 loop
        l_key := el_str(l_keys.get(i));
        l_row := fc_data.get_row(l_src, l_key, obj(c.state, 'context'));
        l_cur := obj(l_row, 'values');
        if l_cur is null then
          l_failed := l_failed + 1;
          continue;
        end if;
        l_orig := json_object_t();
        l_ch   := json_object_t();
        if l_ck is not null then
          for j in 1 .. l_ck.count loop
            if not same(str(l_cur, l_ck(j)), str(l_changes, l_ck(j))) then
              l_ch.put(l_ck(j), l_changes.get(l_ck(j)));
              if l_cur.has(l_ck(j)) then l_orig.put(l_ck(j), l_cur.get(l_ck(j))); else l_orig.put_null(l_ck(j)); end if;
            end if;
          end loop;
        end if;
        if key_count(l_ch) = 0 then
          l_ok := l_ok + 1;          -- already has the new values
          continue;
        end if;
        l_r := fc_data.update_row(l_src, l_key, str(l_row, 'version'), l_orig, l_ch, obj(c.state, 'context'));
        if str(l_r, 'status') = 'ok' then l_ok := l_ok + 1; else l_failed := l_failed + 1; end if;
      end loop;

      -- audit trail in the session transcript
      l_audit.put('action', 'bulkUpdate');
      l_audit.put('source', l_src);
      l_audit.put('changes', l_changes);
      l_audit.put('count', l_keys.get_size);
      l_audit.put('updated', l_ok);
      l_audit.put('failed', l_failed);
      log_ev(c, 'OUT', l_id, l_audit.to_clob);
      dbg_kv(c, 'bulkUpdate', l_id, 'updated', to_char(l_ok), 'failed', to_char(l_failed));

      bulk_put(c, l_id, null);
      l_v.put('updated', l_ok);
      l_v.put('failed', l_failed);
      if l_failed > 0 then
        add_msg(c, 'error', interpolate(nvl(str(l_pr, 'partial'),
          'I updated {{updated}} of {{count}} records. {{failed}} could not be changed (changed by someone else, or not allowed).'), l_v));
      else
        add_msg(c, 'text', interpolate(nvl(str(l_pr, 'done'), 'Done. I updated {{updated}} of {{count}} records.'), l_v));
      end if;
      run(c, case when l_failed > 0 and str(p_node, 'partial') is not null then str(p_node, 'partial') else str(p_node, 'done') end);
      return;
    end if;

    add_msg(c, 'error', 'Tap "' || interpolate(nvl(str(p_node, 'confirmLabel'), 'Update {{count}}'), l_v)
                        || '" to go ahead, or ' || nvl(str(p_node, 'cancelLabel'), 'Cancel') || '.');
  end handle_bulk;

  ------------------------------------------------------------------------------
  -- files: {"file": {name, mimeType, data(base64)}} -> FC_FILES; the slot keeps {id, name, size, mimeType}
  ------------------------------------------------------------------------------
  function parse_file (p_spec in json_object_t, p_file in json_object_t, p_blob out blob) return json_object_t is
    l_res  json_object_t := json_object_t();
    l_val  json_object_t := json_object_t();
    l_data clob;
    l_max  number := least(nvl(to_num(str(p_spec, 'maxSizeKb')), 5120), 20480) * 1024;
    l_size number;
    l_name varchar2(4000);
    l_type varchar2(100);
    l_ext  varchar2(100);
    l_acc  apex_t_varchar2 := apex_t_varchar2();
    l_arr  json_array_t;
    l_a    varchar2(200);
    l_list varchar2(4000);
    l_ok   boolean := true;

    function err (p in varchar2) return json_object_t is
      l json_object_t := json_object_t();
    begin
      p_blob := null;
      l.put('error', p);
      return l;
    end err;
  begin
    p_blob := null;
    if p_file is null or not p_file.has('data') then
      l_res.put_null('value');
      return l_res;
    end if;
    l_data := p_file.get_clob('data');
    if l_data is null or dbms_lob.getlength(l_data) = 0 then
      l_res.put_null('value');
      return l_res;
    end if;
    -- cheap check before decoding: base64 is 4/3 of the content
    if dbms_lob.getlength(l_data) * 3 / 4 > l_max + 3 then
      return err(nvl(str(p_spec, 'sizeMessage'), 'That file is too big. The limit is ' || size_text(l_max) || '.'));
    end if;
    begin
      p_blob := apex_web_service.clobbase642blob(l_data);
    exception when others then
      return err('That file could not be read. Please try again.');
    end;
    l_size := nvl(dbms_lob.getlength(p_blob), 0);
    if l_size = 0 then return err('That file is empty.'); end if;
    if l_size > l_max then
      return err(nvl(str(p_spec, 'sizeMessage'), 'That file is too big. The limit is ' || size_text(l_max) || '.'));
    end if;

    l_name := regexp_replace(nvl(str(p_file, 'name'), 'file'), '[\/:*?"<>|[:cntrl:]]', '_');
    if length(l_name) > 200 then l_name := substr(l_name, -200); end if;
    l_type := lower(substr(nvl(str(p_file, 'mimeType'), 'application/octet-stream'), 1, 100));
    l_ext  := lower(regexp_substr(l_name, '\.[^.]+$'));

    -- "accept": [".pdf", "image/<star>"] or ".pdf,image/<star>"  (<star> = an asterisk: any subtype)
    if p_spec.has('accept') then
      if p_spec.get('accept').is_array then
        l_arr := p_spec.get_array('accept');
        for i in 0 .. l_arr.get_size - 1 loop
          l_acc.extend;
          l_acc(l_acc.count) := el_str(l_arr.get(i));
        end loop;
      else
        l_acc := apex_string.split(str(p_spec, 'accept'), ',');
      end if;
    end if;
    for i in 1 .. l_acc.count loop
      l_a := lower(trim(l_acc(i)));
      if l_a is not null then
        if l_list is null then l_ok := false; end if;     -- there is a list: the file must match it
        l_list := l_list || case when l_list is not null then ', ' end || l_a;
        if (substr(l_a, 1, 1) = '.' and l_a = l_ext)
           or (substr(l_a, -2) = '/' || chr(42) and l_type like substr(l_a, 1, length(l_a) - 1) || '%')
           or l_a = l_type then
          l_ok := true;
        end if;
      end if;
    end loop;
    if not l_ok then
      return err(nvl(str(p_spec, 'typeMessage'), 'Please attach one of these file types: ' || l_list || '.'));
    end if;

    l_val.put('name', l_name);
    l_val.put('size', l_size);
    l_val.put('mimeType', l_type);
    l_res.put('value', l_val);
    return l_res;
  end parse_file;

  -- Stores the content in FC_FILES (removing the file this slot held before) and returns
  -- {"value": {id, name, size, mimeType}}.
  function save_file (c in out nocopy t_ctx, p_slot in varchar2, p_parsed in json_object_t, p_blob in blob) return json_object_t is
    l_val  json_object_t := obj(p_parsed, 'value');
    l_out  json_object_t := json_object_t();
    l_res  json_object_t := json_object_t();
    l_fid  varchar2(32)  := rawtohex(dbms_crypto.randombytes(16));
    l_sid  varchar2(32)  := c.session_id;
    l_old  varchar2(32)  := str(obj(c.slots, p_slot), 'id');
    l_name varchar2(400) := str(l_val, 'name');
    l_type varchar2(100) := str(l_val, 'mimeType');
    l_size number        := to_num(str(l_val, 'size'));
  begin
    insert into fc_files (file_id, session_id, slot, filename, mime_type, file_size, content)
    values (l_fid, l_sid, p_slot, l_name, l_type, l_size, p_blob);
    if l_old is not null then
      delete from fc_files where file_id = l_old and session_id = l_sid;
    end if;
    l_out.put('id', l_fid);
    l_out.put('name', l_name);
    l_out.put('size', l_size);
    l_out.put('mimeType', l_type);
    l_res.put('value', l_out);
    return l_res;
  end save_file;

  -- Is the value the user is answering right now a PII value?
  function current_is_pii (c in out nocopy t_ctx) return boolean is
    l_cur  varchar2(200) := str(c.state, 'current');
    l_node json_object_t;
    l_list json_array_t  := arr(c.flow, 'piiSlots');
    l_fd   json_object_t;
    l_rs   json_object_t;
  begin
    if l_cur is null or not c.nodes.has(l_cur) then return false; end if;
    l_node := get_node(c, l_cur);
    case str(l_node, 'type')
      when 'ask' then
        if pii_mode(l_node) is not null then return true; end if;
        for i in 0 .. l_list.get_size - 1 loop
          if el_str(l_list.get(i)) = str(l_node, 'slot') then return true; end if;
        end loop;
      when 'changeFields' then
        if str(c.state, 'editingField') is not null then
          l_fd := field_def(l_node, str(c.state, 'editingField'));
          return l_fd is not null and pii_mode(l_fd) is not null;
        end if;
      when 'repeat' then
        l_rs := rp_state(c, l_cur);
        if l_rs is not null then
          l_fd := treat(arr(l_node, 'fields').get(nvl(to_num(str(l_rs, 'field')), 0)) as json_object_t);
          return pii_mode(l_fd) is not null;
        end if;
      else null;
    end case;
    return false;
  end current_is_pii;

  -- The input as FC_EVENTS may show it: no one-time codes, no file contents, PII answers redacted.
  function input_for_log (c in out nocopy t_ctx, p_in in json_object_t) return clob is
    l_cur  varchar2(200) := str(c.state, 'current');
    l_out  json_object_t := json_object_t();
    l_keys json_key_list := p_in.get_keys;
    l_file json_object_t;
    l_lf   json_object_t;
    l_pii  boolean := current_is_pii(c);
  begin
    if l_keys is not null then
      for i in 1 .. l_keys.count loop
        if l_keys(i) = 'file' then
          l_file := obj(p_in, 'file');
          l_lf := json_object_t();
          l_lf.put('name', case when l_pii then '[redacted]' else str(l_file, 'name') end);
          l_lf.put('mimeType', str(l_file, 'mimeType'));
          l_lf.put('data', '(file content, not logged)');
          l_out.put('file', l_lf);
        elsif l_keys(i) = 'value' and l_cur is not null and c.nodes.has(l_cur)
              and str(get_node(c, l_cur), 'type') = 'verify' then
          l_out.put('value', '(one-time code, not logged)');
        elsif l_keys(i) = 'value' and l_pii then
          l_out.put('value', '[redacted]');
        else
          l_out.put(l_keys(i), p_in.get(l_keys(i)));
        end if;
      end loop;
    end if;
    return l_out.to_clob;
  end input_for_log;

  ------------------------------------------------------------------------------
  -- resume: the current question again, unchanged (after a page reload)
  ------------------------------------------------------------------------------
  procedure reprompt (c in out nocopy t_ctx) is
    l_cur  varchar2(200) := str(c.state, 'current');
    l_node json_object_t;
    l_v    json_object_t := vals(c);
    l_keys json_key_list := l_v.get_keys;
    l_fd   json_object_t;
    l_n    json_object_t;
    l_res  json_array_t;
  begin
    -- the page's fields were reset by the reload: send every value again
    if l_keys is not null then
      for i in 1 .. l_keys.count loop touch(c, l_keys(i)); end loop;
    end if;
    add_msg(c, 'text', interpolate(nvl(str(c.flow, 'resumeText'), 'Welcome back. Let''s carry on where we left off.'), l_v));
    if l_cur is null or not c.nodes.has(l_cur) then return; end if;
    l_node := get_node(c, l_cur);
    case str(l_node, 'type')
      when 'ask' then
        add_msg(c, 'text', interpolate(str(l_node, 'prompt'), l_v));
      when 'summary' then
        add_summary(c, l_node);
      when 'verify' then
        add_msg(c, 'text', interpolate(nvl(str(obj(l_node, 'prompts'), 'resume'),
          'Please enter the code I sent to {{' || str(l_node, 'slot') || '}}.'), verify_vals(c, l_node)));
      when 'findRecord' then
        if c.results.has(l_cur) then l_res := c.results.get_array(l_cur); else l_res := json_array_t(); end if;
        l_n := copy(l_v);
        l_n.put('count', l_res.get_size);
        add_msg(c, 'text', interpolate(nvl(str(obj(l_node, 'prompts'), 'many'), 'I found {{count}} matching records. Which one?'), l_n));
      when 'changeFields' then
        if str(c.state, 'editingField') is not null then l_fd := field_def(l_node, str(c.state, 'editingField')); end if;
        if l_fd is not null then
          prompt_field(c, l_node, l_fd);
        else
          add_record_card(c, l_node);
          add_msg(c, 'text', interpolate(nvl(str(l_node, 'prompt'), 'What would you like to change?'), l_v));
        end if;
      when 'repeat' then
        rp_show(c, l_node);
      when 'bulkUpdate' then
        if bulk_state(c, l_cur) is not null then bulk_confirm(c, l_node); end if;
      else
        null;
    end case;
  end reprompt;

  ------------------------------------------------------------------------------
  -- public API
  ------------------------------------------------------------------------------
  function start_session (p_flow_id in varchar2, p_context in clob default null,
                          p_version in number default null) return clob is
    c         t_ctx;
    l_version number;
    l_ctx     json_object_t;
    l_turn    clob;
    l_sid     varchar2(32);
  begin
    g_dbg_sid := null;
    if p_version is not null then
      -- a pinned version: it must be published (not a draft, not retired)
      select max(version) into l_version
        from fc_flow_versions
       where flow_id = p_flow_id and version = p_version and status = 'PUBLISHED';
      if l_version is null then
        raise_application_error(-20001, 'Version ' || p_version || ' of flow "' || p_flow_id || '" is not published.');
      end if;
    else
      select max(version) into l_version
        from fc_flow_versions
       where flow_id = p_flow_id and status = 'PUBLISHED';
      if l_version is null then
        raise_application_error(-20001, 'No published version of flow "' || p_flow_id || '".');
      end if;
    end if;

    init_ctx(c);
    fc_data.set_verified(null);
    l_sid := rawtohex(dbms_crypto.randombytes(16));
    c.session_id := l_sid;
    load_flow(c, p_flow_id, l_version);

    if p_context is null or dbms_lob.getlength(p_context) = 0 then
      l_ctx := json_object_t();
    else
      l_ctx := json_object_t.parse(p_context);
    end if;

    c.state := json_object_t();
    c.state.put('flowId', p_flow_id);
    c.state.put('version', l_version);
    c.state.put('status', 'in_progress');
    c.state.put_null('current');
    c.state.put('editing', false);
    c.state.put_null('editingField');
    c.state.put('context', l_ctx);
    c.state.put('repeat', json_object_t());
    c.state.put('bulk', json_object_t());
    c.slots   := json_object_t();
    c.history := json_array_t();
    seed_context(c);

    insert into fc_sessions (session_id, flow_id, version, status, state, app_user, apex_session, expires_at)
    values (l_sid, p_flow_id, l_version, 'in_progress', '{}',
            coalesce(sys_context('APEX$SESSION', 'APP_USER'), user),
            sys_context('APEX$SESSION', 'APP_SESSION'),
            systimestamp + c_ttl);
    log_ev(c, 'IN', null, nvl(p_context, '{}'));
    dbg_kv(c, 'start', null, 'version', to_char(l_version));

    run(c, str(c.flow, 'start'));
    save_session(c);
    l_turn := build_turn(c);
    log_ev(c, 'OUT', str(c.state, 'current'), l_turn);
    return l_turn;
  end start_session;

  function handle_input (p_session_id in varchar2, p_input in clob) return clob is
    c        t_ctx;
    l_in     json_object_t;
    l_cmd    varchar2(30);
    l_cur    varchar2(200);
    l_node   json_object_t;
    l_type   varchar2(30);
    l_parsed json_object_t;
    l_err    varchar2(4000);
    l_prev   varchar2(200);
    l_slot   varchar2(300);
    l_dot    pls_integer;
    l_cn     json_object_t;
    l_fd     json_object_t;
    l_target varchar2(200);
    l_keys   json_key_list;
    l_turn   clob;
    l_spec   json_object_t;
    l_blob   blob;
    l_rs     json_object_t;
    l_draft  json_object_t;
    l_fi     pls_integer;
    l_sid    varchar2(32) := p_session_id;
  begin
    load_session(c, p_session_id);
    if p_input is null or dbms_lob.getlength(p_input) = 0 then l_in := json_object_t(); else l_in := json_object_t.parse(p_input); end if;
    l_cur := str(c.state, 'current');
    log_ev(c, 'IN', l_cur, input_for_log(c, l_in));

    if str(c.state, 'status') <> 'in_progress' then
      return build_turn(c);
    end if;

    l_cmd := lower(str(l_in, 'command'));
    if l_cur is not null then
      l_node := get_node(c, l_cur);
      l_type := str(l_node, 'type');
    end if;

    if l_cmd = 'resume' then
      reprompt(c);

    elsif l_cmd = 'restart' then
      l_keys := vals(c).get_keys;
      if l_keys is not null then
        for i in 1 .. l_keys.count loop touch(c, l_keys(i)); end loop;
      end if;
      delete from fc_files where session_id = l_sid;
      c.slots   := json_object_t();
      c.records := json_object_t();
      c.results := json_object_t();
      c.history := json_array_t();
      c.state.put('editing', false);
      c.state.put_null('editingField');
      c.state.put('verify', json_object_t());
      c.state.put('verified', json_object_t());
      c.state.put_null('verifiedLast');
      c.state.put('repeat', json_object_t());
      c.state.put('bulk', json_object_t());
      fc_data.set_verified(null);
      seed_context(c);
      add_msg(c, 'text', 'Okay, let''s start over.');
      run(c, str(c.flow, 'start'));

    elsif l_cmd = 'back' and l_type = 'changeFields' and str(c.state, 'editingField') is not null then
      c.state.put_null('editingField');
      add_msg(c, 'text', 'No problem, I kept it as it was. Anything else to change?');

    elsif l_cmd = 'back' and l_type = 'repeat' and rp_state(c, l_cur) is not null
          and (nvl(to_num(str(rp_state(c, l_cur), 'field')), 0) > 0 or rp_items(c, l_node).get_size > 0) then
      -- inside a line item: back to its previous field, or drop the unfinished item
      l_rs := rp_state(c, l_cur);
      l_fi := nvl(to_num(str(l_rs, 'field')), 0);
      if l_fi > 0 then
        l_draft := obj(l_rs, 'draft');
        if l_draft is null then l_draft := json_object_t(); end if;
        l_fd := treat(arr(l_node, 'fields').get(l_fi - 1) as json_object_t);
        if l_draft.has(str(l_fd, 'field')) then l_draft.remove(str(l_fd, 'field')); end if;
        l_rs.put('draft', l_draft);
        l_rs.put('field', l_fi - 1);
        rp_put(c, l_cur, l_rs);
        rp_prompt_field(c, l_node);
      else
        rp_put(c, l_cur, null);
        add_msg(c, 'text', 'Okay, I dropped that one.');
        rp_show(c, l_node);
      end if;

    elsif l_cmd = 'back' then
      if l_type = 'repeat' then rp_put(c, l_cur, null); end if;
      if l_type = 'bulkUpdate' then bulk_put(c, l_cur, null); end if;
      c.state.put('editing', false);
      if c.history.get_size > 0 then
        l_prev := c.history.get_string(c.history.get_size - 1);
        c.history.remove(c.history.get_size - 1);
        -- a passed Verify step has nothing to ask again: step back past it
        while c.history.get_size > 0 and str(get_node(c, l_prev), 'type') = 'verify' loop
          l_prev := c.history.get_string(c.history.get_size - 1);
          c.history.remove(c.history.get_size - 1);
        end loop;
      end if;
      c.force_ask := nvl(l_prev, l_cur);
      run(c, nvl(l_prev, l_cur));

    elsif l_cmd = 'edit' then
      l_slot := str(l_in, 'slot');
      l_dot  := instr(l_slot, '.');
      if l_dot > 1 then
        l_cn := change_node(c, substr(l_slot, 1, l_dot - 1));
        if l_cn is not null then l_fd := field_def(l_cn, substr(l_slot, l_dot + 1)); end if;
      end if;
      l_target := str(c.slot_nodes, l_slot);
      if l_fd is not null and field_editable(c, l_cn, l_fd) then
        prompt_field(c, l_cn, l_fd);
      elsif l_target is not null then
        c.state.put('editing', true);
        c.force_ask := l_target;
        run(c, l_target);
      else
        add_msg(c, 'error', 'There is no question for "' || l_slot || '".');
      end if;

    elsif l_type is null then
      add_msg(c, 'error', 'There is nothing to answer right now.');

    elsif l_type = 'ask' then
      l_spec := eff_spec(c, input_spec(l_node));
      if str(l_spec, 'kind') = 'file' then
        l_parsed := parse_file(l_spec, obj(l_in, 'file'), l_blob);
      else
        l_parsed := parse_value(l_spec, str(l_in, 'value'));
      end if;
      l_err := str(l_parsed, 'error');
      if l_err is null then l_err := validate(c, l_node, l_parsed); end if;

      if l_err is not null then
        add_msg(c, 'error', l_err);
      else
        if str(l_spec, 'kind') = 'file' and l_blob is not null then
          l_parsed := save_file(c, str(l_node, 'slot'), l_parsed, l_blob);
        end if;
        c.slots.put(str(l_node, 'slot'), l_parsed.get('value'));
        touch(c, str(l_node, 'slot'));
        c.history.append(l_cur);
        if get_bool(c.state, 'editing') then
          c.state.put('editing', false);
          c.replay := true;
          run(c, str(c.flow, 'start'));
        else
          run(c, str(l_node, 'next'));
        end if;
      end if;

    elsif l_type = 'summary' then
      if lower(trim(str(l_in, 'value'))) in ('confirm', 'yes', 'y', 'ok', 'submit', 'save') then
        run(c, str(l_node, 'next'));
      else
        add_msg(c, 'text', 'Tap "' || nvl(str(l_node, 'confirmLabel'), 'Confirm & submit')
                           || '", or use Edit next to any answer to change it.');
      end if;

    elsif l_type = 'verify' then
      handle_verify(c, l_node, l_in, l_cmd);

    elsif l_type = 'findRecord' then
      handle_pick(c, l_node, l_in);

    elsif l_type = 'changeFields' then
      handle_change(c, l_node, l_in, l_cmd);

    elsif l_type = 'repeat' then
      handle_repeat(c, l_node, l_in, l_cmd);

    elsif l_type = 'bulkUpdate' then
      handle_bulk(c, l_node, l_in, l_cmd);
    end if;

    save_session(c);
    l_turn := build_turn(c);
    log_ev(c, 'OUT', str(c.state, 'current'), l_turn);
    return l_turn;
  end handle_input;

  function publish_flow (p_definition in clob, p_status in varchar2 default 'PUBLISHED') return number is
    l_def     json_object_t := json_object_t.parse(p_definition);
    l_flow_id varchar2(100) := str(l_def, 'flowId');
    l_name    varchar2(200) := str(l_def, 'name');
    l_version number;
    l_clob    clob;
  begin
    if l_flow_id is null or not l_def.has('start') or not l_def.has('nodes') then
      raise_application_error(-20030, 'Definition needs flowId, start and nodes.');
    end if;

    merge into fc_flows f
    using (select l_flow_id flow_id, l_name name from dual) s
       on (f.flow_id = s.flow_id)
     when matched then update set f.name = nvl(s.name, f.name)
     when not matched then insert (flow_id, name) values (s.flow_id, s.name);

    select nvl(max(version), 0) + 1 into l_version from fc_flow_versions where flow_id = l_flow_id;
    l_def.put('version', l_version);
    l_clob := l_def.to_clob;

    insert into fc_flow_versions (flow_id, version, status, definition)
    values (l_flow_id, l_version, p_status, l_clob);
    return l_version;
  end publish_flow;

  procedure purge_expired is
  begin
    delete from fc_sessions where expires_at < systimestamp - interval '30' day;
  end purge_expired;

  ------------------------------------------------------------------------------
  -- HTTP glue
  ------------------------------------------------------------------------------
  procedure http_out (p_json in clob, p_status in number default null) is
    l_len pls_integer := nvl(dbms_lob.getlength(p_json), 0);
    l_off pls_integer := 1;
  begin
    if p_status is not null then
      owa_util.status_line(nstatus => p_status, creason => null, bclose_header => false);
      owa_util.mime_header('application/json', false, 'UTF-8');
      htp.p('Cache-Control: no-store');
      owa_util.http_header_close;
    end if;
    while l_off <= l_len loop
      htp.prn(dbms_lob.substr(p_json, 8000, l_off));
      l_off := l_off + 8000;
    end loop;
  end http_out;

  function error_json return clob is
    l json_object_t := json_object_t();
  begin
    if sqlcode between -20999 and -20000 then
      l.put('error', regexp_replace(sqlerrm, '^ORA-[0-9]+: ', ''));
    else
      l.put('error', 'Unexpected server error. Please try again.');
      apex_debug.error('FlowChat: %s %s', sqlerrm, dbms_utility.format_error_backtrace);
    end if;
    return l.to_clob;
  end error_json;

  -- After a failed turn (rolled back): a DBG row with the error, when the conversation is being debugged.
  procedure log_error (p_session_id in varchar2, p_msg in varchar2) is
    l   json_object_t := json_object_t();
    l_c clob;
  begin
    if g_dbg_sid is null or p_session_id is null or g_dbg_sid <> p_session_id then return; end if;
    l.put('event', 'error');
    l.put('message', substr(p_msg, 1, 2000));
    l.put('at', to_char(sys_extract_utc(systimestamp), 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'));
    l_c := l.to_clob;
    insert into fc_events (session_id, direction, node_id, payload) values (p_session_id, 'DBG', null, l_c);
  exception when others then
    null;   -- logging must never hide the original error
  end log_error;

  procedure set_debug (p_on in boolean default true) is
  begin
    g_debug := nvl(p_on, false);
  end set_debug;

  procedure apex_start is
  begin
    savepoint fc_turn;
    http_out(start_session(apex_application.g_x01, apex_application.g_x02, to_num(apex_application.g_x03)));
  exception when others then
    rollback to fc_turn;
    http_out(error_json);
  end apex_start;

  procedure apex_input is
    l_in   clob;
    l_json clob;
    l_msg  varchar2(4000);
  begin
    savepoint fc_turn;
    -- the widget sends inputs over 8K (file answers) in p_clob_01 instead of x02
    if apex_application.g_clob_01 is not null and dbms_lob.getlength(apex_application.g_clob_01) > 0 then
      l_in := apex_application.g_clob_01;
    else
      l_in := apex_application.g_x02;
    end if;
    http_out(handle_input(apex_application.g_x01, l_in));
  exception when others then
    l_msg  := sqlerrm;
    l_json := error_json;
    rollback to fc_turn;
    log_error(apex_application.g_x01, l_msg);
    http_out(l_json);
  end apex_input;

  procedure ords_start (p_body in clob) is
    l_body json_object_t;
    l_ctx  clob;
    l_res  clob;
  begin
    savepoint fc_turn;
    l_body := json_object_t.parse(nvl(p_body, '{}'));
    if l_body.has('context') then l_ctx := l_body.get_object('context').to_clob; end if;
    l_res := start_session(str(l_body, 'flowId'), l_ctx, to_num(str(l_body, 'version')));
    http_out(l_res, 201);
  exception when others then
    rollback to fc_turn;
    http_out(error_json, case when sqlcode between -20999 and -20000 then 400 else 500 end);
  end ords_start;

  procedure ords_input (p_session_id in varchar2, p_body in clob) is
    l_res    clob;
    l_json   clob;
    l_msg    varchar2(4000);
    l_status number;
  begin
    savepoint fc_turn;
    l_res := handle_input(p_session_id, p_body);
    http_out(l_res, 200);
  exception when others then
    l_msg    := sqlerrm;
    l_json   := error_json;
    l_status := case when sqlcode = -20002 then 404
                     when sqlcode between -20999 and -20000 then 400
                     else 500 end;
    rollback to fc_turn;
    log_error(p_session_id, l_msg);
    http_out(l_json, l_status);
  end ords_input;

end fc_engine;
/
