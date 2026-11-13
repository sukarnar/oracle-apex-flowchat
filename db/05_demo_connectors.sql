--------------------------------------------------------------------------------
-- Demo target tables + connectors for the loan_application sample flow.
-- Connector contract: function f(p_payload in clob) return clob
--   payload : {sessionId, flowId, nodeId, slots:{...}, context:{...}, slot?, value?}
--   validator returns {"valid": true|false, "message": "..."}
--   lookup    returns {"found": true|false, "slots": {...}, "message": "..."}
--   submit    returns {"ok": true|false, "slots": {...}, "message": "..."}
--------------------------------------------------------------------------------

create table fc_demo_customers (
  customer_id  number         not null,
  email        varchar2(320)  not null,
  full_name    varchar2(200)  not null,
  constraint fc_demo_customers_pk primary key (customer_id),
  constraint fc_demo_customers_uk unique (email)
);

insert into fc_demo_customers values (1001, 'jane.doe@example.com', 'Jane Doe');
insert into fc_demo_customers values (1002, 'raj.kumar@example.com', 'Raj Kumar');

create table fc_demo_loan_apps (
  app_id          number generated always as identity,
  reference       varchar2(20),
  session_id      varchar2(32),
  customer_id     number,
  email           varchar2(320)  not null,
  applicant_name  varchar2(200)  not null,
  amount          number         not null,
  purpose         varchar2(20)   not null,
  annual_income   number,
  start_date      date           not null,
  contact_ok      varchar2(1),
  phone           varchar2(40),
  created_at      timestamp with time zone default systimestamp not null,
  constraint fc_demo_loan_apps_pk primary key (app_id)
);

create or replace package fc_demo_connectors authid definer as
  function check_email         (p_payload in clob) return clob;
  function lookup_customer     (p_payload in clob) return clob;
  function check_affordability (p_payload in clob) return clob;
  function create_application  (p_payload in clob) return clob;
end fc_demo_connectors;
/

create or replace package body fc_demo_connectors as

  function result_valid (p_valid in boolean, p_message in varchar2 default null) return clob is
    l json_object_t := json_object_t();
  begin
    l.put('valid', p_valid);
    if p_message is not null then l.put('message', p_message); end if;
    return l.to_clob;
  end result_valid;

  function money (p in number) return varchar2 is
  begin
    return '$' || to_char(p, 'FM999G999G999G990', 'NLS_NUMERIC_CHARACTERS=''.,''');
  end money;

  function check_email (p_payload in clob) return clob is
    l_p      json_object_t := json_object_t.parse(p_payload);
    l_domain varchar2(320) := lower(substr(l_p.get_string('value'), instr(l_p.get_string('value'), '@') + 1));
  begin
    if l_domain in ('mailinator.com', 'tempmail.com', '10minutemail.com') then
      return result_valid(false, 'Please use a permanent email address. Disposable inboxes aren''t accepted.');
    end if;
    return result_valid(true);
  end check_email;

  function lookup_customer (p_payload in clob) return clob is
    l_p     json_object_t := json_object_t.parse(p_payload);
    l_email varchar2(320) := l_p.get_object('slots').get_string('email');
    l_res   json_object_t := json_object_t();
    l_slots json_object_t := json_object_t();
  begin
    for r in (select customer_id, full_name from fc_demo_customers where email = l_email) loop
      l_slots.put('customer_id', r.customer_id);
      l_slots.put('applicant_name', r.full_name);
      l_res.put('found', true);
      l_res.put('slots', l_slots);
      l_res.put('message', 'Welcome back, ' || regexp_substr(r.full_name, '^\S+') || '! I found your customer record.');
      return l_res.to_clob;
    end loop;
    l_res.put('found', false);
    return l_res.to_clob;
  end lookup_customer;

  function check_affordability (p_payload in clob) return clob is
    l_p      json_object_t := json_object_t.parse(p_payload);
    l_income number := l_p.get_number('value');
    l_amount number := l_p.get_object('slots').get_number('amount');
  begin
    if l_amount > l_income * 5 then
      return result_valid(false, 'With an income of ' || money(l_income) || ', the most we can lend is '
                                 || money(l_income * 5) || ' (5x income). Check the figure, or use Back to change the amount.');
    end if;
    return result_valid(true);
  end check_affordability;

  function create_application (p_payload in clob) return clob is
    l_p     json_object_t := json_object_t.parse(p_payload);
    l_s     json_object_t := l_p.get_object('slots');
    l_id    number;
    l_ref   varchar2(20);
    l_res   json_object_t := json_object_t();
    l_slots json_object_t := json_object_t();
    r       fc_demo_loan_apps%rowtype;
  begin
    -- Copy JSON values into PL/SQL variables first; JSON object methods can't be used inside SQL.
    r.session_id     := l_p.get_string('sessionId');
    r.customer_id    := case when l_s.has('customer_id')   then l_s.get_number('customer_id')   end;
    r.email          := l_s.get_string('email');
    r.applicant_name := l_s.get_string('applicant_name');
    r.amount         := l_s.get_number('amount');
    r.purpose        := l_s.get_string('purpose');
    r.annual_income  := case when l_s.has('annual_income') then l_s.get_number('annual_income') end;
    r.start_date     := to_date(l_s.get_string('start_date'), 'YYYY-MM-DD');
    r.contact_ok     := l_s.get_string('contact_ok');
    r.phone          := case when r.contact_ok = 'Y' then l_s.get_string('phone') end;

    insert into fc_demo_loan_apps
      (session_id, customer_id, email, applicant_name, amount, purpose, annual_income, start_date, contact_ok, phone)
    values
      (r.session_id, r.customer_id, r.email, r.applicant_name, r.amount, r.purpose, r.annual_income,
       r.start_date, r.contact_ok, r.phone)
    returning app_id into l_id;

    l_ref := 'LN-' || lpad(l_id, 5, '0');
    update fc_demo_loan_apps set reference = l_ref where app_id = l_id;

    l_slots.put('reference', l_ref);
    l_res.put('ok', true);
    l_res.put('slots', l_slots);
    return l_res.to_clob;
  exception
    when others then
      l_res.put('ok', false);
      l_res.put('message', 'Sorry, we couldn''t save your application. Please try again.');
      return l_res.to_clob;
  end create_application;

end fc_demo_connectors;
/

insert into fc_connectors (connector_id, connector_type, target, description) values
  ('check_email', 'PLSQL', 'fc_demo_connectors.check_email', 'Rejects disposable email domains');
insert into fc_connectors (connector_id, connector_type, target, description) values
  ('lookup_customer', 'PLSQL', 'fc_demo_connectors.lookup_customer', 'Prefills name for known customers');
insert into fc_connectors (connector_id, connector_type, target, description) values
  ('check_affordability', 'PLSQL', 'fc_demo_connectors.check_affordability', 'Loan <= 5x annual income');
insert into fc_connectors (connector_id, connector_type, target, description) values
  ('create_application', 'PLSQL', 'fc_demo_connectors.create_application', 'Inserts the loan application');

commit;
