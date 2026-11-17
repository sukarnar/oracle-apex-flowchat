-- Upgrades an existing FlowChat install with the Agent node (Phase F):
--   * FC_AI_PROVIDERS, FC_AI_TOOLS, FC_AI_SKILLS
--   * FC_ENGINE (agent loop) and FC_DESIGNER (lists providers, tools and skills for the designer)
--   * Agent Phase 2: pick_record, file answers, set_field, PII placeholders
--     (adds FC_AI_TOOLS.TITLE_TEMPLATE and SUBTITLE_TEMPLATE to an existing install)
-- Run from this folder as the parsing schema:   sql user/pass@db @upgrade_phase_f.sql
-- Tables and your data are kept. Re-running it is safe.
set define off
set serveroutput on

prompt == Agent registries (FC_AI_PROVIDERS, FC_AI_TOOLS, FC_AI_SKILLS)
@@15_ai_tables.sql

@@reinstall_packages.sql

exit
