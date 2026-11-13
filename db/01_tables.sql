--------------------------------------------------------------------------------
-- FlowChat repository + runtime tables
-- Requires Oracle Database 19c+ (JSON PL/SQL object types, IS JSON constraints)
--------------------------------------------------------------------------------

create table fc_flows (
  flow_id      varchar2(100)  not null,
  name         varchar2(200),
  description  varchar2(4000),
  created_at   timestamp with time zone default systimestamp not null,
  constraint fc_flows_pk primary key (flow_id)
);

create table fc_flow_versions (
  flow_id      varchar2(100)  not null,
  version      number         not null,
  status       varchar2(20)   default 'DRAFT' not null,
  definition   clob           not null,
  created_by   varchar2(255)  default user not null,
  created_at   timestamp with time zone default systimestamp not null,
  constraint fc_flow_versions_pk primary key (flow_id, version),
  constraint fc_flow_versions_flow_fk foreign key (flow_id) references fc_flows,
  constraint fc_flow_versions_status_ck check (status in ('DRAFT', 'PUBLISHED', 'RETIRED')),
  constraint fc_flow_versions_def_ck check (definition is json)
);

-- Server-side actions a flow may call. Flows reference connectors by id only;
-- the browser can never name a procedure or URL.
--   PLSQL: target = function name, signature  function f(p_payload in clob) return clob
--   REST : target = URL; payload is POSTed as JSON, response must be JSON
create table fc_connectors (
  connector_id    varchar2(100)  not null,
  connector_type  varchar2(20)   default 'PLSQL' not null,
  target          varchar2(1000) not null,
  description     varchar2(4000),
  enabled         varchar2(1)    default 'Y' not null,
  constraint fc_connectors_pk primary key (connector_id),
  constraint fc_connectors_type_ck check (connector_type in ('PLSQL', 'REST')),
  constraint fc_connectors_enabled_ck check (enabled in ('Y', 'N'))
);

create table fc_sessions (
  session_id    varchar2(32)   not null,
  flow_id       varchar2(100)  not null,
  version       number         not null,
  status        varchar2(20)   not null,
  state         clob           not null,
  app_user      varchar2(255),
  apex_session  varchar2(64),
  created_at    timestamp with time zone default systimestamp not null,
  updated_at    timestamp with time zone default systimestamp not null,
  expires_at    timestamp with time zone not null,
  constraint fc_sessions_pk primary key (session_id),
  constraint fc_sessions_fv_fk foreign key (flow_id, version) references fc_flow_versions,
  constraint fc_sessions_state_ck check (state is json),
  constraint fc_sessions_status_ck check (status in ('in_progress', 'completed', 'failed'))
);
create index fc_sessions_exp_ix on fc_sessions (expires_at);

-- Transcript / audit trail. Consider masking or purging PII per your retention policy.
create table fc_events (
  event_id     number generated always as identity,
  session_id   varchar2(32)   not null,
  direction    varchar2(3)    not null,
  node_id      varchar2(200),
  payload      clob,
  created_at   timestamp with time zone default systimestamp not null,
  constraint fc_events_pk primary key (event_id),
  constraint fc_events_sess_fk foreign key (session_id) references fc_sessions on delete cascade,
  constraint fc_events_dir_ck check (direction in ('IN', 'OUT')),
  constraint fc_events_payload_ck check (payload is json)
);
create index fc_events_sess_ix on fc_events (session_id, event_id);
