--------------------------------------------------------------------------------
-- FC_DATA package (generic search / get / update for data sources). Safe to re-run.
-- Requires the tables from 02_data_sources.sql.
--------------------------------------------------------------------------------
create or replace package fc_data authid definer as
  ------------------------------------------------------------------------------
  -- Generic record access for FlowChat data sources.
  --   search_rows : [{ "key": "...", "values": {field: value} }]   (masked fields masked)
  --   get_row     : { "values": {...}, "version": "..." }  or null if not found / not visible
  --   update_row  : { "status": "ok"|"conflict"|"forbidden"|"notfound", "version": "...", "message": "..." }
  -- Criteria: [{ "field": "email", "op": "eq|starts|contains|gte|lte", "value": "..." }]
  -- Dates travel as 'YYYY-MM-DD' strings; numbers as JSON numbers.
  --
  -- PLSQL-type sources receive the same shapes as JSON:
  --   search_target({criteria, limit, context}) -> JSON array   get_target({key, context}) -> object
  --   update_target({key, version, original, changes, context}) -> object
  ------------------------------------------------------------------------------
  function search_rows (p_source in varchar2, p_criteria in json_array_t, p_limit in pls_integer,
                        p_context in json_object_t default null) return json_array_t;
  function get_row     (p_source in varchar2, p_key in varchar2,
                        p_context in json_object_t default null) return json_object_t;
  function update_row  (p_source in varchar2, p_key in varchar2, p_version in varchar2,
                        p_original in json_object_t, p_changes in json_object_t,
                        p_context in json_object_t default null) return json_object_t;
  function is_updatable (p_source in varchar2, p_field in varchar2) return boolean;

  -- Identity proved by the conversation's latest Verify step (or null). FC_ENGINE sets it on every
  -- request. A row_filter can use it as :FC_VERIFIED, e.g.  upper(email) = upper(:FC_VERIFIED);
  -- PLSQL sources receive it as "verified" in their payload.
  procedure set_verified (p_value in varchar2);

  -- First rows of a TABLE source (row_filter applied, nothing masked) for the designer's Test tab:
  --   [{ "key": "...", "version": "...", "values": {...} }]. PLSQL sources return [].
  function sample_rows (p_source in varchar2, p_limit in pls_integer default 20) return json_array_t;

  -- Options of a lookup list (FC_LOVS) for a choice answer: [{ "value": "...", "label": "..." }], at most 500.
  -- p_params: {"country": "CA"} -> bound as :COUNTRY in a SQL list, passed as "params" to a PLSQL list.
  function lov_options (p_lov in varchar2, p_params in json_object_t,
                        p_context in json_object_t default null) return json_array_t;
end fc_data;
/

create or replace package body fc_data as

  c_nls constant varchar2(40) := 'NLS_NUMERIC_CHARACTERS=''.,''';
  c_max_options constant pls_integer := 500;
  g_verified varchar2(4000);

  type t_field is record (
    field       fc_data_source_fields.field%type,
    col         varchar2(130),
    data_type   fc_data_source_fields.data_type%type,
    searchable  fc_data_source_fields.searchable%type,
    search_ops  fc_data_source_fields.search_ops%type,
    updatable   fc_data_source_fields.updatable%type,
    mask        fc_data_source_fields.mask%type
  );
  type t_fields is table of t_field index by varchar2(100);

  type t_bind is record (name varchar2(30), data_type varchar2(20), val varchar2(4000));
  type t_binds is table of t_bind index by pls_integer;

  ------------------------------------------------------------------------------
  function jstr (p_obj in json_object_t, p_key in varchar2) return varchar2 is
    l_el json_element_t;
  begin
    if p_obj is null or not p_obj.has(p_key) then return null; end if;
    l_el := p_obj.get(p_key);
    if l_el.is_null then return null;
    elsif l_el.is_string then return p_obj.get_string(p_key);
    elsif l_el.is_number then
      return rtrim(rtrim(to_char(p_obj.get_number(p_key), 'FM99999999999999999999990D9999999999', c_nls), '0'), '.');
    elsif l_el.is_true then return 'true';
    elsif l_el.is_false then return 'false';
    end if;
    return l_el.to_string;
  end jstr;

  procedure set_verified (p_value in varchar2) is
  begin
    g_verified := p_value;
  end set_verified;

  function app_user return varchar2 is
  begin
    return coalesce(sys_context('APEX$SESSION', 'APP_USER'), user);
  end app_user;

  procedure load_source (p_source in varchar2, p_src out fc_data_sources%rowtype, p_fields out t_fields) is
  begin
    begin
      select * into p_src from fc_data_sources where source_id = p_source and enabled = 'Y';
    exception when no_data_found then
      raise_application_error(-20040, 'Unknown or disabled data source "' || p_source || '".');
    end;
    for r in (select * from fc_data_source_fields where source_id = p_source) loop
      p_fields(r.field).field      := r.field;
      p_fields(r.field).col        := 't.' || dbms_assert.simple_sql_name(r.column_name);
      p_fields(r.field).data_type  := r.data_type;
      p_fields(r.field).searchable := r.searchable;
      p_fields(r.field).search_ops := r.search_ops;
      p_fields(r.field).updatable  := r.updatable;
      p_fields(r.field).mask       := r.mask;
    end loop;
  end load_source;

  -- json_object('field' value <col>, ...) select expression; dates as YYYY-MM-DD.
  function values_expr (p_fields in t_fields) return varchar2 is
    l_sql varchar2(32767);
    l_f   varchar2(100) := p_fields.first;
  begin
    while l_f is not null loop
      l_sql := l_sql || case when l_sql is not null then ', ' end || '''' || l_f || ''' value ' ||
               case p_fields(l_f).data_type when 'DATE' then 'to_char(' || p_fields(l_f).col || ', ''YYYY-MM-DD'')'
                                            else p_fields(l_f).col end;
      l_f := p_fields.next(l_f);
    end loop;
    return 'json_object(' || l_sql || ' null on null returning clob)';
  end values_expr;

  -- SQL placeholder for a typed bind.
  function bind_expr (p_name in varchar2, p_type in varchar2) return varchar2 is
  begin
    return case p_type when 'DATE' then 'to_date(:' || p_name || ', ''YYYY-MM-DD'')'
                       when 'NUMBER' then 'to_number(:' || p_name || ', ''99999999999999999999999.9999999999'')'
                       else ':' || p_name end;
  end bind_expr;

  procedure add_bind (p_binds in out nocopy t_binds, p_name in varchar2, p_val in varchar2) is
    i pls_integer := p_binds.count + 1;
  begin
    p_binds(i).name := p_name;
    p_binds(i).val  := p_val;
  end add_bind;

  function filter_sql (p_src in fc_data_sources%rowtype) return varchar2 is
  begin
    return case when p_src.row_filter is not null then ' and (' || p_src.row_filter || ')' end;
  end filter_sql;

  procedure bind_all (p_cur in integer, p_sql in varchar2, p_binds in t_binds) is
  begin
    for i in 1 .. p_binds.count loop
      dbms_sql.bind_variable(p_cur, ':' || p_binds(i).name, p_binds(i).val, 4000);
    end loop;
    if instr(upper(p_sql), ':APP_USER') > 0 then
      dbms_sql.bind_variable(p_cur, ':APP_USER', app_user);
    end if;
    if instr(upper(p_sql), ':FC_VERIFIED') > 0 then
      dbms_sql.bind_variable(p_cur, ':FC_VERIFIED', g_verified, 4000);   -- null (no rows) until verified
    end if;
  end bind_all;

  function mask_value (p_mask in varchar2, p_val in varchar2) return varchar2 is
  begin
    if p_val is null or p_mask is null then return p_val; end if;
    if p_mask = 'last4' then return unistr('\2022\2022\2022\2022 ') || substr(p_val, -4); end if;
    return p_val;
  end mask_value;

  function call_target (p_target in varchar2, p_payload in clob) return clob is
    l_res clob;
  begin
    execute immediate 'begin :r := ' || dbms_assert.qualified_sql_name(p_target) || '(:p); end;'
      using out l_res, in p_payload;
    return l_res;
  end call_target;

  function ctx_payload (p_context in json_object_t) return json_object_t is
    l json_object_t := json_object_t();
  begin
    l.put('appUser', app_user);
    if g_verified is not null then l.put('verified', g_verified); else l.put_null('verified'); end if;
    if p_context is not null then l.put('context', p_context); end if;
    return l;
  end ctx_payload;

  ------------------------------------------------------------------------------
  function is_updatable (p_source in varchar2, p_field in varchar2) return boolean is
    l_type fc_data_sources.source_type%type;
    l_upd  fc_data_source_fields.updatable%type;
  begin
    select source_type into l_type from fc_data_sources where source_id = p_source;
    begin
      select updatable into l_upd from fc_data_source_fields where source_id = p_source and field = p_field;
      return l_upd = 'Y';
    exception when no_data_found then
      return l_type = 'PLSQL';   -- PLSQL sources without metadata enforce rules in their own update function
    end;
  exception when no_data_found then
    return false;
  end is_updatable;

  function search_rows (p_source in varchar2, p_criteria in json_array_t, p_limit in pls_integer,
                        p_context in json_object_t default null) return json_array_t is
    l_src    fc_data_sources%rowtype;
    l_fields t_fields;
    l_binds  t_binds;
    l_sql    varchar2(32767);
    l_where  varchar2(32767);
    l_c      json_object_t;
    l_field  varchar2(100);
    l_op     varchar2(20);
    l_val    varchar2(4000);
    l_col    varchar2(130);
    l_cur    integer;
    l_n      integer;
    l_key    varchar2(4000);
    l_vals   clob;
    l_obj    json_object_t;
    l_row    json_object_t;
    l_out    json_array_t := json_array_t();
    l_f      varchar2(100);
    l_pay    json_object_t;
  begin
    load_source(p_source, l_src, l_fields);

    if l_src.source_type = 'PLSQL' then
      l_pay := ctx_payload(p_context);
      l_pay.put('criteria', p_criteria);
      l_pay.put('limit', p_limit);
      return json_array_t.parse(call_target(l_src.search_target, l_pay.to_clob));
    end if;

    for i in 0 .. p_criteria.get_size - 1 loop
      l_c     := treat(p_criteria.get(i) as json_object_t);
      l_field := jstr(l_c, 'field');
      l_op    := nvl(jstr(l_c, 'op'), 'eq');
      l_val   := jstr(l_c, 'value');
      if l_field is null or not l_fields.exists(l_field) or l_fields(l_field).searchable <> 'Y'
         or instr(',' || replace(l_fields(l_field).search_ops, ' ') || ',', ',' || l_op || ',') = 0 then
        raise_application_error(-20041, 'Field "' || l_field || '" cannot be searched with "' || l_op || '".');
      end if;
      l_col := l_fields(l_field).col;
      if l_fields(l_field).data_type = 'VARCHAR2' then
        if l_op in ('starts', 'contains') then
          l_val := replace(replace(replace(l_val, '\', '\\'), '%', '\%'), '_', '\_');
          l_val := case l_op when 'contains' then '%' end || l_val || '%';
          l_where := l_where || ' and upper(' || l_col || ') like upper(:c' || i || ') escape ''\''';
        else
          l_where := l_where || ' and upper(' || l_col || ') ' ||
                     case l_op when 'gte' then '>=' when 'lte' then '<=' else '=' end || ' upper(:c' || i || ')';
        end if;
      else
        l_where := l_where || ' and ' || l_col || ' ' ||
                   case l_op when 'gte' then '>=' when 'lte' then '<=' else '=' end || ' ' ||
                   bind_expr('c' || i, l_fields(l_field).data_type);
      end if;
      add_bind(l_binds, 'c' || i, l_val);
    end loop;
    if l_where is null then
      raise_application_error(-20042, 'A search needs at least one criterion.');
    end if;

    l_sql := 'select to_char(t.' || dbms_assert.simple_sql_name(l_src.key_column) || '), ' || values_expr(l_fields) ||
             ' from ' || dbms_assert.qualified_sql_name(l_src.object_name) || ' t where 1 = 1' ||
             l_where || filter_sql(l_src) ||
             ' fetch first ' || to_char(greatest(1, least(nvl(p_limit, 50), 200))) || ' rows only';

    l_cur := dbms_sql.open_cursor;
    begin
      dbms_sql.parse(l_cur, l_sql, dbms_sql.native);
      bind_all(l_cur, l_sql, l_binds);
      dbms_sql.define_column(l_cur, 1, l_key, 4000);
      dbms_sql.define_column(l_cur, 2, l_vals);
      l_n := dbms_sql.execute(l_cur);
      while dbms_sql.fetch_rows(l_cur) > 0 loop
        dbms_sql.column_value(l_cur, 1, l_key);
        dbms_sql.column_value(l_cur, 2, l_vals);
        l_obj := json_object_t.parse(l_vals);
        l_f := l_fields.first;
        while l_f is not null loop
          if l_fields(l_f).mask is not null and jstr(l_obj, l_f) is not null then
            l_obj.put(l_f, mask_value(l_fields(l_f).mask, jstr(l_obj, l_f)));
          end if;
          l_f := l_fields.next(l_f);
        end loop;
        l_row := json_object_t();
        l_row.put('key', l_key);
        l_row.put('values', l_obj);
        l_out.append(l_row);
      end loop;
      dbms_sql.close_cursor(l_cur);
    exception when others then
      if dbms_sql.is_open(l_cur) then dbms_sql.close_cursor(l_cur); end if;
      raise;
    end;
    return l_out;
  end search_rows;

  function lov_options (p_lov in varchar2, p_params in json_object_t,
                        p_context in json_object_t default null) return json_array_t is
    l_lov   fc_lovs%rowtype;
    l_out   json_array_t := json_array_t();
    l_item  json_object_t;
    l_keys  json_key_list;
    l_binds t_binds;
    l_pl    json_object_t;
    l_arr   json_array_t;
    l_el    json_object_t;
    l_cur   integer;
    l_n     integer;
    l_val   varchar2(4000);
    l_lab   varchar2(4000);
    l_cnt   pls_integer := 0;
  begin
    begin
      select * into l_lov from fc_lovs where lov_id = p_lov and enabled = 'Y';
    exception when no_data_found then
      raise_application_error(-20041, 'Unknown or disabled lookup list "' || p_lov || '".');
    end;
    if p_params is not null then l_keys := p_params.get_keys; end if;

    if l_lov.lov_type = 'PLSQL' then
      l_pl := ctx_payload(p_context);
      l_pl.put('lov', p_lov);
      if p_params is not null then l_pl.put('params', p_params); else l_pl.put('params', json_object_t()); end if;
      l_arr := json_array_t.parse(call_target(l_lov.target, l_pl.to_clob));
      for i in 0 .. l_arr.get_size - 1 loop
        exit when l_cnt >= c_max_options;
        if l_arr.get(i).is_object then
          l_el  := treat(l_arr.get(i) as json_object_t);
          l_val := jstr(l_el, 'value');
          if l_val is not null then
            l_item := json_object_t();
            l_item.put('value', l_val);
            l_item.put('label', nvl(jstr(l_el, 'label'), l_val));
            l_out.append(l_item);
            l_cnt := l_cnt + 1;
          end if;
        end if;
      end loop;
      return l_out;
    end if;

    -- SQL list: bind only the parameters the query uses (:NAME, case-insensitive).
    if l_keys is not null then
      for i in 1 .. l_keys.count loop
        if regexp_like(l_lov.query, ':' || l_keys(i) || '([^A-Za-z0-9_$#]|$)', 'i') then
          add_bind(l_binds, upper(l_keys(i)), jstr(p_params, l_keys(i)));
        end if;
      end loop;
    end if;
    l_cur := dbms_sql.open_cursor;
    begin
      dbms_sql.parse(l_cur, l_lov.query, dbms_sql.native);
      bind_all(l_cur, l_lov.query, l_binds);
      dbms_sql.define_column(l_cur, 1, l_val, 4000);
      dbms_sql.define_column(l_cur, 2, l_lab, 4000);
      l_n := dbms_sql.execute(l_cur);
      while l_cnt < c_max_options and dbms_sql.fetch_rows(l_cur) > 0 loop
        dbms_sql.column_value(l_cur, 1, l_val);
        dbms_sql.column_value(l_cur, 2, l_lab);
        if l_val is not null then
          l_item := json_object_t();
          l_item.put('value', l_val);
          l_item.put('label', nvl(l_lab, l_val));
          l_out.append(l_item);
          l_cnt := l_cnt + 1;
        end if;
      end loop;
      dbms_sql.close_cursor(l_cur);
    exception when others then
      if dbms_sql.is_open(l_cur) then dbms_sql.close_cursor(l_cur); end if;
      raise_application_error(-20042, 'Lookup list "' || p_lov || '" failed: ' || sqlerrm);
    end;
    return l_out;
  end lov_options;

  function sample_rows (p_source in varchar2, p_limit in pls_integer default 20) return json_array_t is
    l_src    fc_data_sources%rowtype;
    l_fields t_fields;
    l_binds  t_binds;
    l_sql    varchar2(32767);
    l_cur    integer;
    l_n      integer;
    l_key    varchar2(4000);
    l_ver    varchar2(4000);
    l_vals   clob;
    l_row    json_object_t;
    l_out    json_array_t := json_array_t();
  begin
    load_source(p_source, l_src, l_fields);
    if l_src.source_type <> 'TABLE' then return l_out; end if;

    l_sql := 'select to_char(t.' || dbms_assert.simple_sql_name(l_src.key_column) || '), ' ||
             case when l_src.version_column is not null
                  then 'to_char(t.' || dbms_assert.simple_sql_name(l_src.version_column) || ')' else 'null' end || ', ' ||
             values_expr(l_fields) ||
             ' from ' || dbms_assert.qualified_sql_name(l_src.object_name) || ' t where 1 = 1' || filter_sql(l_src) ||
             ' fetch first ' || to_char(greatest(1, least(nvl(p_limit, 20), 100))) || ' rows only';

    l_cur := dbms_sql.open_cursor;
    begin
      dbms_sql.parse(l_cur, l_sql, dbms_sql.native);
      bind_all(l_cur, l_sql, l_binds);
      dbms_sql.define_column(l_cur, 1, l_key, 4000);
      dbms_sql.define_column(l_cur, 2, l_ver, 4000);
      dbms_sql.define_column(l_cur, 3, l_vals);
      l_n := dbms_sql.execute(l_cur);
      while dbms_sql.fetch_rows(l_cur) > 0 loop
        dbms_sql.column_value(l_cur, 1, l_key);
        dbms_sql.column_value(l_cur, 2, l_ver);
        dbms_sql.column_value(l_cur, 3, l_vals);
        l_row := json_object_t();
        l_row.put('key', l_key);
        if l_ver is not null then l_row.put('version', l_ver); else l_row.put_null('version'); end if;
        l_row.put('values', json_object_t.parse(l_vals));
        l_out.append(l_row);
      end loop;
      dbms_sql.close_cursor(l_cur);
    exception when others then
      if dbms_sql.is_open(l_cur) then dbms_sql.close_cursor(l_cur); end if;
      raise;
    end;
    return l_out;
  end sample_rows;

  function get_row (p_source in varchar2, p_key in varchar2,
                    p_context in json_object_t default null) return json_object_t is
    l_src    fc_data_sources%rowtype;
    l_fields t_fields;
    l_binds  t_binds;
    l_sql    varchar2(32767);
    l_cur    integer;
    l_n      integer;
    l_vals   clob;
    l_ver    varchar2(4000);
    l_res    json_object_t;
    l_pay    json_object_t;
    l_out    clob;
  begin
    load_source(p_source, l_src, l_fields);

    if l_src.source_type = 'PLSQL' then
      l_pay := ctx_payload(p_context);
      l_pay.put('key', p_key);
      l_out := call_target(l_src.get_target, l_pay.to_clob);
      if l_out is null or dbms_lob.getlength(l_out) = 0 or trim(dbms_lob.substr(l_out, 10, 1)) = 'null' then return null; end if;
      return json_object_t.parse(l_out);
    end if;

    l_sql := 'select ' || values_expr(l_fields) || ', ' ||
             case when l_src.version_column is not null
                  then 'to_char(t.' || dbms_assert.simple_sql_name(l_src.version_column) || ')'
                  else 'null' end ||
             ' from ' || dbms_assert.qualified_sql_name(l_src.object_name) || ' t' ||
             ' where t.' || dbms_assert.simple_sql_name(l_src.key_column) || ' = :k' || filter_sql(l_src);
    add_bind(l_binds, 'k', p_key);

    l_cur := dbms_sql.open_cursor;
    begin
      dbms_sql.parse(l_cur, l_sql, dbms_sql.native);
      bind_all(l_cur, l_sql, l_binds);
      dbms_sql.define_column(l_cur, 1, l_vals);
      dbms_sql.define_column(l_cur, 2, l_ver, 4000);
      l_n := dbms_sql.execute(l_cur);
      if dbms_sql.fetch_rows(l_cur) > 0 then
        dbms_sql.column_value(l_cur, 1, l_vals);
        dbms_sql.column_value(l_cur, 2, l_ver);
        l_res := json_object_t();
        l_res.put('values', json_object_t.parse(l_vals));
        if l_ver is not null then l_res.put('version', l_ver); else l_res.put_null('version'); end if;
      end if;
      dbms_sql.close_cursor(l_cur);
    exception when others then
      if dbms_sql.is_open(l_cur) then dbms_sql.close_cursor(l_cur); end if;
      raise;
    end;
    return l_res;
  end get_row;

  function update_row (p_source in varchar2, p_key in varchar2, p_version in varchar2,
                       p_original in json_object_t, p_changes in json_object_t,
                       p_context in json_object_t default null) return json_object_t is
    l_src    fc_data_sources%rowtype;
    l_fields t_fields;
    l_binds  t_binds;
    l_keys   json_key_list;
    l_set    varchar2(32767);
    l_where  varchar2(32767);
    l_sql    varchar2(32767);
    l_field  varchar2(100);
    l_cur    integer;
    l_n      integer;
    l_res    json_object_t := json_object_t();
    l_now    json_object_t;
    l_pay    json_object_t;
  begin
    load_source(p_source, l_src, l_fields);

    if l_src.source_type = 'PLSQL' then
      l_pay := ctx_payload(p_context);
      l_pay.put('key', p_key);
      l_pay.put('version', p_version);
      l_pay.put('original', p_original);
      l_pay.put('changes', p_changes);
      return json_object_t.parse(call_target(l_src.update_target, l_pay.to_clob));
    end if;

    l_keys := p_changes.get_keys;
    if l_keys is null or l_keys.count = 0 then
      l_res.put('status', 'ok');
      return l_res;
    end if;

    for i in 1 .. l_keys.count loop
      l_field := l_keys(i);
      if not l_fields.exists(l_field) or l_fields(l_field).updatable <> 'Y' then
        l_res.put('status', 'forbidden');
        l_res.put('message', 'The field "' || l_field || '" cannot be changed.');
        return l_res;
      end if;
      l_set := l_set || case when i > 1 then ', ' end ||
               l_fields(l_field).col || ' = ' || bind_expr('u' || i, l_fields(l_field).data_type);
      add_bind(l_binds, 'u' || i, jstr(p_changes, l_field));
      if l_src.version_column is null then
        -- no version column: optimistic lock on the original values of the changed columns
        l_where := l_where || ' and decode(' || l_fields(l_field).col || ', ' ||
                   bind_expr('o' || i, l_fields(l_field).data_type) || ', 1, 0) = 1';
        add_bind(l_binds, 'o' || i, jstr(p_original, l_field));
      end if;
    end loop;

    if l_src.version_column is not null then
      l_set   := l_set || ', t.' || dbms_assert.simple_sql_name(l_src.version_column) || ' = t.' ||
                 dbms_assert.simple_sql_name(l_src.version_column) || ' + 1';
      l_where := ' and to_char(t.' || dbms_assert.simple_sql_name(l_src.version_column) || ') = :ver';
      add_bind(l_binds, 'ver', p_version);
    end if;

    l_sql := 'update ' || dbms_assert.qualified_sql_name(l_src.object_name) || ' t set ' || l_set ||
             ' where t.' || dbms_assert.simple_sql_name(l_src.key_column) || ' = :k' || l_where || filter_sql(l_src);
    add_bind(l_binds, 'k', p_key);

    l_cur := dbms_sql.open_cursor;
    begin
      dbms_sql.parse(l_cur, l_sql, dbms_sql.native);
      bind_all(l_cur, l_sql, l_binds);
      l_n := dbms_sql.execute(l_cur);
      dbms_sql.close_cursor(l_cur);
    exception when others then
      if dbms_sql.is_open(l_cur) then dbms_sql.close_cursor(l_cur); end if;
      raise;
    end;

    if l_n = 1 then
      l_now := get_row(p_source, p_key, p_context);
      l_res.put('status', 'ok');
      if l_now is not null then l_res.put('version', jstr(l_now, 'version')); end if;
    elsif l_n = 0 then
      l_res.put('status', case when get_row(p_source, p_key, p_context) is null then 'notfound' else 'conflict' end);
    else
      raise_application_error(-20043, 'Update matched ' || l_n || ' rows; key_column must be unique.');
    end if;
    return l_res;
  end update_row;

end fc_data;
/

