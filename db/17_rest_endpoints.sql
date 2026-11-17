-- REST call node registry. Safe to re-run: an existing table and its rows are kept.
--
--   FC_REST_ENDPOINTS : the REST APIs a flow's REST call node may call. A flow names only the
--                       endpoint id plus a relative path, so flows never hold a host name or a
--                       secret. Keys go in an APEX Web Credential (CREDENTIAL_STATIC_ID), or in
--                       EXTRA_HEADERS (sent with every call; a flow can't override them).
--   ALLOWED_METHODS     comma-separated: GET (the default), POST, PUT, PATCH, DELETE.
--
-- The schema that runs APEX_WEB_SERVICE needs a network ACL for the host (see the README), and an
-- https host needs a wallet (WALLET_PATH, or the instance wallet set in APEX).

declare
  l_n pls_integer;
begin
  select count(*) into l_n from user_tables where table_name = 'FC_REST_ENDPOINTS';
  if l_n = 0 then
    execute immediate q'[
      create table fc_rest_endpoints (
        endpoint_id          varchar2(100)  not null,
        base_url             varchar2(1000) not null,
        allowed_methods      varchar2(100)  default 'GET' not null,
        credential_static_id varchar2(255),
        wallet_path          varchar2(1000),
        extra_headers        clob,
        timeout_secs         number         default 20 not null,
        max_response_kb      number         default 1024 not null,
        description          varchar2(4000),
        enabled              varchar2(1)    default 'Y' not null,
        constraint fc_rest_endpoints_pk primary key (endpoint_id),
        constraint fc_rest_endpoints_url_ck check (regexp_like(base_url, '^https?://[^/?#]+')),
        constraint fc_rest_endpoints_m_ck check (regexp_like(upper(replace(allowed_methods, ' ')),
                                                 '^(GET|POST|PUT|PATCH|DELETE)(,(GET|POST|PUT|PATCH|DELETE))*$')),
        constraint fc_rest_endpoints_hdr_ck check (extra_headers is json),
        constraint fc_rest_endpoints_to_ck check (timeout_secs between 1 and 300),
        constraint fc_rest_endpoints_max_ck check (max_response_kb between 1 and 10240),
        constraint fc_rest_endpoints_en_ck check (enabled in ('Y', 'N'))
      )]';
    execute immediate q'[comment on table fc_rest_endpoints is 'FlowChat: REST APIs that REST call nodes may call']';
    execute immediate q'[comment on column fc_rest_endpoints.base_url is 'https://host/path; the node adds a relative path and query']';
    execute immediate q'[comment on column fc_rest_endpoints.credential_static_id is 'APEX Web Credential static id (API key, OAuth2 client credentials, basic)']';
    execute immediate q'[comment on column fc_rest_endpoints.extra_headers is 'JSON object of headers sent on every call; a flow cannot override them']';
  end if;
end;
/

-- Example (not inserted):
--   insert into fc_rest_endpoints (endpoint_id, base_url, allowed_methods, credential_static_id, description)
--   values ('fx_rates', 'https://api.example.com/v1', 'GET', 'FX_API_KEY', 'Exchange rates');
