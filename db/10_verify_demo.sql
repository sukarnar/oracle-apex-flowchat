--------------------------------------------------------------------------------
-- Phase D demo: Verify step (one-time code) for public pages. Safe to re-run.
--   * FC_DEMO_OUTBOX       : where the demo "sends" codes (no mail server needed)
--   * FC_DEMO_VERIFY       : the send_code connector
--   * connector send_code  : registered in FC_CONNECTORS
--   * loan_apps_public     : the loan_apps table, limited to rows of the verified email
-- Requires 05_demo_connectors.sql and 06_demo_data_source.sql.
--------------------------------------------------------------------------------
begin
  execute immediate q'~
    create table fc_demo_outbox (
      msg_id     number generated always as identity primary key,
      sent_at    timestamp with time zone default systimestamp not null,
      channel    varchar2(20),
      recipient  varchar2(320),
      body       varchar2(4000)
    )~';
exception when others then
  if sqlcode <> -955 then raise; end if;   -- ORA-00955: already exists
end;
/

create or replace package fc_demo_verify authid definer as
  -- Verify-step connector. Receives the usual payload plus
  --   {"channel": "email"|"sms", "to": "...", "code": "123456", "ttlMinutes": 10}
  -- and returns {"ok": true} or {"ok": false, "message": "..."}.
  function send_code (p_payload in clob) return clob;
end fc_demo_verify;
/

create or replace package body fc_demo_verify as
  function send_code (p_payload in clob) return clob is
    l_in   json_object_t := json_object_t.parse(p_payload);
    l_to   varchar2(320) := l_in.get_string('to');
    l_body varchar2(4000);
    l_out  json_object_t := json_object_t();
  begin
    l_body := 'Your verification code is ' || l_in.get_string('code') ||
              '. It expires in ' || l_in.get_number('ttlMinutes') || ' minutes.';

    -- DEMO ONLY: the message (with the code) is stored in FC_DEMO_OUTBOX so you can read it
    -- without a mail server. For real use, send it and store nothing, for example:
    --   apex_mail.send(p_to => l_to, p_from => 'no-reply@yourcompany.com',
    --                  p_subj => 'Your verification code', p_body => l_body);
    --   apex_mail.push_queue;
    -- or call your SMS gateway with apex_web_service when channel = 'sms'.
    insert into fc_demo_outbox (channel, recipient, body)
    values (l_in.get_string('channel'), l_to, l_body);

    l_out.put('ok', true);
    return l_out.to_clob;
  exception when others then
    apex_debug.error('fc_demo_verify.send_code failed: %s', sqlerrm);
    l_out.put('ok', false);
    l_out.put('message', 'Sorry, I couldn''t send the code. Please try again later.');
    return l_out.to_clob;
  end send_code;
end fc_demo_verify;
/

delete from fc_connectors where connector_id = 'send_code';
insert into fc_connectors (connector_id, connector_type, target, description)
values ('send_code', 'PLSQL', 'fc_demo_verify.send_code', 'Verify step: delivers a one-time code (demo writes to FC_DEMO_OUTBOX)');

-- Same table as loan_apps, but every search/get/update only sees rows of the verified email.
-- :FC_VERIFIED is null until the conversation passes a Verify step, so nothing is visible before that.
delete from fc_data_sources where source_id = 'loan_apps_public';   -- fields go with it (on delete cascade)
insert into fc_data_sources (source_id, source_type, object_name, key_column, version_column, row_filter, description)
values ('loan_apps_public', 'TABLE', 'fc_demo_loan_apps', 'app_id', 'version',
        'upper(t.email) = upper(:FC_VERIFIED)',
        'Demo loan applications for public pages: only rows of the verified email');
insert into fc_data_source_fields (source_id, field, column_name, data_type, label, searchable, search_ops, updatable, mask)
select 'loan_apps_public', field, column_name, data_type, label, searchable, search_ops, updatable, mask
  from fc_data_source_fields
 where source_id = 'loan_apps';

commit;
