-- Upgrades an existing FlowChat install (phases 1 to C) with the Phase D Verify step.
-- Run from this folder as the parsing schema:   sql user/pass@db @upgrade_phase_d.sql
-- Tables and your data are kept. Re-running it is safe.
set define off
set serveroutput on

prompt == Packages (FC_DATA, FC_ENGINE, FC_DESIGNER)
@@reinstall_packages.sql
prompt == Verify step demo (send_code connector, loan_apps_public)
@@10_verify_demo.sql
prompt == Sample flow update_application_public
@@11_seed_public_flow.sql
prompt == Done. Read the codes the demo "sends" with:  select * from fc_demo_outbox order by msg_id desc;
