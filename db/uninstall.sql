-- Removes all FlowChat objects (including demo data). Irreversible.
begin ords.delete_module(p_module_name => 'flowchat'); exception when others then null; end;
/
drop package fc_designer;
drop package fc_demo_connectors;
drop package fc_demo_verify;
drop package fc_demo_expenses;
drop package fc_engine;
drop package fc_data;
drop table fc_demo_loan_apps purge;
drop table fc_demo_outbox purge;
drop table fc_demo_branches purge;
drop table fc_ai_providers purge;
drop table fc_ai_tools purge;
drop table fc_ai_skills purge;
drop table fc_rest_endpoints purge;
drop table fc_lovs purge;
drop table fc_demo_customers purge;
drop table fc_data_source_fields purge;
drop table fc_data_sources purge;
drop table fc_files purge;
drop table fc_events purge;
drop table fc_sessions purge;
drop table fc_connectors purge;
drop table fc_flow_versions purge;
drop table fc_flows purge;

exit
