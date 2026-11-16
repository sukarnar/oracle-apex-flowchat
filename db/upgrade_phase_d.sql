-- Upgrades an existing FlowChat install (phases 1 to C) with Phase D:
--   * the Verify step (one-time code) for public pages
--   * lookup lists (FC_LOVS): choice options loaded from the database
-- Run from this folder as the parsing schema:   sql user/pass@db @upgrade_phase_d.sql
-- Tables and your data are kept. Re-running it is safe (each run publishes new versions of the sample flows).
set define off
set serveroutput on

prompt == Lookup list registry (FC_LOVS)
@@02c_lovs.sql
prompt == Packages (FC_DATA, FC_ENGINE, FC_DESIGNER)
@@reinstall_packages.sql
prompt == Verify step demo (send_code connector, loan_apps_public)
@@10_verify_demo.sql
prompt == Sample flow update_application_public
@@11_seed_public_flow.sql
prompt == Lookup list demo (countries, branches)
@@12_lov_demo.sql
prompt == Sample flow loan_application (now asks for a country and a branch)
@@13_seed_loan_flow.sql
prompt == Done. Read the codes the demo "sends" with:  select * from fc_demo_outbox order by msg_id desc;

exit
