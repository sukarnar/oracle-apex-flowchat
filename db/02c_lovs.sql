--------------------------------------------------------------------------------
-- Lookup lists (FC_LOVS): server-side option lists for choice answers. Safe to re-run.
-- A flow refers to a list by id only ("optionsFrom": "countries"); the SQL lives here.
--
--   SQL   : query = a SELECT whose first two columns are the value and the label, e.g.
--             select country_code, country_name from countries order by 2
--           Binds available: :APP_USER, :FC_VERIFIED, and one :NAME per parameter the flow passes
--           ("optionsParams": {"country": "country"}  ->  :COUNTRY). At most 500 rows are used.
--   PLSQL : target = function f(p_payload in clob) return clob. Payload:
--             {"lov", "params": {...}, "appUser", "verified", "context"}
--           Returns a JSON array of {"value", "label"}.
-- Run before 02b_fc_data.sql (FC_DATA reads this table).
--------------------------------------------------------------------------------
begin
  execute immediate q'~
    create table fc_lovs (
      lov_id       varchar2(100)  not null,
      lov_type     varchar2(20)   default 'SQL' not null,
      query        varchar2(4000),
      target       varchar2(261),
      description  varchar2(4000),
      enabled      varchar2(1)    default 'Y' not null,
      constraint fc_lovs_pk primary key (lov_id),
      constraint fc_lovs_id_ck check (regexp_like(lov_id, '^[A-Za-z][A-Za-z0-9_]{0,99}$')),
      constraint fc_lovs_type_ck check (lov_type in ('SQL', 'PLSQL')),
      constraint fc_lovs_en_ck check (enabled in ('Y', 'N')),
      constraint fc_lovs_sql_ck check (lov_type <> 'SQL' or query is not null),
      constraint fc_lovs_pls_ck check (lov_type <> 'PLSQL' or target is not null)
    )~';
exception when others then
  if sqlcode <> -955 then raise; end if;   -- ORA-00955: already exists
end;
/
