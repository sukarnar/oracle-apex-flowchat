create or replace package fc_engine authid definer as
  ------------------------------------------------------------------------------
  -- FlowChat execution engine (server-authoritative).
  -- Semantics mirror widget/flowchat-engine.js; both implement the same turn protocol.
  --
  -- Turn (JSON returned by start_session / handle_input):
  --   { sessionId, flowId, version, status: in_progress|completed|failed,
  --     messages: [{type: text|error|success|summary, text, items?}],
  --     await: {type: ask|summary, nodeId, slot, label, input, value} | null,
  --     fieldUpdates: [{slot, value, display, binding}],
  --     progress: {done, total}, canGoBack }
  --
  -- Input payload for handle_input:
  --   {"value": "..."}                       answer the current question / "confirm" a summary
  --   {"command": "back" | "restart"}
  --   {"command": "edit", "slot": "amount"}  change an answer from the summary
  --   {"command": "resend"}                  Verify step: send a new one-time code
  --   {"command": "resume"}                  repeat the current question (after a page reload)
  --   {"command": "add" | "done"}            Repeat step: add an item / finish the list
  --   {"command": "remove", "index": 0}      Repeat step: remove an item
  --   {"command": "confirm" | "cancel"}      Bulk update: go ahead / change nothing
  --   {"file": {"name", "mimeType", "data"}} file answer (base64), stored in FC_FILES
  --
  -- Logging: every IN/OUT row in FC_EVENTS has PII values masked ("pii" on a question or field,
  -- or the flow's "piiSlots"). Debug rows (direction DBG) are written for flows with "debug": true,
  -- or for every flow after set_debug(true) in this database session; APEX debug also gets them.
  ------------------------------------------------------------------------------

  -- p_version pins a published version; null = the latest published version.
  function start_session (p_flow_id in varchar2, p_context in clob default null,
                          p_version in number default null) return clob;
  function handle_input  (p_session_id in varchar2, p_input in clob) return clob;

  -- Repository helpers
  function publish_flow  (p_definition in clob, p_status in varchar2 default 'PUBLISHED') return number;
  procedure purge_expired;

  -- Debug rows for every conversation handled by this database session (for example in a test script).
  procedure set_debug (p_on in boolean default true);

  -- HTTP entry points -------------------------------------------------------
  -- APEX Ajax Callback processes: FC_START -> fc_engine.apex_start; FC_INPUT -> fc_engine.apex_input
  --   apex_start: x01 = flow id, x02 = context JSON, x03 = version (optional)
  --   apex_input: x01 = session id, x02 = input JSON (or p_clob_01 when it is larger than 8K)
  procedure apex_start;
  procedure apex_input;

  -- ORDS handlers (see 06_ords_module.sql)
  procedure ords_start (p_body in clob);
  procedure ords_input (p_session_id in varchar2, p_body in clob);

  -- Writes JSON to the HTTP buffer. p_status <> null also emits status line + headers (ORDS).
  procedure http_out (p_json in clob, p_status in number default null);
end fc_engine;
/
