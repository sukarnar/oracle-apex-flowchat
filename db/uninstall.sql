-- Removes all FlowChat objects (including demo data). Irreversible.
begin ords.delete_module(p_module_name => 'flowchat'); exception when others then null; end;
/
begin ords.delete_module(p_module_name => 'flowchat_teams'); exception when others then null; end;
/
-- Optional Teams objects (20_fc_teams.sql, 22_seed_helpdesk_flow.sql): skipped when not installed.
begin
  for o in (select 'package ' || lower(object_name) stmt from user_objects
             where object_name in ('FC_TEAMS', 'FC_DEMO_HELPDESK') and object_type = 'PACKAGE'
            union all select 'table ' || lower(table_name) || ' cascade constraints purge' from user_tables
             where table_name in ('FC_TEAMS_CONVERSATIONS', 'FC_TEAMS_USERS', 'FC_TEAMS_WEBHOOKS', 'IT_TICKETS')) loop
    execute immediate 'drop ' || o.stmt;
  end loop;
end;
/
drop package fc_client;
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
