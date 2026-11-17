-- Agent node registries. Safe to re-run: existing tables and rows are kept.
--
--   FC_AI_PROVIDERS : the models an Agent node may call (any OpenAI-style chat completions API:
--                     vLLM, Ollama, LM Studio, LiteLLM, ...). Flows refer to a provider by id only;
--                     the API key lives in an APEX Web Credential, never in a flow or in this table.
--   FC_AI_TOOLS     : what an agent may do: call a connector, read a lookup list, search a data
--                     source. A tool marked IS_WRITE = 'Y' runs only after the user confirms it.
--   FC_AI_SKILLS    : instructions an agent loads on demand (only names and descriptions are in
--                     the prompt until the agent asks for one).

declare
  procedure ddl (p_table in varchar2, p_sql in varchar2) is
    l_n pls_integer;
  begin
    select count(*) into l_n from user_tables where table_name = p_table;
    if l_n = 0 then execute immediate p_sql; end if;
  end ddl;
begin
  ddl('FC_AI_PROVIDERS', q'[
    create table fc_ai_providers (
      provider_id    varchar2(100)  not null,
      api_style      varchar2(20)   default 'openai' not null,
      base_url       varchar2(1000) not null,
      model          varchar2(200)  not null,
      credential_id  varchar2(255),
      wallet_path    varchar2(1000),
      tool_mode      varchar2(10)   default 'native' not null,
      temperature    number         default 0.2,
      max_tokens     number         default 1024,
      timeout_secs   number         default 120,
      extra_headers  clob,
      description    varchar2(4000),
      enabled        varchar2(1)    default 'Y' not null,
      constraint fc_ai_providers_pk primary key (provider_id),
      constraint fc_ai_providers_style_ck check (api_style in ('openai')),
      constraint fc_ai_providers_mode_ck check (tool_mode in ('native', 'json')),
      constraint fc_ai_providers_hdr_ck check (extra_headers is json),
      constraint fc_ai_providers_en_ck check (enabled in ('Y', 'N'))
    )]');
  ddl('FC_AI_TOOLS', q'[
    create table fc_ai_tools (
      tool_id        varchar2(64)   not null,
      tool_type      varchar2(20)   not null,
      target         varchar2(200)  not null,
      description    varchar2(4000) not null,
      parameters     clob,
      is_write       varchar2(1)    default 'N' not null,
      needs_confirm  varchar2(1)    default 'Y' not null,
      confirm_text   varchar2(4000),
      max_rows       number         default 10,
      title_template    varchar2(4000),
      subtitle_template varchar2(4000),
      enabled        varchar2(1)    default 'Y' not null,
      constraint fc_ai_tools_pk primary key (tool_id),
      constraint fc_ai_tools_id_ck check (regexp_like(tool_id, '^[a-z][a-z0-9_]{0,63}$')),
      constraint fc_ai_tools_type_ck check (tool_type in ('CONNECTOR', 'LOV', 'SEARCH')),
      constraint fc_ai_tools_par_ck check (parameters is json),
      constraint fc_ai_tools_w_ck check (is_write in ('Y', 'N') and needs_confirm in ('Y', 'N') and enabled in ('Y', 'N'))
    )]');
  ddl('FC_AI_SKILLS', q'[
    create table fc_ai_skills (
      skill_id     varchar2(100)  not null,
      name         varchar2(200)  not null,
      description  varchar2(4000) not null,
      content      clob           not null,
      enabled      varchar2(1)    default 'Y' not null,
      constraint fc_ai_skills_pk primary key (skill_id),
      constraint fc_ai_skills_en_ck check (enabled in ('Y', 'N'))
    )]');
end;
/

-- Agent Phase 2: card text for pick_record (added to installs made before it)
declare
  procedure add_col (p_col in varchar2) is
    l_n pls_integer;
  begin
    select count(*) into l_n from user_tab_columns where table_name = 'FC_AI_TOOLS' and column_name = p_col;
    if l_n = 0 then
      execute immediate 'alter table fc_ai_tools add (' || lower(p_col) || ' varchar2(4000))';
      dbms_output.put_line('FC_AI_TOOLS.' || p_col || ' added');
    end if;
  end add_col;
begin
  add_col('TITLE_TEMPLATE');
  add_col('SUBTITLE_TEMPLATE');
end;
/

comment on column fc_ai_tools.title_template is 'SEARCH tools: the title of each card pick_record shows, e.g. {{last_name}}, {{first_name}} (default: the first three values)';
comment on column fc_ai_tools.subtitle_template is 'SEARCH tools: the card subtitle, e.g. {{department}}';
comment on column fc_ai_providers.base_url is 'Up to and including /v1, e.g. https://llm.corp.local/v1 (the engine adds /chat/completions)';
comment on column fc_ai_providers.credential_id is 'Static id of an APEX Web Credential (e.g. HTTP header Authorization = Bearer <key>); null when the endpoint needs no key';
comment on column fc_ai_providers.wallet_path is 'Oracle wallet with the corporate CA (and a client certificate for mTLS), e.g. file:/u01/wallets/llm; auto-login (cwallet.sso). Null = the APEX instance wallet';
comment on column fc_ai_providers.tool_mode is 'native = the API''s tool calling; json = the engine asks for one JSON object per reply (for models whose tool calling is unreliable)';
comment on column fc_ai_tools.parameters is 'JSON schema of the arguments, e.g. {"type":"object","properties":{"emp_id":{"type":"string"}},"required":["emp_id"]}';
comment on column fc_ai_tools.target is 'CONNECTOR: FC_CONNECTORS id (receives the usual payload plus "tool" and "args"); LOV: FC_LOVS id (args = its parameters); SEARCH: FC_DATA_SOURCES id (row filter applies)';

-- Example (edit, then run once):
--
-- insert into fc_ai_providers (provider_id, base_url, model, credential_id, wallet_path, description)
-- values ('corp_gpt_oss', 'https://llm.corp.local/v1', 'openai/gpt-oss-120b', 'LLM_API_KEY', null,
--         'GPT OSS 120B on the internal vLLM cluster');
--
-- insert into fc_ai_tools (tool_id, tool_type, target, description, parameters)
-- values ('get_leave_balance', 'CONNECTOR', 'leave_balance', 'Leave balance (days) of an employee by type',
--         '{"type":"object","properties":{"emp_id":{"type":"string"}},"required":["emp_id"]}');
--
-- insert into fc_ai_skills (skill_id, name, description, content)
-- values ('leave_policy', 'Leave policy', 'Rules for annual and sick leave', 'Annual leave needs two weeks notice. ...');
-- commit;
