-- Demo configuration: exposes FC_DEMO_LOAN_APPS as the "loan_apps" TABLE data source (used by update_application).
--------------------------------------------------------------------------------
-- Demo: make FC_DEMO_LOAN_APPS updatable through a TABLE data source.
--------------------------------------------------------------------------------
alter table fc_demo_loan_apps add (status varchar2(20) default 'NEW' not null, version number default 1 not null);

insert into fc_data_sources (source_id, source_type, object_name, key_column, version_column, description)
values ('loan_apps', 'TABLE', 'fc_demo_loan_apps', 'app_id', 'version', 'Demo loan applications');
-- For real use, restrict rows to the signed-in user, e.g.:
--   update fc_data_sources set row_filter = 't.email = lower(:APP_USER)' where source_id = 'loan_apps';

insert into fc_data_source_fields (source_id, field, column_name, data_type, searchable, search_ops, updatable, mask)
select 'loan_apps', f, c, t, s, o, u, m from (
  select 'reference'  f, 'REFERENCE'      c, 'VARCHAR2' t, 'Y' s, 'eq'        o, 'N' u, null    m from dual union all
  select 'email',        'EMAIL',            'VARCHAR2',   'Y',   'eq',          'N',   null      from dual union all
  select 'purpose',      'PURPOSE',          'VARCHAR2',   'N',   'eq',          'N',   null      from dual union all
  select 'status',       'STATUS',           'VARCHAR2',   'N',   'eq',          'N',   null      from dual union all
  select 'amount',       'AMOUNT',           'NUMBER',     'N',   'eq',          'Y',   null      from dual union all
  select 'phone',        'PHONE',            'VARCHAR2',   'N',   'eq',          'Y',   'last4'   from dual union all
  select 'start_date',   'START_DATE',       'DATE',       'N',   'eq',          'Y',   null      from dual union all
  select 'contact_ok',   'CONTACT_OK',       'VARCHAR2',   'N',   'eq',          'Y',   null      from dual);

commit;
