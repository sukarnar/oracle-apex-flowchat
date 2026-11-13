# FlowChat: conversational forms driven by a flow definition (Phase 1)

**Author:** Sukarna Chinchod

A chat widget you can drop into any page. It asks the questions defined in a flow, validates every
answer on the server, branches on the answers, and fills the page's existing form as it goes.

```
flows/      loan_application.json   sample flow (the "program")
            flow.schema.json        JSON Schema for flow definitions (for the future designer / CI)
designer/   index.html              visual flow designer (no dependencies)
widget/     flowchat.js             <flow-chat> Web Component + transports + adapters (no dependencies)
            flowchat-engine.js      reference engine in JS (demo, simulator, Node backends)
db/         install.sql             runs 01..05 in order (06 ORDS is optional)
            01_tables.sql           FC_FLOWS, FC_FLOW_VERSIONS, FC_CONNECTORS, FC_SESSIONS, FC_EVENTS
            02/03_fc_engine.*       PL/SQL engine (server-authoritative)
            04_demo_connectors.sql  sample lookup / validator / submit connectors + demo tables
            05_seed_flow.sql        generated: publishes flows/loan_application.json
            06_ords_module.sql      REST API for non-APEX hosts
demo/       index.html              runs entirely in the browser using the JS engine
tests/      engine.test.js          node tests/engine.test.js
tools/      build-seed.js           flow JSON -> SQL publish script
```

## 1. Try the demo (no database needed)

```bash
python -m http.server 8765
```
Then open <http://localhost:8765/demo/>. The flow is fetched over HTTP, so opening the file directly won't work.

## 1b. Design flows visually

With the same server running, open <http://localhost:8765/designer/>.

- **Build:** click or drag steps from the palette. Drag a node's bottom dot onto another node to
  connect them; drop it on empty canvas to add a connected step there. Select a node to edit it
  in **Properties**: question, answer type, limits, choice options, extra checks, form binding
  (APEX item / DOM selector), branch conditions and connections.
- **Checklist:** lists errors and warnings (unconnected steps, missing connectors, unknown
  `{{fields}}`, invalid patterns, unreachable nodes). Its field table shows whether each field is
  asked on **every path, some paths, or none** before submit. Tick "Required on the form" on a
  binding to get a warning whenever some path skips that field.
- **Test:** runs the current draft in the built-in chat. Each connector returns an editable mock
  response, with presets such as Accept/Reject or Found/Not found.
- **Save:** your draft autosaves in this browser. **Export JSON** downloads the definition.
  **Publish SQL** downloads a script that publishes it as a new version
  (`fc_engine.publish_flow`). **Open…** loads a `.json` file, and **JSON** lets you edit the raw definition.
- Renaming a field (slot) updates every condition, `{{placeholder}}`, summary list and binding in
  the flow. It does **not** update your PL/SQL connectors, which read slots by name.

Node positions are stored as `ui: {x, y}` on each node. Both engines ignore them.

## 2. Install in Oracle

Requirements: Oracle DB 19c+ (including Autonomous), APEX 20.2+, and execute on `DBMS_CRYPTO` for the session ids:

```sql
grant execute on sys.dbms_crypto to <your_schema>;   -- as ADMIN / SYS
```

Then, connected as the application's parsing schema, from the `db` folder:

```bash
sql <user>/<pass>@<db> @install.sql
```
Or upload each script in SQL Workshop > SQL Scripts and run them in order.

To publish a new or changed flow:

```bash
node tools/build-seed.js flows/my_flow.json > my_flow.sql
```
Run `my_flow.sql`. Each run creates a new version. Sessions that have already started keep the version they started on.

## 3. Add it to an APEX page

1. **Static file:** upload `widget/flowchat.js` under Shared Components > Static Application Files.
2. **Page > JavaScript > File URLs:** `#APP_FILES#flowchat.js` (the PL/SQL engine runs the flow, so `flowchat-engine.js` isn't needed in APEX).
3. **Two Ajax Callback processes** (page or application level):
   | Name | PL/SQL |
   |---|---|
   | `FC_START` | `fc_engine.apex_start;` |
   | `FC_INPUT` | `fc_engine.apex_input;` |
4. **The form:** a normal APEX form region with items whose names match `bindings.*.apex` in the flow
   (`P10_EMAIL`, `P10_AMOUNT`, ...). Give date items the format mask `YYYY-MM-DD`.
5. **The chat:** a Static Content region (e.g. in the right column) with:
   ```html
   <flow-chat flow="loan_application" transport="apex" adapter="apex"
              heading="Loan assistant" context="customer_id:P10_CUSTOMER_ID"></flow-chat>
   ```

The widget picks up Universal Theme colors automatically, because `--fc-accent` falls back to
`--ut-palette-primary`. When the conversation finishes, the Submit connector has already saved
the record. If you'd rather have the page's own processes do the saving, use a flow with no
submit node and add `on-complete="submit-page"`. The page is then submitted with request
`FC_COMPLETE`, with every item already filled.

**Security in APEX:** each conversation is pinned to the APEX session that started it, so a
session id is useless outside that browser session. Connectors are looked up by id in
`FC_CONNECTORS`, which means the browser can never name a procedure or URL to run. Every
answer is validated again on the server immediately before submit.

## 4. Use it on any other page

Run `06_ords_module.sql`, then:

```html
<script src="flowchat.js"></script>
<form id="signup">...<input id="email">...</form>
<flow-chat flow="loan_application" transport="rest" endpoint="https://host/ords/myschema/flowchat"
           adapter="dom" form="#signup"></flow-chat>
```

For React, Angular or Vue, use `adapter="none"` and listen for events, or pass your own adapter:

```js
const chat = document.querySelector('flow-chat');
chat.addEventListener('fc-field', (e) => setFieldValue(e.detail.slot, e.detail.value)); // e.g. react-hook-form setValue
chat.addEventListener('fc-complete', (e) => router.push('/thanks'));
// or: chat.configure({ adapter: { apply(u) {...}, readContext() { return {...}; } } }).start();
```

Secure the ORDS module (OAuth2 / gateway token, CORS allow-list) before exposing it publicly.

## 5. Writing flows

Node types: `message`, `ask`, `condition`, `lookup`, `summary`, `submit`, `end`. The full
reference is in `flows/flow.schema.json`, and `flows/loan_application.json` uses every type.

- **ask** `input.kind`: `text | email | number | date | choice | yesno`. Built-in parsing understands
  `25k`, `$1,250`, `today`, `31/12/2026`, option labels, and option numbers.
  Constraints: `required` (on by default), `min`, `max`, `minLength`, `maxLength`, `minDate`, `maxDate`.
  `validators`: `{type:"regex", pattern, message}` or `{type:"server", connector}`. Write regex
  patterns that work in both JavaScript and Oracle (avoid lookaheads).
- **condition** `when`: `{slot, op, value}` where op is `= != > >= < <= in empty notEmpty`, combined
  with `all`, `any` or `not`. Conditions are structured JSON rather than expressions, so there is
  no expression evaluator to secure.
- **Connectors** are registered in `FC_CONNECTORS` and have the signature
  `function f(p_payload clob) return clob`. A validator returns `{valid,message}`, a lookup returns
  `{found,slots,message}`, and a submit returns `{ok,slots,message}`. Type `REST` POSTs the same
  payload to a URL.
- **Context:** values passed at start (the `context` attribute) whose names match a slot
  pre-fill that slot.

Built-in conversation behaviour:
- **Back:** returns to the previous question.
- **Start over:** clears everything and starts again.
- **Edit from the summary:** after the change, the flow is replayed. Branches are re-evaluated,
  any newly required question is asked, and questions you've already answered are skipped.

## Turn protocol

The server and the widget exchange exactly one JSON shape. Any backend that produces it works with the widget.

```json
{ "sessionId": "9F3A...", "flowId": "loan_application", "version": 1, "status": "in_progress",
  "messages": [ { "type": "error", "text": "The maximum is $500,000." } ],
  "await": { "type": "ask", "nodeId": "ask_amount", "slot": "amount", "label": "Loan amount",
             "input": { "kind": "number", "min": 1000, "max": 500000, "prefix": "$" }, "value": null },
  "fieldUpdates": [ { "slot": "email", "value": "a@b.co", "display": "a@b.co",
                      "binding": { "apex": "P10_EMAIL", "dom": "#email" } } ],
  "progress": { "done": 1, "total": 6 }, "canGoBack": true }
```

## Status and known limits

- The JavaScript engine and widget are tested: 9 unit tests, plus manual end-to-end runs of the demo.
- **The PL/SQL engine has not been compiled yet.** No Oracle instance was available when it was
  written. It mirrors the JavaScript engine rule for rule, but expect a small round of compile
  fixes on first install.
- The designer publishes through a downloaded SQL script. Saving directly to the database
  (an ORDS endpoint for drafts and versions) is the natural next step.
- Not in Phase 1: resuming a conversation after a reload, line-item (repeat)
  nodes, file uploads, LLM extraction from free text, PII masking in `FC_EVENTS`, and a
  packaged APEX region plugin. The Static Content region approach above is the stand-in for the plugin.
- When an edit replays the flow, lookups are not re-run. For example, if you change the email,
  the customer lookup keeps its earlier result.
