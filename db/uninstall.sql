-- Removes all FlowChat objects (including demo data). Irreversible.
begin ords.delete_module(p_module_name => 'flowchat'); exception when others then null; end;
/
drop package fc_demo_connectors;
drop package fc_engine;
drop table fc_demo_loan_apps purge;
drop table fc_demo_customers purge;
drop table fc_events purge;
drop table fc_sessions purge;
drop table fc_connectors purge;
drop table fc_flow_versions purge;
drop table fc_flows purge;
