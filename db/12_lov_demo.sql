--------------------------------------------------------------------------------
-- Lookup list demo: FC_DEMO_BRANCHES and the lists "countries" and "branches"
-- used by the loan_application sample (country, then a branch in that country). Safe to re-run.
-- Requires 02c_lovs.sql. Mirrors demo/demo-lovs.js.
--------------------------------------------------------------------------------
begin
  execute immediate q'~
    create table fc_demo_branches (
      branch_id     number        not null,
      country_code  varchar2(2)   not null,
      country_name  varchar2(100) not null,
      branch_name   varchar2(200) not null,
      constraint fc_demo_branches_pk primary key (branch_id)
    )~';
exception when others then
  if sqlcode <> -955 then raise; end if;   -- ORA-00955: already exists
end;
/

delete from fc_demo_branches;
insert into fc_demo_branches values (101, 'AU', 'Australia', 'Sydney CBD');
insert into fc_demo_branches values (102, 'AU', 'Australia', 'Melbourne Collins St');
insert into fc_demo_branches values (111, 'BR', 'Brazil', unistr('S\00E3o Paulo Paulista'));
insert into fc_demo_branches values (121, 'CA', 'Canada', 'Toronto Bay St');
insert into fc_demo_branches values (122, 'CA', 'Canada', 'Vancouver Burrard');
insert into fc_demo_branches values (123, 'CA', 'Canada', unistr('Montr\00E9al Centre-Ville'));
insert into fc_demo_branches values (131, 'DE', 'Germany', 'Berlin Mitte');
insert into fc_demo_branches values (132, 'DE', 'Germany', 'Frankfurt Zeil');
insert into fc_demo_branches values (141, 'FR', 'France', unistr('Paris Op\00E9ra'));
insert into fc_demo_branches values (151, 'IN', 'India', 'Mumbai Fort');
insert into fc_demo_branches values (152, 'IN', 'India', 'Bengaluru MG Road');
insert into fc_demo_branches values (153, 'IN', 'India', 'Delhi Connaught Place');
insert into fc_demo_branches values (161, 'IE', 'Ireland', 'Dublin Grafton St');
insert into fc_demo_branches values (171, 'JP', 'Japan', 'Tokyo Marunouchi');
insert into fc_demo_branches values (181, 'MX', 'Mexico', 'Mexico City Reforma');
insert into fc_demo_branches values (191, 'NZ', 'New Zealand', 'Auckland Queen St');
insert into fc_demo_branches values (201, 'SG', 'Singapore', 'Singapore Raffles Place');
insert into fc_demo_branches values (211, 'GB', 'United Kingdom', 'London City');
insert into fc_demo_branches values (212, 'GB', 'United Kingdom', 'Manchester Spinningfields');
insert into fc_demo_branches values (221, 'US', 'United States', 'New York Midtown');
insert into fc_demo_branches values (222, 'US', 'United States', 'Chicago Loop');
insert into fc_demo_branches values (223, 'US', 'United States', 'San Francisco FiDi');

delete from fc_lovs where lov_id in ('countries', 'branches');
insert into fc_lovs (lov_id, lov_type, query, description)
values ('countries', 'SQL',
        'select country_code, country_name from fc_demo_branches group by country_code, country_name order by 2',
        'Demo: countries that have a branch');
-- :COUNTRY is bound from the flow's  "optionsParams": {"country": "country"}
insert into fc_lovs (lov_id, lov_type, query, description)
values ('branches', 'SQL',
        'select branch_id, branch_name from fc_demo_branches where country_code = :COUNTRY order by branch_name',
        'Demo: branches in one country (parameter: country)');

commit;
