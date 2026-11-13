-- FlowChat installer. Run as the APEX application's parsing schema:
--   sql user/pass@db @install.sql            (SQLcl, or SQL*Plus, or SQL Workshop > SQL Scripts)
-- Prerequisite (run once as ADMIN/SYS):  grant execute on sys.dbms_crypto to <schema>;
set define off
set serveroutput on
whenever sqlerror exit failure rollback

prompt == Tables
@@01_tables.sql
prompt == Engine
@@02_fc_engine.pks
@@03_fc_engine.pkb
show errors package body fc_engine
prompt == Demo connectors
@@04_demo_connectors.sql
prompt == Sample flow
@@05_seed_flow.sql
-- Optional REST API for non-APEX pages:
-- @@06_ords_module.sql
prompt == Done
