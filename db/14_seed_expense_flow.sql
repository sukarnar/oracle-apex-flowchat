-- Phase E demo: the expense_claim flow (Repeat line items, a file answer, a PII answer, debug rows)
-- and its submit connector. Safe to re-run (publishes a new version each time).
set define off

create or replace package fc_demo_expenses authid definer as
  -- submit: {slots: {employee, bank_account, lines: [{description, amount, date}], receipt: {id, name, size, mimeType}}}
  function submit_claim (p_payload in clob) return clob;
end fc_demo_expenses;
/

create or replace package body fc_demo_expenses as
  function submit_claim (p_payload in clob) return clob is
    l_p     json_object_t := json_object_t.parse(p_payload);
    l_slots json_object_t := l_p.get_object('slots');
    l_lines json_array_t  := l_slots.get_array('lines');
    l_file  json_object_t := l_slots.get_object('receipt');
    l_sid   varchar2(32)  := l_p.get_string('sessionId');
    l_total number := 0;
    l_bytes number;
    l_res   json_object_t := json_object_t();
    l_out   json_object_t := json_object_t();
  begin
    for i in 0 .. l_lines.get_size - 1 loop
      l_total := l_total + treat(l_lines.get(i) as json_object_t).get_number('amount');
    end loop;
    -- The receipt's content is in FC_FILES; only this conversation's files can be read.
    select max(dbms_lob.getlength(content)) into l_bytes
      from fc_files
     where file_id = l_file.get_string('id') and session_id = l_sid;
    if l_bytes is null then
      l_res.put('ok', false);
      l_res.put('message', 'The receipt is missing. Please attach it again.');
      return l_res.to_clob;
    end if;
    l_out.put('reference', 'EXP-' || to_char(sysdate, 'YYMMDD') || '-' || substr(l_sid, 1, 4));
    l_res.put('ok', true);
    l_res.put('slots', l_out);
    l_res.put('message', 'Total claimed: $' || to_char(l_total, 'FM999G999G990D00', 'NLS_NUMERIC_CHARACTERS=''.,''') || '.');
    return l_res.to_clob;
  end submit_claim;
end fc_demo_expenses;
/

merge into fc_connectors c
using (select 'submit_claim' connector_id from dual) s
   on (c.connector_id = s.connector_id)
 when not matched then insert (connector_id, connector_type, target, description)
      values ('submit_claim', 'PLSQL', 'fc_demo_expenses.submit_claim', 'Phase E demo: totals the expense lines and checks the receipt');
commit;


-- flows/expense_claim.json
declare
  l_def     clob;
  l_version number;
begin
  dbms_lob.createtemporary(l_def, true);
  dbms_lob.append(l_def, q'~{
  "flowId": "expense_claim",
  "name": "Expense claim",
  "version": 1,
  "debug": true,
  "start": "welcome",
  "bindings": {
    "employee": {
      "dom": "#employee",
      "apex": "P20_EMPLOYEE"
    },
    "bank_account": {
      "dom": "#bank_account",
      "apex": "P20_BANK_ACCOUNT"
    },
    "lines": {
      "dom": "#lines",
      "apex": "P20_LINES"
    },
    "receipt": {
      "dom": "#receipt",
      "apex": "P20_RECEIPT"
    },
    "reference": {
      "dom": "#reference",
      "apex": "P20_REFERENCE"
    }
  },
  "nodes": [
    {
      "id": "welcome",
      "type": "message",
      "text": "Let's put your expense claim together.",
      "next": "ask_employee"
    },
    {
      "id": "ask_employee",
      "type": "ask",
      "slot": "employee",
      "label": "Your name",
      "prompt": "What's your name?",
      "input": {
        "kind": "text",
        "minLength": 2
      },
      "next": "ask_bank"
    },
    {
      "id": "ask_bank",
      "type": "ask",
      "slot": "bank_account",
      "label": "Bank account",
      "pii": "last4",
      "prompt": "Which bank account should we pay into? (Logs only ever show its last 4 digits.)",
      "input": {
        "kind": "text",
        "minLength": 6,
        "maxLength": 34
      },
      "next": "lines"
    },
    {
      "id": "lines",
      "type": "repeat",
      "slot": "lines",
      "label": "Expenses",
      "itemLabel": "expense",
      "min": 1,
      "max": 10,
      "prompt": "Now the expenses, one at a time.",
      "itemTitle": "{{description}} ({{amount}}, {{date}})",
      "fields": [
        {
          "field": "description",
          "label": "Description",
          "prompt": "What was expense {{n}} for?",
          "input": {
            "kind": "text",
            "maxLength": 80
          }
        },
        {
          "field": "amount",
          "label": "Amount",
          "prompt": "How much was {{description}}?",
          "input": {
            "kind": "number",
            "prefix": "$",
            "min": 0.01,
            "max": 5000
          }
        },
        {
          "field": "date",
          "label": "Date",
          "prompt": "When was it?",
          "input": {
            "kind": "date",
            "maxDate": "today"
          }
        }
      ],
      "next": "check_total"
    },
    {
      "id": "check_total",
      "type": "condition",
      "branches": [
        {
          "when": {
            "slot": "lines.count",
            "op": ">",
            "value": 3
          },
          "next": "many"
        }
      ],
      "else": "ask_receipt"
    },
    {
      "id": "many",
      "type": "message",
      "text": "That's {{lines}} expenses, so a single combined receipt or statement is fine.",
      "next": "ask_receipt"
    },
    {
      "id": "ask_receipt",
      "type": "ask",
      "slot": "receipt",
      "label": "Receipts",
      "prompt": "Please attach your receipts as one PDF or photo.",
      "input": {
        "kind": "file",
        "accept": [
          ".pdf",
          "image/*"
        ],
        "maxSizeKb": 5120
      },
      "next": "review"
    },
    {
      "id": "review",
      "type": "summary",
      "text": "Here's your claim. Please check it:",
      "confirmLabel": "Submit claim",
      "next": "submit"
    },
    {
      "id": "submit",
      "type": "submit",
      "connector": "submit_claim",
      "onSuccess": "done",
      "onError": "review"
    },
    {
      "id": "done",
      "type": "end",
      "text": "Thanks {{employee}}! Claim {{reference}} with {{lines}} expenses is submitted."
    }
  ]
}~');
  l_version := fc_engine.publish_flow(l_def);
  dbms_output.put_line('Published expense_claim version ' || l_version);
  commit;
end;
/
