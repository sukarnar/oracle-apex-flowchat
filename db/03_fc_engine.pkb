create or replace package body fc_engine as

  c_max_steps  constant pls_integer := 200;
  c_required   constant varchar2(100) := 'This one is required. Please provide a value.';
  c_ttl        constant interval day to second := interval '1' day;
  c_nls        constant varchar2(40) := 'NLS_NUMERIC_CHARACTERS=''.,''';

  type t_ctx is record (
    session_id  varchar2(32),
    flow        json_object_t,
    nodes       json_object_t,   -- node id -> node
    slot_nodes  json_object_t,   -- slot    -> id of the first ask node capturing it
    state       json_object_t,
    slots       json_object_t,
    history     json_array_t,
    out_msgs    json_array_t,
    updates     json_array_t,    -- slots changed during this turn
    replay      boolean,
    force_ask   varchar2(200)
  );

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

  function interpolate (p_text in varchar2, p_slots in json_object_t) return varchar2 is
    l_res varchar2(32767) := p_text;
    l_key varchar2(200);
  begin
    for i in 1 .. 50 loop
      l_key := regexp_substr(l_res, '\{\{\s*(\w+)\s*\}\}', 1, 1, null, 1);
      exit when l_key is null;
      l_res := regexp_replace(l_res, '\{\{\s*' || l_key || '\s*\}\}',
                              replace(str(p_slots, l_key), '\', '\\'));
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
    if p_node.has('input') then l := p_node.get_object('input'); else l := json_object_t(); end if;
    if not l.has('kind') then l.put('kind', 'text'); end if;
    return l;
  end input_spec;

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

  procedure merge_slots (c in out nocopy t_ctx, p_res in json_object_t) is
    l_obj  json_object_t;
    l_keys json_key_list;
  begin
    if p_res is null or not p_res.has('slots') then return; end if;
    l_obj  := p_res.get_object('slots');
    l_keys := l_obj.get_keys;
    if l_keys is null then return; end if;
    for i in 1 .. l_keys.count loop
      c.slots.put(l_keys(i), l_obj.get(l_keys(i)));
      touch(c, l_keys(i));
    end loop;
  end merge_slots;

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
  -- parsing & validation
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
        if p_spec.has('options') then l_opts := p_spec.get_array('options'); else l_opts := json_array_t(); end if;
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

      else
        l_res.put('value', l_s);
    end case;
    return l_res;
  end parse_value;

  -- p_parsed = {"value": <typed value or null>}. Returns an error message or null.
  function validate (c in out nocopy t_ctx, p_node in json_object_t, p_parsed in json_object_t) return varchar2 is
    l_spec   json_object_t := input_spec(p_node);
    l_kind   varchar2(30)  := str(l_spec, 'kind');
    l_val    varchar2(32767) := str(p_parsed, 'value');
    l_prefix varchar2(20)  := str(l_spec, 'prefix');
    l_num    number;
    l_lo     varchar2(30);
    l_hi     varchar2(30);
    l_vals   json_array_t;
    l_v      json_object_t;
    l_res    json_object_t;
  begin
    if l_val is null then
      if str(l_spec, 'required') = 'false' then return null; end if;
      return nvl(str(l_spec, 'requiredMessage'), c_required);
    end if;

    if l_kind = 'number' then
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

    if p_node.has('validators') then
      l_vals := p_node.get_array('validators');
      for i in 0 .. l_vals.get_size - 1 loop
        l_v := treat(l_vals.get(i) as json_object_t);
        if str(l_v, 'type') = 'regex' then
          if not regexp_like(l_val, str(l_v, 'pattern')) then
            return nvl(str(l_v, 'message'), 'That value isn''t in the expected format.');
          end if;
        elsif str(l_v, 'type') = 'server' then
          l_res := call_connector(str(l_v, 'connector'),
                                  payload(c, str(p_node, 'id'), str(p_node, 'slot'), p_parsed.get('value')));
          if str(l_res, 'valid') = 'false' then
            return coalesce(str(l_res, 'message'), str(l_v, 'message'), 'That value wasn''t accepted.');
          end if;
        end if;
      end loop;
    end if;
    return null;
  end validate;

  function display_value (c in out nocopy t_ctx, p_slot in varchar2) return varchar2 is
    l_v    varchar2(32767) := str(c.slots, p_slot);
    l_nid  varchar2(200)   := str(c.slot_nodes, p_slot);
    l_spec json_object_t;
    l_opts json_array_t;
    l_opt  json_object_t;
  begin
    if l_v is null or l_nid is null then return l_v; end if;
    l_spec := input_spec(get_node(c, l_nid));
    case str(l_spec, 'kind')
      when 'number' then return str(l_spec, 'prefix') || nvl(fmt_num(to_num(l_v)), l_v);
      when 'yesno'  then return case l_v when 'Y' then 'Yes' else 'No' end;
      when 'choice' then
        if l_spec.has('options') then
          l_opts := l_spec.get_array('options');
          for i in 0 .. l_opts.get_size - 1 loop
            l_opt := treat(l_opts.get(i) as json_object_t);
            if str(l_opt, 'value') = l_v then return nvl(str(l_opt, 'label'), l_v); end if;
          end loop;
        end if;
        return l_v;
      else return l_v;
    end case;
  end display_value;

  ------------------------------------------------------------------------------
  -- conditions
  ------------------------------------------------------------------------------
  function eval_cond (p_slots in json_object_t, p_cond in json_object_t) return boolean is
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
        if not eval_cond(p_slots, treat(l_arr.get(i) as json_object_t)) then return false; end if;
      end loop;
      return true;
    elsif p_cond.has('any') then
      l_arr := p_cond.get_array('any');
      for i in 0 .. l_arr.get_size - 1 loop
        if eval_cond(p_slots, treat(l_arr.get(i) as json_object_t)) then return true; end if;
      end loop;
      return false;
    elsif p_cond.has('not') then
      return not eval_cond(p_slots, p_cond.get_object('not'));
    end if;

    l_op := str(p_cond, 'op');
    l_v  := str(p_slots, str(p_cond, 'slot'));
    if l_op = 'empty'    then return l_v is null; end if;
    if l_op = 'notEmpty' then return l_v is not null; end if;
    if l_op not in ('=', '!=', '>', '>=', '<', '<=', 'in') or l_op is null then
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

  function pick_branch (p_slots in json_object_t, p_node in json_object_t) return varchar2 is
    l_br json_array_t;
    l_b  json_object_t;
  begin
    if p_node.has('branches') then
      l_br := p_node.get_array('branches');
      for i in 0 .. l_br.get_size - 1 loop
        l_b := treat(l_br.get(i) as json_object_t);
        if eval_cond(p_slots, l_b.get_object('when')) then return str(l_b, 'next'); end if;
      end loop;
    end if;
    return str(p_node, 'else');
  end pick_branch;

  ------------------------------------------------------------------------------
  -- runtime
  ------------------------------------------------------------------------------
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
    if p_node.has('fields') then
      l_fields := p_node.get_array('fields');
      for i in 0 .. l_fields.get_size - 1 loop add_item(l_fields.get_string(i)); end loop;
    else
      l_nodes := c.flow.get_array('nodes');
      for i in 0 .. l_nodes.get_size - 1 loop
        l_n := treat(l_nodes.get(i) as json_object_t);
        if str(l_n, 'type') = 'ask' and str(c.slots, str(l_n, 'slot')) is not null then
          add_item(str(l_n, 'slot'));
        end if;
      end loop;
    end if;
    l_msg.put('type', 'summary');
    l_msg.put('text', interpolate(nvl(str(p_node, 'text'), 'Here''s what I have. Please check:'), c.slots));
    l_msg.put('items', l_items);
    c.out_msgs.append(l_msg);
  end add_summary;

  -- Re-check every answered question before submit. Returns the failing node id (or null).
  function revalidate (c in out nocopy t_ctx, p_err out varchar2) return varchar2 is
    l_nodes  json_array_t := c.flow.get_array('nodes');
    l_n      json_object_t;
    l_slot   varchar2(200);
    l_parsed json_object_t;
  begin
    for i in 0 .. l_nodes.get_size - 1 loop
      l_n := treat(l_nodes.get(i) as json_object_t);
      l_slot := str(l_n, 'slot');
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
      elsif l_type = 'condition' then
        l_id := pick_branch(c.slots, l_n);
      elsif l_type in ('message', 'lookup') then
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
    l_steps   pls_integer := 0;
  begin
    while l_id is not null loop
      l_steps := l_steps + 1;
      if l_steps > c_max_steps then
        raise_application_error(-20020, 'Flow exceeded ' || c_max_steps || ' steps. Check it for a loop.');
      end if;
      l_node := get_node(c, l_id);
      l_type := str(l_node, 'type');

      case l_type
        when 'message' then
          if not c.replay then add_msg(c, 'text', interpolate(str(l_node, 'text'), c.slots)); end if;
          l_id := str(l_node, 'next');

        when 'condition' then
          l_id := pick_branch(c.slots, l_node);

        when 'lookup' then
          if c.replay then
            l_id := str(l_node, 'next');
          else
            l_res := call_connector(str(l_node, 'connector'), payload(c, l_id));
            merge_slots(c, l_res);
            add_msg(c, 'text', str(l_res, 'message'));
            if str(l_res, 'found') = 'false' and l_node.has('onNotFound') then
              l_id := str(l_node, 'onNotFound');
            else
              l_id := str(l_node, 'next');
            end if;
          end if;

        when 'ask' then
          l_slot := str(l_node, 'slot');
          if (c.replay or get_bool(l_node, 'skipIfFilled'))
             and str(c.slots, l_slot) is not null
             and nvl(c.force_ask, '~') <> l_id then
            l_id := str(l_node, 'next');
          else
            -- a question reached while replaying an edit keeps the replay going after it's answered
            if c.replay then c.state.put('editing', true); end if;
            c.replay := false;
            c.force_ask := null;
            c.state.put('current', l_id);
            add_msg(c, 'text', interpolate(str(l_node, 'prompt'), c.slots));
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
            l_res := call_connector(str(l_node, 'connector'), payload(c, l_id));
            merge_slots(c, l_res);
            if str(l_res, 'ok') = 'true' then
              add_msg(c, 'text', str(l_res, 'message'));
              l_id := nvl(str(l_node, 'onSuccess'), str(l_node, 'next'));
            else
              add_msg(c, 'error', nvl(str(l_res, 'message'), 'Sorry, the submission failed.'));
              l_id := str(l_node, 'onError');
              if l_id is null then
                c.state.put('status', 'failed');
                c.state.put_null('current');
                return;
              end if;
            end if;
          end if;

        when 'end' then
          add_msg(c, 'success', interpolate(str(l_node, 'text'), c.slots));
          c.state.put('status', 'completed');
          c.state.put_null('current');
          return;

        else
          raise_application_error(-20021, 'Unknown node type "' || l_type || '" (' || l_id || ').');
      end case;
    end loop;
    c.state.put('status', 'completed');
    c.state.put_null('current');
  end run;

  function build_turn (c in out nocopy t_ctx) return clob is
    l_turn    json_object_t := json_object_t();
    l_aw      json_object_t;
    l_node    json_object_t;
    l_updates json_array_t := json_array_t();
    l_u       json_object_t;
    l_prog    json_object_t := json_object_t();
    l_bind    json_object_t;
    l_slot    varchar2(200);
    l_cur     varchar2(200) := str(c.state, 'current');
    l_done    pls_integer;
    l_total   pls_integer;
  begin
    if str(c.state, 'status') = 'in_progress' and l_cur is not null then
      l_node := get_node(c, l_cur);
      l_aw := json_object_t();
      l_aw.put('nodeId', l_cur);
      if str(l_node, 'type') = 'ask' then
        l_slot := str(l_node, 'slot');
        l_aw.put('type', 'ask');
        l_aw.put('slot', l_slot);
        l_aw.put('label', nvl(str(l_node, 'label'), l_slot));
        l_aw.put('input', input_spec(l_node));
        if str(c.slots, l_slot) is not null then l_aw.put('value', c.slots.get(l_slot)); else l_aw.put_null('value'); end if;
      else
        l_aw.put('type', 'summary');
        l_aw.put('confirmLabel', nvl(str(l_node, 'confirmLabel'), 'Confirm & submit'));
      end if;
    end if;

    if c.flow.has('bindings') then l_bind := c.flow.get_object('bindings'); end if;
    for i in 0 .. c.updates.get_size - 1 loop
      l_slot := c.updates.get_string(i);
      l_u := json_object_t();
      l_u.put('slot', l_slot);
      if str(c.slots, l_slot) is not null then l_u.put('value', c.slots.get(l_slot)); else l_u.put_null('value'); end if;
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
    l_turn.put('canGoBack', c.history.get_size > 0);
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
    c.replay    := false;
    c.force_ask := null;
  end init_ctx;

  procedure load_flow (c in out nocopy t_ctx, p_flow_id in varchar2, p_version in number) is
    l_def   clob;
    l_nodes json_array_t;
    l_node  json_object_t;
  begin
    select definition into l_def
      from fc_flow_versions
     where flow_id = p_flow_id and version = p_version;
    c.flow := json_object_t.parse(l_def);
    c.nodes := json_object_t();
    c.slot_nodes := json_object_t();
    l_nodes := c.flow.get_array('nodes');
    for i in 0 .. l_nodes.get_size - 1 loop
      l_node := treat(l_nodes.get(i) as json_object_t);
      c.nodes.put(str(l_node, 'id'), l_node);
      if str(l_node, 'type') = 'ask' and not c.slot_nodes.has(str(l_node, 'slot')) then
        c.slot_nodes.put(str(l_node, 'slot'), str(l_node, 'id'));
      end if;
    end loop;
  end load_flow;

  -- Context values whose key is a known slot (asked or bound) prefill that slot.
  procedure seed_context (c in out nocopy t_ctx) is
    l_ctx  json_object_t := c.state.get_object('context');
    l_bind json_object_t;
    l_keys json_key_list;
  begin
    if l_ctx is null then return; end if;
    if c.flow.has('bindings') then l_bind := c.flow.get_object('bindings'); end if;
    l_keys := l_ctx.get_keys;
    if l_keys is null then return; end if;
    for i in 1 .. l_keys.count loop
      if str(l_ctx, l_keys(i)) is not null
         and (c.slot_nodes.has(l_keys(i)) or (l_bind is not null and l_bind.has(l_keys(i)))) then
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
    if c.state.has('slots')   then c.slots   := c.state.get_object('slots');  else c.slots   := json_object_t(); end if;
    if c.state.has('history') then c.history := c.state.get_array('history'); else c.history := json_array_t();  end if;
  end load_session;

  ------------------------------------------------------------------------------
  -- public API
  ------------------------------------------------------------------------------
  function start_session (p_flow_id in varchar2, p_context in clob default null) return clob is
    c         t_ctx;
    l_version number;
    l_ctx     json_object_t;
    l_turn    clob;
    l_sid     varchar2(32);
  begin
    select max(version) into l_version
      from fc_flow_versions
     where flow_id = p_flow_id and status = 'PUBLISHED';
    if l_version is null then
      raise_application_error(-20001, 'No published version of flow "' || p_flow_id || '".');
    end if;

    init_ctx(c);
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
    c.state.put('context', l_ctx);
    c.slots   := json_object_t();
    c.history := json_array_t();
    seed_context(c);

    insert into fc_sessions (session_id, flow_id, version, status, state, app_user, apex_session, expires_at)
    values (l_sid, p_flow_id, l_version, 'in_progress', '{}',
            coalesce(sys_context('APEX$SESSION', 'APP_USER'), user),
            sys_context('APEX$SESSION', 'APP_SESSION'),
            systimestamp + c_ttl);
    log_event(l_sid, 'IN', null, nvl(p_context, '{}'));

    run(c, str(c.flow, 'start'));
    save_session(c);
    l_turn := build_turn(c);
    log_event(l_sid, 'OUT', str(c.state, 'current'), l_turn);
    return l_turn;
  end start_session;

  function handle_input (p_session_id in varchar2, p_input in clob) return clob is
    c        t_ctx;
    l_in     json_object_t;
    l_cmd    varchar2(30);
    l_cur    varchar2(200);
    l_node   json_object_t;
    l_parsed json_object_t;
    l_err    varchar2(4000);
    l_prev   varchar2(200);
    l_target varchar2(200);
    l_keys   json_key_list;
    l_turn   clob;
  begin
    load_session(c, p_session_id);
    if p_input is null or dbms_lob.getlength(p_input) = 0 then l_in := json_object_t(); else l_in := json_object_t.parse(p_input); end if;
    l_cur := str(c.state, 'current');
    log_event(p_session_id, 'IN', l_cur, l_in.to_clob);

    if str(c.state, 'status') <> 'in_progress' then
      return build_turn(c);
    end if;

    l_cmd := lower(str(l_in, 'command'));

    if l_cmd = 'restart' then
      l_keys := c.slots.get_keys;
      if l_keys is not null then
        for i in 1 .. l_keys.count loop touch(c, l_keys(i)); end loop;
      end if;
      c.slots   := json_object_t();
      c.history := json_array_t();
      c.state.put('editing', false);
      seed_context(c);
      add_msg(c, 'text', 'Okay, let''s start over.');
      run(c, str(c.flow, 'start'));

    elsif l_cmd = 'back' then
      c.state.put('editing', false);
      if c.history.get_size > 0 then
        l_prev := c.history.get_string(c.history.get_size - 1);
        c.history.remove(c.history.get_size - 1);
      end if;
      c.force_ask := nvl(l_prev, l_cur);
      run(c, nvl(l_prev, l_cur));

    elsif l_cmd = 'edit' then
      l_target := str(c.slot_nodes, str(l_in, 'slot'));
      if l_target is null then
        add_msg(c, 'error', 'There is no question for "' || str(l_in, 'slot') || '".');
      else
        c.state.put('editing', true);
        c.force_ask := l_target;
        run(c, l_target);
      end if;

    else
      l_node := get_node(c, l_cur);
      if str(l_node, 'type') = 'ask' then
        l_parsed := parse_value(input_spec(l_node), str(l_in, 'value'));
        l_err := str(l_parsed, 'error');
        if l_err is null then l_err := validate(c, l_node, l_parsed); end if;

        if l_err is not null then
          add_msg(c, 'error', l_err);
        else
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

      elsif str(l_node, 'type') = 'summary' then
        if lower(trim(str(l_in, 'value'))) in ('confirm', 'yes', 'y', 'ok', 'submit') then
          run(c, str(l_node, 'next'));
        else
          add_msg(c, 'text', 'Tap "' || nvl(str(l_node, 'confirmLabel'), 'Confirm & submit')
                             || '", or use Edit next to any answer to change it.');
        end if;
      end if;
    end if;

    save_session(c);
    l_turn := build_turn(c);
    log_event(p_session_id, 'OUT', str(c.state, 'current'), l_turn);
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

  procedure apex_start is
  begin
    savepoint fc_turn;
    http_out(start_session(apex_application.g_x01, apex_application.g_x02));
  exception when others then
    rollback to fc_turn;
    http_out(error_json);
  end apex_start;

  procedure apex_input is
  begin
    savepoint fc_turn;
    http_out(handle_input(apex_application.g_x01, apex_application.g_x02));
  exception when others then
    rollback to fc_turn;
    http_out(error_json);
  end apex_input;

  procedure ords_start (p_body in clob) is
    l_body json_object_t;
    l_ctx  clob;
    l_res  clob;
  begin
    savepoint fc_turn;
    l_body := json_object_t.parse(nvl(p_body, '{}'));
    if l_body.has('context') then l_ctx := l_body.get_object('context').to_clob; end if;
    l_res := start_session(str(l_body, 'flowId'), l_ctx);
    http_out(l_res, 201);
  exception when others then
    rollback to fc_turn;
    http_out(error_json, case when sqlcode between -20999 and -20000 then 400 else 500 end);
  end ords_start;

  procedure ords_input (p_session_id in varchar2, p_body in clob) is
    l_res clob;
  begin
    savepoint fc_turn;
    l_res := handle_input(p_session_id, p_body);
    http_out(l_res, 200);
  exception when others then
    rollback to fc_turn;
    http_out(error_json, case when sqlcode = -20002 then 404
                              when sqlcode between -20999 and -20000 then 400
                              else 500 end);
  end ords_input;

end fc_engine;
/
