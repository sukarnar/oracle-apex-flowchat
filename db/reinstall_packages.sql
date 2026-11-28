-- Re-creates the FlowChat packages in dependency order WITHOUT touching tables or data.
-- Use it after an upgrade or a compile fix:   sql user/pass@db @reinstall_packages.sql
--   FC_DATA  <-  FC_ENGINE  <-  FC_DESIGNER, FC_CLIENT  <-  FC_TEAMS (only if installed)
set define off
set serveroutput on

prompt == FC_DATA
@@02b_fc_data.sql
prompt == FC_ENGINE
@@03_fc_engine.pks
@@04_fc_engine.pkb
prompt == FC_DESIGNER
@@09_fc_designer.sql
prompt == FC_CLIENT
@@19_fc_client.sql
prompt == FC_TEAMS: recompiled if installed (install it with 20_fc_teams.sql)
begin
  for p in (select object_type from user_objects where object_name = 'FC_TEAMS' and object_type in ('PACKAGE', 'PACKAGE BODY')) loop
    execute immediate 'alter package fc_teams compile ' || case p.object_type when 'PACKAGE BODY' then 'body' else 'package' end;
  end loop;
exception when others then
  null;   -- the errors are listed below
end;
/

prompt == Compilation errors (no rows = all good)
column name format a20
column text format a90
select name, type, line, position, text
  from user_errors
 where name in ('FC_DATA', 'FC_ENGINE', 'FC_DESIGNER', 'FC_CLIENT', 'FC_TEAMS', 'FC_DEMO_CONNECTORS', 'FC_DEMO_VERIFY')
 order by name, type, sequence;

prompt == Object status
select object_name, object_type, status
  from user_objects
 where object_name in ('FC_DATA', 'FC_ENGINE', 'FC_DESIGNER', 'FC_CLIENT', 'FC_TEAMS', 'FC_DEMO_CONNECTORS', 'FC_DEMO_VERIFY')
 order by object_name, object_type;
