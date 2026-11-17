-- Upgrades an existing FlowChat install with the REST call node:
--   * FC_REST_ENDPOINTS (the APIs a REST call node may call)
--   * FC_ENGINE (the "rest" node) and FC_DESIGNER (lists the endpoints for the designer)
--   * Agent REST tools: FC_AI_TOOLS.REQUEST and TOOL_TYPE = 'REST'
-- Run from this folder as the parsing schema:   sql user/pass@db @upgrade_phase_g.sql
-- Needs the Agent tables first: run @upgrade_phase_f.sql before it if you haven't.
-- Tables and your data are kept. Re-running it is safe.
set define off
set serveroutput on

prompt == Agent registries (adds FC_AI_TOOLS.REQUEST and the REST tool type)
@@15_ai_tables.sql

prompt == REST endpoint registry (FC_REST_ENDPOINTS)
@@17_rest_endpoints.sql

@@reinstall_packages.sql

exit
