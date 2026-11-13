-- FlowChat installer. Run as the APEX application's parsing schema, from this folder:
--   sql user/pass@db @install.sql            (SQLcl, or SQL*Plus, or SQL Workshop > SQL Scripts in this order)
-- Prerequisite (run once as ADMIN/SYS):  grant execute on sys.dbms_crypto to <schema>;
set define off
set serveroutput on
whenever sqlerror exit failure rollback

prompt == Repository and runtime tables
@@01_tables.sql
prompt == Data source registry
@@02_data_sources.sql
prompt == FC_DATA (search / get / update)
@@02b_fc_data.sql
show errors package body fc_data
prompt == Engine
@@03_fc_engine.pks
@@04_fc_engine.pkb
show errors package body fc_engine
prompt == Demo connectors and tables
@@05_demo_connectors.sql
prompt == Demo data source (loan_apps)
@@06_demo_data_source.sql
prompt == Sample flows (loan_application, update_application)
@@07_seed_flows.sql
prompt == Designer back end (FC_DESIGNER Ajax Callback)
@@09_fc_designer.sql
show errors package body fc_designer
prompt == Verify step demo (send_code connector, loan_apps_public)
@@10_verify_demo.sql
prompt == Sample flow update_application_public
@@11_seed_public_flow.sql
-- Optional REST API for non-APEX pages:
-- @@08_ords_module.sql
prompt == Done
