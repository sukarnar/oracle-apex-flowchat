-- Re-creates the FlowChat packages in dependency order WITHOUT touching tables or data.
-- Use it after an upgrade or a compile fix:   sql user/pass@db @reinstall_packages.sql
--   FC_DATA  <-  FC_ENGINE  <-  FC_DESIGNER
set define off
set serveroutput on

prompt == FC_DATA
@@02b_fc_data.sql
prompt == FC_ENGINE
@@03_fc_engine.pks
@@04_fc_engine.pkb
prompt == FC_DESIGNER
@@09_fc_designer.sql

prompt == Compilation errors (no rows = all good)
column name format a20
column text format a90
select name, type, line, position, text
  from user_errors
 where name in ('FC_DATA', 'FC_ENGINE', 'FC_DESIGNER', 'FC_DEMO_CONNECTORS', 'FC_DEMO_VERIFY')
 order by name, type, sequence;

prompt == Object status
select object_name, object_type, status
  from user_objects
 where object_name in ('FC_DATA', 'FC_ENGINE', 'FC_DESIGNER', 'FC_DEMO_CONNECTORS', 'FC_DEMO_VERIFY')
 order by object_name, object_type;
