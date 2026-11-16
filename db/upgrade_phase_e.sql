-- Upgrades an existing FlowChat install (phases 1 to D) with Phase E:
--   * version pinning (<flow-chat version="3">), resume after a page reload
--   * debug logging (FC_EVENTS rows with direction DBG) and PII masking in FC_EVENTS
--   * Repeat (line items), Bulk update and file answers (FC_FILES)
-- Run from this folder as the parsing schema:   sql user/pass@db @upgrade_phase_e.sql
-- Tables and your data are kept. Re-running it is safe.
set define off
set serveroutput on

prompt == FC_EVENTS: allow debug rows (direction DBG)
begin
  execute immediate 'alter table fc_events drop constraint fc_events_dir_ck';
exception when others then
  if sqlcode <> -2443 then raise; end if;   -- ORA-02443: constraint does not exist
end;
/
alter table fc_events add constraint fc_events_dir_ck check (direction in ('IN', 'OUT', 'DBG'));

prompt == FC_FILES: uploaded answers
declare
  l_n pls_integer;
begin
  select count(*) into l_n from user_tables where table_name = 'FC_FILES';
  if l_n = 0 then
    execute immediate q'[
      create table fc_files (
        file_id      varchar2(32)   not null,
        session_id   varchar2(32)   not null,
        slot         varchar2(200)  not null,
        filename     varchar2(400)  not null,
        mime_type    varchar2(100),
        file_size    number,
        content      blob,
        created_at   timestamp with time zone default systimestamp not null,
        constraint fc_files_pk primary key (file_id),
        constraint fc_files_sess_fk foreign key (session_id) references fc_sessions on delete cascade
      )]';
    execute immediate 'create index fc_files_sess_ix on fc_files (session_id)';
  end if;
end;
/

prompt == Packages (FC_DATA, FC_ENGINE, FC_DESIGNER)
@@reinstall_packages.sql

prompt == Sample flow expense_claim (Repeat, file answer, PII, debug)
@@14_seed_expense_flow.sql

prompt == Done. Debug rows:  select * from fc_events where direction = 'DBG' order by event_id desc;
