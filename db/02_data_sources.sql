--------------------------------------------------------------------------------
-- Data sources: server-side registry used by findRecord / changeFields / saveChanges nodes.
-- Flows reference a source by id only; table names, columns and filters live here.
--
--   TABLE : FC_DATA builds parameterised SQL from the registered columns (no code to write).
--           row_filter is trusted admin SQL appended to every search/get/update; it may use
--           :APP_USER (bound to the APEX user) to restrict rows to the current user.
--   PLSQL : your functions implement the contract (see fc_data spec), each
--           function f(p_payload in clob) return clob.
--------------------------------------------------------------------------------

create table fc_data_sources (
  source_id       varchar2(100)  not null,
  source_type     varchar2(20)   default 'TABLE' not null,
  object_name     varchar2(261),
  key_column      varchar2(128),
  version_column  varchar2(128),
  row_filter      varchar2(4000),
  search_target   varchar2(261),
  get_target      varchar2(261),
  update_target   varchar2(261),
  description     varchar2(4000),
  enabled         varchar2(1)    default 'Y' not null,
  constraint fc_data_sources_pk primary key (source_id),
  constraint fc_data_sources_type_ck check (source_type in ('TABLE', 'PLSQL')),
  constraint fc_data_sources_en_ck check (enabled in ('Y', 'N')),
  constraint fc_data_sources_tab_ck check (source_type <> 'TABLE' or (object_name is not null and key_column is not null)),
  constraint fc_data_sources_pls_ck check (source_type <> 'PLSQL' or (search_target is not null and get_target is not null and update_target is not null))
);

create table fc_data_source_fields (
  source_id    varchar2(100)  not null,
  field        varchar2(100)  not null,
  column_name  varchar2(128)  not null,
  data_type    varchar2(20)   default 'VARCHAR2' not null,
  label        varchar2(200),
  searchable   varchar2(1)    default 'N' not null,
  search_ops   varchar2(100)  default 'eq' not null,
  updatable    varchar2(1)    default 'N' not null,
  mask         varchar2(20),
  constraint fc_ds_fields_pk primary key (source_id, field),
  constraint fc_ds_fields_src_fk foreign key (source_id) references fc_data_sources on delete cascade,
  constraint fc_ds_fields_name_ck check (regexp_like(field, '^[a-z][a-z0-9_]{0,99}$')),
  constraint fc_ds_fields_type_ck check (data_type in ('VARCHAR2', 'NUMBER', 'DATE')),
  constraint fc_ds_fields_srch_ck check (searchable in ('Y', 'N')),
  constraint fc_ds_fields_upd_ck check (updatable in ('Y', 'N')),
  constraint fc_ds_fields_mask_ck check (mask is null or mask in ('last4'))
);
