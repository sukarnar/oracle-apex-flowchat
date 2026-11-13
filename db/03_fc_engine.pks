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
  ------------------------------------------------------------------------------

  function start_session (p_flow_id in varchar2, p_context in clob default null) return clob;
  function handle_input  (p_session_id in varchar2, p_input in clob) return clob;

  -- Repository helpers
  function publish_flow  (p_definition in clob, p_status in varchar2 default 'PUBLISHED') return number;
  procedure purge_expired;

  -- HTTP entry points -------------------------------------------------------
  -- APEX Ajax Callback processes: FC_START -> fc_engine.apex_start; FC_INPUT -> fc_engine.apex_input
  --   apex_start: x01 = flow id, x02 = context JSON
  --   apex_input: x01 = session id, x02 = input JSON
  procedure apex_start;
  procedure apex_input;

  -- ORDS handlers (see 06_ords_module.sql)
  procedure ords_start (p_body in clob);
  procedure ords_input (p_session_id in varchar2, p_body in clob);

  -- Writes JSON to the HTTP buffer. p_status <> null also emits status line + headers (ORDS).
  procedure http_out (p_json in clob, p_status in number default null);
end fc_engine;
/
