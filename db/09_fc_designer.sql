--------------------------------------------------------------------------------
-- FC_DESIGNER: back end for the FlowChat Designer when it is hosted on an APEX page.
--
-- Setup on the designer page:
--   1. One page-level Ajax Callback process named FC_DESIGNER:   fc_designer.ajax;
--   2. Protect the PAGE with an authorization scheme. Anyone who can open the page can
--      create, publish and retire flows and change data source definitions.
--   3. Region source: <div id="fcd-root" data-backend="apex" data-flows-base="#APP_FILES#"></div>
--
-- Protocol: x01 = action, p_clob_01 = JSON payload.
--           Response: {"ok":true,"data":...}  or  {"error":"...","code":"conflict|exists|invalid|in_use"}
--------------------------------------------------------------------------------
create or replace package fc_designer authid definer as
  procedure ajax;
  -- Same as ajax, callable from SQL*Plus / tests.
  function dispatch (p_action in varchar2, p_payload in clob) return clob;
end fc_designer;
/

create or replace package body fc_designer as

  c_nls constant varchar2(40) := 'NLS_NUMERIC_CHARACTERS=''.,''';

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

  function jbool (p_obj in json_object_t, p_key in varchar2) return boolean is
  begin
    return p_obj is not null and p_obj.has(p_key) and p_obj.get(p_key).is_true;
  end jbool;

  function current_user_name return varchar2 is
  begin
    return coalesce(sys_context('APEX$SESSION', 'APP_USER'), user);
  end current_user_name;

  function ok (p_data in json_element_t) return clob is
    l json_object_t := json_object_t();
  begin
    l.put('ok', true);
    if p_data is null then l.put_null('data'); else l.put('data', p_data); end if;
    return l.to_clob;
  end ok;

  ------------------------------------------------------------------------------
  -- flows
  ------------------------------------------------------------------------------
  function list_flows return clob is
    l_arr  json_array_t := json_array_t();
    l_f    json_object_t;
    l_vs   json_array_t;
    l_v    json_object_t;
  begin
    for f in (select flow_id, name from fc_flows order by lower(nvl(name, flow_id))) loop
      l_f := json_object_t();
      l_f.put('flowId', f.flow_id);
      l_f.put('name', f.name);
      l_vs := json_array_t();
      for v in (select version, status, created_by, to_char(created_at, 'YYYY-MM-DD HH24:MI') created
                  from fc_flow_versions
                 where flow_id = f.flow_id
                 order by version desc
                 fetch first 25 rows only) loop
        l_v := json_object_t();
        l_v.put('version', v.version);
        l_v.put('status', v.status);
        l_v.put('createdBy', v.created_by);
        l_v.put('createdAt', v.created);
        l_vs.append(l_v);
      end loop;
      l_f.put('versions', l_vs);
      l_arr.append(l_f);
    end loop;
    return ok(l_arr);
  end list_flows;

  function load_flow (p_in in json_object_t) return clob is
    l_flow_id fc_flow_versions.flow_id%type := jstr(p_in, 'flowId');
    l_version number := to_number(jstr(p_in, 'version'));
    l_def     clob;
    l_status  fc_flow_versions.status%type;
    l_out     json_object_t := json_object_t();
  begin
    if l_version is null then
      select max(version) into l_version from fc_flow_versions where flow_id = l_flow_id;
    end if;
    begin
      select definition, status into l_def, l_status
        from fc_flow_versions
       where flow_id = l_flow_id and version = l_version;
    exception when no_data_found then
      raise_application_error(-20054, 'Flow "' || l_flow_id || '" version ' || l_version || ' was not found.');
    end;
    l_out.put('definition', json_object_t.parse(l_def));
    l_out.put('version', l_version);
    l_out.put('status', l_status);
    return ok(l_out);
  end load_flow;

  -- Structural checks before publishing (the designer's checklist does the detailed ones).
  function validation_errors (p_def in json_object_t) return varchar2 is
    l_nodes  json_array_t;
    l_n      json_object_t;
    l_ids    json_object_t := json_object_t();
    l_errs   varchar2(4000);
    l_br     json_array_t;
    l_ports  constant sys.odcivarchar2list := sys.odcivarchar2list(
               'next', 'else', 'onNotFound', 'onSuccess', 'onError', 'found', 'notFound', 'tooMany', 'cancelled',
               'done', 'noChanges', 'saved', 'conflict', 'forbidden', 'error', 'verified', 'failed', 'none', 'partial');
    l_types  constant varchar2(200) := ',message,ask,condition,lookup,summary,submit,end,verify,findRecord,changeFields,saveChanges,repeat,bulkUpdate,';
    procedure err (p in varchar2) is
    begin
      if length(l_errs) > 3500 then return; end if;
      l_errs := l_errs || case when l_errs is not null then '; ' end || p;
    end err;
    procedure check_target (p_from in varchar2, p_to in varchar2) is
    begin
      if p_to is not null and not l_ids.has(p_to) then err(p_from || ' points to missing node "' || p_to || '"'); end if;
    end check_target;
  begin
    if not regexp_like(nvl(jstr(p_def, 'flowId'), '-'), '^[a-z0-9_]{1,100}$') then err('flowId must be lowercase letters, digits and _'); end if;
    if not p_def.has('nodes') or not p_def.get('nodes').is_array then return 'nodes array missing'; end if;
    l_nodes := p_def.get_array('nodes');
    for i in 0 .. l_nodes.get_size - 1 loop
      l_n := treat(l_nodes.get(i) as json_object_t);
      if jstr(l_n, 'id') is null then err('node #' || (i + 1) || ' has no id');
      elsif l_ids.has(jstr(l_n, 'id')) then err('duplicate node id "' || jstr(l_n, 'id') || '"');
      else l_ids.put(jstr(l_n, 'id'), true);
      end if;
      if instr(l_types, ',' || jstr(l_n, 'type') || ',') = 0 then err('node "' || jstr(l_n, 'id') || '" has unknown type "' || jstr(l_n, 'type') || '"'); end if;
    end loop;
    if not l_ids.has(nvl(jstr(p_def, 'start'), '-')) then err('start node is missing'); end if;
    for i in 0 .. l_nodes.get_size - 1 loop
      l_n := treat(l_nodes.get(i) as json_object_t);
      for p in 1 .. l_ports.count loop
        check_target(jstr(l_n, 'id') || '.' || l_ports(p), jstr(l_n, l_ports(p)));
      end loop;
      if l_n.has('branches') and l_n.get('branches').is_array then
        l_br := l_n.get_array('branches');
        for b in 0 .. l_br.get_size - 1 loop
          check_target(jstr(l_n, 'id') || '.branch' || (b + 1), jstr(treat(l_br.get(b) as json_object_t), 'next'));
        end loop;
      end if;
    end loop;
    return l_errs;
  end validation_errors;

  -- Saves the definition as a draft (or published) version.
  --   * latest version is a DRAFT and equals baseVersion -> updated in place
  --   * otherwise a new version (latest + 1) is inserted
  --   * baseVersion must equal the latest version (someone else may have saved) unless force=true
  function save_version (p_in in json_object_t, p_publish in boolean) return clob is
    l_def      json_object_t;
    l_flow_id  fc_flows.flow_id%type;
    l_name     fc_flows.name%type;
    l_base     number := to_number(jstr(p_in, 'baseVersion'));
    l_force    boolean := jbool(p_in, 'force');
    l_latest   number;
    l_lstatus  fc_flow_versions.status%type;
    l_version  number;
    l_status   fc_flow_versions.status%type := case when p_publish then 'PUBLISHED' else 'DRAFT' end;
    l_errs     varchar2(4000);
    l_clob     clob;
    l_user     varchar2(255) := current_user_name;
    l_out      json_object_t := json_object_t();
  begin
    if not p_in.has('definition') or not p_in.get('definition').is_object then
      raise_application_error(-20050, 'INVALID: definition missing.');
    end if;
    l_def     := p_in.get_object('definition');
    l_flow_id := jstr(l_def, 'flowId');
    l_name    := jstr(l_def, 'name');
    if not regexp_like(nvl(l_flow_id, '-'), '^[a-z0-9_]{1,100}$') then
      raise_application_error(-20050, 'INVALID: flowId must be lowercase letters, digits and _.');
    end if;
    if p_publish then
      l_errs := validation_errors(l_def);
      if l_errs is not null then raise_application_error(-20050, 'INVALID: ' || l_errs); end if;
    end if;

    select max(version) into l_latest from fc_flow_versions where flow_id = l_flow_id;
    if l_latest is not null then
      select status into l_lstatus from fc_flow_versions where flow_id = l_flow_id and version = l_latest;
      if not l_force then
        if l_base is null then
          raise_application_error(-20052, 'EXISTS: A flow with id "' || l_flow_id || '" already exists (latest version ' || l_latest || ').');
        elsif l_base <> l_latest then
          raise_application_error(-20051, 'CONFLICT: Someone else saved "' || l_flow_id || '" meanwhile (now version ' || l_latest || ').');
        end if;
      end if;
    end if;

    merge into fc_flows f
    using (select l_flow_id flow_id, l_name name from dual) s
       on (f.flow_id = s.flow_id)
     when matched then update set f.name = nvl(s.name, f.name)
     when not matched then insert (flow_id, name) values (s.flow_id, s.name);

    if l_latest is not null and l_lstatus = 'DRAFT' then
      l_version := l_latest;
      l_def.put('version', l_version);
      l_clob := l_def.to_clob;
      update fc_flow_versions
         set definition = l_clob, status = l_status, created_by = l_user, created_at = systimestamp
       where flow_id = l_flow_id and version = l_version;
    else
      l_version := nvl(l_latest, 0) + 1;
      l_def.put('version', l_version);
      l_clob := l_def.to_clob;
      insert into fc_flow_versions (flow_id, version, status, definition, created_by)
      values (l_flow_id, l_version, l_status, l_clob, l_user);
    end if;

    if p_publish then
      -- Running conversations keep their pinned version whatever its status.
      update fc_flow_versions set status = 'RETIRED'
       where flow_id = l_flow_id and status = 'PUBLISHED' and version <> l_version;
    end if;

    l_out.put('flowId', l_flow_id);
    l_out.put('version', l_version);
    l_out.put('status', l_status);
    return ok(l_out);
  end save_version;

  ------------------------------------------------------------------------------
  -- data sources
  ------------------------------------------------------------------------------
  function list_sources return clob is
    l_cat  json_object_t := json_object_t();
    l_src  json_object_t;
    l_flds json_array_t;
    l_f    json_object_t;
  begin
    for s in (select * from fc_data_sources order by source_id) loop
      l_src := json_object_t();
      l_src.put('sourceType', s.source_type);
      l_src.put('objectName', s.object_name);
      l_src.put('keyColumn', s.key_column);
      l_src.put('versionColumn', s.version_column);
      l_src.put('rowFilter', s.row_filter);
      l_src.put('enabled', s.enabled = 'Y');
      if s.source_type = 'PLSQL' then
        l_src.put('searchTarget', s.search_target);
        l_src.put('getTarget', s.get_target);
        l_src.put('updateTarget', s.update_target);
      end if;
      l_flds := json_array_t();
      for f in (select * from fc_data_source_fields where source_id = s.source_id order by field) loop
        l_f := json_object_t();
        l_f.put('field', f.field);
        l_f.put('column', f.column_name);
        l_f.put('type', f.data_type);
        l_f.put('searchable', f.searchable = 'Y');
        l_f.put('ops', f.search_ops);
        l_f.put('updatable', f.updatable = 'Y');
        if f.mask is not null then l_f.put('mask', f.mask); end if;
        l_flds.append(l_f);
      end loop;
      l_src.put('fields', l_flds);
      l_cat.put(s.source_id, l_src);
    end loop;
    return ok(l_cat);
  end list_sources;

  -- Splits "schema.object" (or "object") into owner and name, upper-cased.
  procedure split_name (p_name in varchar2, p_owner out varchar2, p_obj out varchar2) is
    l_dot pls_integer := instr(p_name, '.');
  begin
    if l_dot > 0 then
      p_owner := upper(substr(p_name, 1, l_dot - 1));
      p_obj   := upper(substr(p_name, l_dot + 1));
    else
      p_owner := sys_context('USERENV', 'CURRENT_SCHEMA');
      p_obj   := upper(p_name);
    end if;
  end split_name;

  function column_exists (p_owner in varchar2, p_obj in varchar2, p_col in varchar2) return boolean is
    l_n pls_integer;
  begin
    select count(*) into l_n from all_tab_columns
     where owner = p_owner and table_name = p_obj and column_name = upper(p_col);
    return l_n > 0;
  end column_exists;

  function save_source (p_in in json_object_t) return clob is
    l_id     fc_data_sources.source_id%type := jstr(p_in, 'id');
    l_def    json_object_t;
    l_flds   json_array_t;
    l_f      json_object_t;
    l_owner  varchar2(128);
    l_obj    varchar2(128);
    l_type   fc_data_sources.source_type%type;
    l_warn   json_array_t := json_array_t();
    l_n      pls_integer;
    l_out    json_object_t := json_object_t();
    -- locals for SQL (no package functions inside SQL statements)
    v_obj    varchar2(261);
    v_key    varchar2(128);
    v_ver    varchar2(128);
    v_filter varchar2(4000);
    v_field  varchar2(100);
    v_col    varchar2(128);
    v_dtype  varchar2(20);
    v_srch   varchar2(1);
    v_ops    varchar2(100);
    v_upd    varchar2(1);
    v_mask   varchar2(20);
  begin
    if not regexp_like(nvl(l_id, '-'), '^[a-z][a-z0-9_]{0,99}$') then
      raise_application_error(-20050, 'INVALID: data source id must be lowercase letters, digits and _.');
    end if;
    if not p_in.has('def') or not p_in.get('def').is_object then
      raise_application_error(-20050, 'INVALID: definition missing.');
    end if;
    l_def := p_in.get_object('def');
    begin
      select source_type into l_type from fc_data_sources where source_id = l_id;
    exception when no_data_found then l_type := null;
    end;
    if l_type = 'PLSQL' then
      raise_application_error(-20050, 'INVALID: "' || l_id || '" is a PL/SQL data source; change it in the database.');
    end if;

    v_obj    := jstr(l_def, 'objectName');
    v_key    := upper(jstr(l_def, 'keyColumn'));
    v_ver    := upper(jstr(l_def, 'versionColumn'));
    v_filter := jstr(l_def, 'rowFilter');
    if v_obj is null or v_key is null then
      raise_application_error(-20050, 'INVALID: table and key column are required.');
    end if;
    v_obj := dbms_assert.qualified_sql_name(v_obj);
    v_key := dbms_assert.simple_sql_name(v_key);
    if v_ver is not null then v_ver := dbms_assert.simple_sql_name(v_ver); end if;

    -- Integrity warnings (not fatal: the object may live in another schema the designer can't see)
    split_name(v_obj, l_owner, l_obj);
    select count(*) into l_n from all_tab_columns where owner = l_owner and table_name = l_obj;
    if l_n = 0 then
      l_warn.append('Table or view ' || l_owner || '.' || l_obj || ' was not found or is not visible.');
    else
      if not column_exists(l_owner, l_obj, v_key) then l_warn.append('Key column ' || v_key || ' does not exist.'); end if;
      if v_ver is not null and not column_exists(l_owner, l_obj, v_ver) then l_warn.append('Version column ' || v_ver || ' does not exist.'); end if;
    end if;

    delete from fc_data_sources where source_id = l_id;   -- fields cascade
    insert into fc_data_sources (source_id, source_type, object_name, key_column, version_column, row_filter)
    values (l_id, 'TABLE', v_obj, v_key, v_ver, v_filter);

    if l_def.has('fields') and l_def.get('fields').is_array then
      l_flds := l_def.get_array('fields');
      for i in 0 .. l_flds.get_size - 1 loop
        l_f     := treat(l_flds.get(i) as json_object_t);
        v_field := jstr(l_f, 'field');
        v_col   := dbms_assert.simple_sql_name(upper(nvl(jstr(l_f, 'column'), v_field)));
        v_dtype := nvl(jstr(l_f, 'type'), 'VARCHAR2');
        v_srch  := case when jbool(l_f, 'searchable') then 'Y' else 'N' end;
        v_ops   := nvl(jstr(l_f, 'ops'), 'eq');
        v_upd   := case when jbool(l_f, 'updatable') then 'Y' else 'N' end;
        v_mask  := jstr(l_f, 'mask');
        if l_n > 0 and not column_exists(l_owner, l_obj, v_col) then
          l_warn.append('Column ' || v_col || ' (field ' || v_field || ') does not exist.');
        end if;
        insert into fc_data_source_fields (source_id, field, column_name, data_type, searchable, search_ops, updatable, mask)
        values (l_id, v_field, v_col, v_dtype, v_srch, v_ops, v_upd, v_mask);
      end loop;
    end if;

    l_out.put('id', l_id);
    l_out.put('warnings', l_warn);
    return ok(l_out);
  end save_source;

  function delete_source (p_in in json_object_t) return clob is
    l_id    varchar2(100) := jstr(p_in, 'id');
    l_flows varchar2(4000);
  begin
    -- refuse while a published flow still searches this source
    select listagg(distinct flow_id || ' v' || version, ', ') within group (order by flow_id)
      into l_flows
      from fc_flow_versions
     where status = 'PUBLISHED'
       and json_exists(definition, '$.nodes[*]?(@.source == $s)' passing l_id as "s");
    if l_flows is not null then
      raise_application_error(-20053, 'IN_USE: "' || l_id || '" is used by published flow(s): ' || l_flows || '.');
    end if;
    delete from fc_data_sources where source_id = l_id;
    return ok(null);
  end delete_source;

  function list_tables (p_in in json_object_t) return clob is
    l_q   varchar2(128) := upper(trim(jstr(p_in, 'q')));
    l_arr json_array_t := json_array_t();
    l_o   json_object_t;
  begin
    for t in (select object_name, object_type
                from user_objects
               where object_type in ('TABLE', 'VIEW')
                 and object_name not like 'BIN$%'
                 and (l_q is null or instr(object_name, l_q) > 0)
               order by object_name
               fetch first 200 rows only) loop
      l_o := json_object_t();
      l_o.put('name', t.object_name);
      l_o.put('type', t.object_type);
      l_arr.append(l_o);
    end loop;
    return ok(l_arr);
  end list_tables;

  function describe_table (p_in in json_object_t) return clob is
    l_name varchar2(128) := upper(trim(jstr(p_in, 'name')));
    l_n    pls_integer;
    l_cols json_array_t := json_array_t();
    l_pk   json_array_t := json_array_t();
    l_c    json_object_t;
    l_out  json_object_t := json_object_t();
  begin
    select count(*) into l_n from user_objects where object_name = l_name and object_type in ('TABLE', 'VIEW');
    if l_n = 0 then raise_application_error(-20054, 'Table or view ' || l_name || ' was not found.'); end if;
    for c in (select column_name, data_type, nullable, data_length from user_tab_columns
               where table_name = l_name order by column_id) loop
      l_c := json_object_t();
      l_c.put('column', c.column_name);
      l_c.put('dataType', c.data_type);
      l_c.put('nullable', c.nullable = 'Y');
      l_c.put('length', c.data_length);
      l_cols.append(l_c);
    end loop;
    for p in (select cc.column_name
                from user_constraints k
                join user_cons_columns cc on cc.constraint_name = k.constraint_name
               where k.table_name = l_name and k.constraint_type = 'P'
               order by cc.position) loop
      l_pk.append(p.column_name);
    end loop;
    l_out.put('name', l_name);
    l_out.put('columns', l_cols);
    l_out.put('pk', l_pk);
    return ok(l_out);
  end describe_table;

  function sample_rows (p_in in json_object_t) return clob is
  begin
    return ok(fc_data.sample_rows(jstr(p_in, 'id'), nvl(to_number(jstr(p_in, 'limit')), 20)));
  end sample_rows;

  function list_connectors return clob is
    l_arr json_array_t := json_array_t();
    l_o   json_object_t;
  begin
    for c in (select connector_id, connector_type, description from fc_connectors where enabled = 'Y' order by connector_id) loop
      l_o := json_object_t();
      l_o.put('id', c.connector_id);
      l_o.put('type', c.connector_type);
      l_o.put('description', c.description);
      l_arr.append(l_o);
    end loop;
    return ok(l_arr);
  end list_connectors;

  -- Lookup lists, with the parameters each SQL list binds (:NAME other than :APP_USER / :FC_VERIFIED).
  function list_lovs return clob is
    l_arr   json_array_t := json_array_t();
    l_o     json_object_t;
    l_ps    json_array_t;
    l_name  varchar2(128);
    l_seen  varchar2(4000);
    l_i     pls_integer;
  begin
    for c in (select lov_id, lov_type, query, target, description from fc_lovs where enabled = 'Y' order by lov_id) loop
      l_o  := json_object_t();
      l_ps := json_array_t();
      l_o.put('id', c.lov_id);
      l_o.put('type', c.lov_type);
      l_o.put('description', c.description);
      if c.lov_type = 'SQL' then
        l_o.put('query', c.query);
        l_seen := ',';
        l_i := 1;
        loop
          l_name := lower(regexp_substr(c.query, ':([A-Za-z][A-Za-z0-9_]*)', 1, l_i, null, 1));
          exit when l_name is null;
          if l_name not in ('app_user', 'fc_verified') and instr(l_seen, ',' || l_name || ',') = 0 then
            l_ps.append(l_name);
            l_seen := l_seen || l_name || ',';
          end if;
          l_i := l_i + 1;
        end loop;
      else
        l_o.put('target', c.target);
      end if;
      l_o.put('params', l_ps);
      l_arr.append(l_o);
    end loop;
    return ok(l_arr);
  end list_lovs;

  -- Options of a lookup list for the designer's Test tab: {"id", "params": {...}}.
  function lov_options (p_in in json_object_t) return clob is
    l_params json_object_t;
  begin
    if p_in.has('params') and p_in.get('params').is_object then l_params := p_in.get_object('params');
    else l_params := json_object_t();
    end if;
    return ok(fc_data.lov_options(jstr(p_in, 'id'), l_params));
  end lov_options;

  ------------------------------------------------------------------------------
  function dispatch (p_action in varchar2, p_payload in clob) return clob is
    l_in json_object_t;
  begin
    if p_payload is null or dbms_lob.getlength(p_payload) = 0 then l_in := json_object_t();
    else l_in := json_object_t.parse(p_payload);
    end if;
    case p_action
      when 'listFlows'      then return list_flows;
      when 'loadFlow'       then return load_flow(l_in);
      when 'saveDraft'      then return save_version(l_in, false);
      when 'publish'        then return save_version(l_in, true);
      when 'listSources'    then return list_sources;
      when 'saveSource'     then return save_source(l_in);
      when 'deleteSource'   then return delete_source(l_in);
      when 'listTables'     then return list_tables(l_in);
      when 'describeTable'  then return describe_table(l_in);
      when 'sampleRows'     then return sample_rows(l_in);
      when 'listConnectors' then return list_connectors;
      when 'listLovs'       then return list_lovs;
      when 'lovOptions'     then return lov_options(l_in);
      else raise_application_error(-20055, 'Unknown designer action "' || p_action || '".');
    end case;
  end dispatch;

  function error_json return clob is
    l      json_object_t := json_object_t();
    l_msg  varchar2(4000) := regexp_replace(sqlerrm, '^ORA-[0-9]+: ', '');
  begin
    if sqlcode between -20999 and -20000 then
      l.put('code', case sqlcode when -20051 then 'conflict' when -20052 then 'exists'
                                 when -20050 then 'invalid'  when -20053 then 'in_use' else 'error' end);
      l.put('error', regexp_replace(l_msg, '^(CONFLICT|EXISTS|INVALID|IN_USE): ', ''));
    else
      l.put('code', 'error');
      l.put('error', 'Unexpected server error: ' || l_msg);
      apex_debug.error('FlowChat designer: %s %s', sqlerrm, dbms_utility.format_error_backtrace);
    end if;
    return l.to_clob;
  end error_json;

  procedure ajax is
  begin
    savepoint fc_designer;
    fc_engine.http_out(dispatch(apex_application.g_x01, apex_application.g_clob_01));
  exception when others then
    rollback to fc_designer;
    fc_engine.http_out(error_json);
  end ajax;

end fc_designer;
/
