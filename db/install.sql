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
prompt == Lookup list registry (FC_LOVS)
@@02c_lovs.sql
prompt == Agent registries (FC_AI_PROVIDERS, FC_AI_TOOLS, FC_AI_SKILLS)
@@15_ai_tables.sql
prompt == REST endpoint registry (FC_REST_ENDPOINTS)
@@17_rest_endpoints.sql
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
prompt == Batch mode (FC_CLIENT.RUN: run a flow from PL/SQL)
@@19_fc_client.sql
show errors package body fc_client
prompt == Verify step demo (send_code connector, loan_apps_public)
@@10_verify_demo.sql
prompt == Sample flow update_application_public
@@11_seed_public_flow.sql
prompt == Lookup list demo (countries, branches)
@@12_lov_demo.sql
prompt == Sample flow loan_application (country and branch lookup lists)
@@13_seed_loan_flow.sql
prompt == Phase E demo: expense_claim (line items, file answer, PII, debug)
@@14_seed_expense_flow.sql
-- Optional REST API for non-APEX pages:
-- @@08_ords_module.sql
-- Optional Microsoft Teams outgoing webhooks (FC_TEAMS and its REST endpoint):
-- @@20_fc_teams.sql
-- @@21_fc_teams_ords.sql
-- @@22_seed_helpdesk_flow.sql     (the Teams sample flow it_helpdesk; it runs on APEX pages too)
-- Optional Power Automate + Adaptive Cards in Teams (FC_AUTOMATE and its REST endpoint):
-- @@23_fc_automate.sql
-- @@24_fc_automate_ords.sql
-- Optional posts to Teams channels (FC_CHANNEL, the "Post to Teams" step; needs a network ACL):
-- @@25_fc_channel.sql
prompt == Done

exit
