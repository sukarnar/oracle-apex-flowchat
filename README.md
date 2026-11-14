# FlowChat: conversational forms driven by a flow definition (Phase 1)

**Author:** Sukarna Chinchod

A chat widget you can drop into any page. It asks the questions defined in a flow, validates every
answer on the server, branches on the answers, and fills the page's existing form as it goes.

```
flows/      loan_application.json    sample "create" flow (collect answers, submit)
            update_application.json  sample "search and update" flow (find, change, review, save)
            update_application_public.json  same, for public pages: verifies a one-time code first
            flow.schema.json         JSON Schema for flow definitions
designer/   index.html               visual flow designer (no dependencies)
widget/     flowchat.js              <flow-chat> Web Component + transports + adapters (no dependencies)
            flowchat-engine.js       reference engine in JS (demo, simulator, Node backends)
db/         install.sql              first-time install: runs 01..07, 09..12 in order (08 ORDS is optional)
            upgrade_phase_d.sql      upgrades an existing install with Phase D: Verify step, lookup lists (keeps your data)
            reinstall_packages.sql   re-creates FC_DATA, FC_ENGINE, FC_DESIGNER only (upgrades, compile fixes)
            01_tables.sql            FC_FLOWS, FC_FLOW_VERSIONS, FC_CONNECTORS, FC_SESSIONS, FC_EVENTS
            02_data_sources.sql      FC_DATA_SOURCES (+ fields) registry tables
            02c_lovs.sql             FC_LOVS: lookup lists for choice answers (SQL or PL/SQL)
            02b_fc_data.sql          FC_DATA package (search / get / update); re-runnable
            03/04_fc_engine.*        PL/SQL engine (server-authoritative)
            05_demo_connectors.sql   sample lookup / validator / submit connectors + demo tables
            06_demo_data_source.sql  exposes the demo table as the "loan_apps" data source
            07_seed_flows.sql        generated: publishes both sample flows
            08_ords_module.sql       REST API for non-APEX hosts
            09_fc_designer.sql       FC_DESIGNER: back end for the designer hosted in APEX
            10_verify_demo.sql       send_code connector, FC_DEMO_OUTBOX, "loan_apps_public" data source
            11_seed_public_flow.sql  generated: publishes update_application_public
            12_lov_demo.sql          FC_DEMO_BRANCHES and the lookup lists "countries" and "branches"
            13_seed_loan_flow.sql    generated: publishes loan_application (used by the upgrade only)
demo/       index.html               create demo (runs in the browser using the JS engine)
            update.html              search and update demo, with a live table and a conflict button
            verify.html              public-page demo: one-time code first, with an in-page outbox
            demo-lovs.js             in-browser stand-ins for the "countries" and "branches" lookup lists
tests/      engine.test.js           node tests/engine.test.js
            update.test.js           node tests/update.test.js
            verify.test.js           node tests/verify.test.js
            lov.test.js              node tests/lov.test.js
            mine.test.js             node tests/mine.test.js (Find record by row filter only)
            appuser.test.js          node tests/appuser.test.js (built-in {{app_user}})
            apex-embed-test.html     designer inside a page-wide form, like APEX
            apex-designer-db-test.html  designer in database mode against a fake FC_DESIGNER back end
            fake-apex-backend.js     emulates the FC_DESIGNER Ajax protocol in the browser (testing only)
tools/      build-seed.js            flow JSON -> SQL publish script
```

## 1. Try the demos (no database needed)

```bash
python -m http.server 8765
```
Then open <http://localhost:8765/demo/> (create), <http://localhost:8765/demo/update.html> (search and update)
or <http://localhost:8765/demo/verify.html> (search and update on a public page, with a one-time code).
The flows are fetched over HTTP, so opening the files directly won't work.

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
- **Search and update steps:** the palette's *Find & update data* group adds **Find record**,
  **Change fields** and **Save changes**. Their editors use the Data tab's catalog:
  - Search criteria can only use searchable fields, with each field's allowed operators.
  - Result-card templates get field chips (masked fields are marked •).
  - Field cards offer only updatable fields, with answer type, checks and an "only editable when…" lock.
  - The Summary node gets a *Changes to a record* mode.
- **Data tab:** the designer's copy of the server registry (`FC_DATA_SOURCES`). For each source it
  holds the table, key, version column, row filter, fields (searchable, operators, updatable, mask)
  and sample rows for testing.
  - **Registration SQL** downloads the inserts that create the source on the server.
  - **Import** and **Export** share a catalog as JSON.
  - Catalog edits are saved with your draft, but aren't covered by Undo.
- **Checklist for data steps:** flags, among other things:
  - non-searchable criteria and disallowed operators,
  - read-only fields offered for editing,
  - unknown records or aliases and duplicate aliases,
  - a search with no criteria,
  - a Change fields step with no Save changes after it,
  - a Save changes step whose conflict and error exits are both unconnected.
- **Testing data steps:** the Test tab runs Find, Change and Save against the catalog's sample
  rows, which reset on each restart. "Simulate another user editing the loaded record" bumps the
  loaded record's version, so the next save takes the conflict path.
- **Samples ▾** loads either sample flow (create or update).
- **Save:** your draft autosaves in this browser. **Export JSON** downloads the definition.
  **Publish SQL** downloads a script that publishes it as a new version
  (`fc_engine.publish_flow`). **Open…** loads a `.json` file, and **JSON** lets you edit the raw definition.
- Renaming a field (slot) updates every condition, `{{placeholder}}`, summary list and binding in
  the flow. It does **not** update your PL/SQL connectors, which read slots by name.

Node positions are stored as `ui: {x, y}` on each node. Both engines ignore them.

### Hosting the designer on an APEX page

1. **Static Application Files:** upload `widget/flowchat-engine.js`, `widget/flowchat.js`,
   `designer/designer.js` and `designer/designer.css`. Optionally upload `flows/loan_application.json`
   and `flows/update_application.json` too, so the Samples menu works.
2. **Page > CSS > File URLs:** `#APP_FILES#designer.css`
3. **Page > JavaScript > File URLs**, in this order:
   ```
   #APP_FILES#flowchat-engine.js
   #APP_FILES#flowchat.js
   #APP_FILES#designer.js
   ```
4. **A page-level Ajax Callback process** named `FC_DESIGNER` with the PL/SQL `fc_designer.ajax;`
   (from `db/09_fc_designer.sql`). Make it a page process, not an application process, so only this page can call it.
5. **Protect the page with an authorization scheme.** Anyone who can open the designer page can
   publish flows and change data source definitions.
6. **A Static Content region** (template *Blank with Attributes* works best) whose source is just:
   ```html
   <div id="fcd-root" data-backend="apex" data-flows-base="#APP_FILES#"
        style="--fcd-height: calc(100vh - 140px)"></div>
   ```
   The script draws the whole designer into that div. Don't paste the markup from
   `designer/index.html`. Add `data-theme="light"` or `"dark"` to fix the colour scheme.
   Without `data-backend="apex"`, the designer works on files only, like the standalone page.

With `data-backend="apex"` the designer works directly against the database:

- **Open…** lists the flows in `FC_FLOW_VERSIONS`, with their live and draft versions. Any version
  can be opened, and **Open a file instead…** is still available. If nothing is restored on start,
  the dialog opens automatically.
- **Save draft** (Ctrl+S) stores a `DRAFT` version that conversations don't use. Saving again
  updates that draft in place.
- **Publish** checks the flow: the Checklist must have no errors, and the server re-checks the
  structure. It then stores the flow as `PUBLISHED`, and new conversations use it straight away.
  Earlier published versions become `RETIRED`. Conversations already running keep the version they
  started on.
- **Status pill:** shows whether the open flow is not in the database, has unsaved changes, is a
  draft, or is published.
- **Concurrent edits:** every save sends the version you started from. If someone else saved in
  the meantime, or you're saving a new flow whose id already exists, you're asked before anything
  is overwritten.
- **Data tab:**
  - It loads `FC_DATA_SOURCES` on start. **Save to database** writes a source, and the server
    warns about tables or columns it can't find.
  - **Revert to database** discards local changes.
  - **Load 20 rows from the database** fetches real test data for the Test tab.
  - **Delete** is refused while a published flow still uses the source.
  - **Create from table…** reads `USER_TAB_COLUMNS` and the primary key, guesses the version
    column, and skips unsupported types such as CLOB.
  - Unsaved local edits survive a reload, flagged as "changed here".
- **Checklist:** also warns when a flow uses a data source that isn't saved in the database
  (an error, which blocks publishing) or has unsaved changes, or a connector that isn't registered
  in `FC_CONNECTORS`.
- **SQL** still downloads a publish script, for example to move a flow to another environment.

How the designer stays out of APEX's way:
- **No page submits:** APEX wraps the page in one `<form>`, so every designer button is
  `type="button"`, and Enter inside designer fields commits the field instead of submitting the page.
- **No style leaks:** all styles are scoped under `.fcd`, and all element ids start with `fcd-`.
- **Shortcuts stay local:** keyboard shortcuts (Delete, Ctrl+Z) only act while focus is inside the designer.
- **Test pages:** `tests/apex-embed-test.html` reproduces these conditions with a page-wide form and aggressive host styles.
  `tests/apex-designer-db-test.html` runs database mode against `tests/fake-apex-backend.js`, which
  emulates the `FC_DESIGNER` protocol in the browser, so the designer can be tried without APEX.

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
(or use **Publish SQL** in the designer)
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

Run `08_ords_module.sql`, then:

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
- **choice** options are either fixed (`options: [{value, label}]`) or come from a **lookup list**
  in the database (`optionsFrom`). See *Lookup lists* below. `display` is `auto` (buttons for up to
  8 options, a searchable list above that), `buttons` or `list`.
- **condition** `when`: `{slot, op, value}` where op is `= != > >= < <= in empty notEmpty`, combined
  with `all`, `any` or `not`. Conditions are structured JSON rather than expressions, so there is
  no expression evaluator to secure.
- **Connectors** are registered in `FC_CONNECTORS` and have the signature
  `function f(p_payload clob) return clob`. A validator returns `{valid,message}`, a lookup returns
  `{found,slots,message}`, and a submit returns `{ok,slots,message}`. Type `REST` POSTs the same
  payload to a URL. The payload is `{sessionId, flowId, nodeId, slots, context, appUser}` (plus
  `slot` and `value` for validators and lookups). `appUser` is the signed-in user, set by the server
  from the APEX session, so a connector can trust it; `context` comes from the page and can't be trusted.
- **Context:** values passed at start (the `context` attribute) whose names match a slot
  pre-fill that slot.
- **Signed-in user:** `{{app_user}}` is built in and works in any message, prompt or condition
  (`{"slot": "app_user", "op": "=", "value": "ADMIN"}`) with no field or binding. In APEX, FC_ENGINE
  fills it from the APEX session (`APP_USER`), so the browser can't change it. A slot or context value
  named `app_user` never overrides it, and the designer reserves the name. With the JavaScript engine,
  pass `createEngine({ appUser: 'JSMITH' })` (or a function) from your server's authentication. The
  designer's Test tab uses your own APEX user, or `TEST_USER` outside APEX.

### Lookup lists (choice options from the database)

Instead of typing the options into the flow, point a choice at a list registered in `FC_LOVS`:

```json
{ "id": "ask_country", "type": "ask", "slot": "country", "prompt": "Which country do you live in?",
  "input": { "kind": "choice", "optionsFrom": "countries", "display": "list" }, "next": "ask_branch" },
{ "id": "ask_branch", "type": "ask", "slot": "branch", "prompt": "Which branch should handle your application?",
  "input": { "kind": "choice", "optionsFrom": "branches", "optionsParams": { "country": "country" } }, "next": "..." }
```

Register each list once, on the server:

```sql
insert into fc_lovs (lov_id, lov_type, query, description)
values ('branches', 'SQL',
        'select branch_id, branch_name from fc_demo_branches where country_code = :COUNTRY order by branch_name',
        'Branches in one country');
```

- **SQL lists:** the first two columns are the value and the label; at most 500 rows are used.
  Binds: `:APP_USER`, `:FC_VERIFIED`, and one `:NAME` per entry in `optionsParams`
  (`{"country": "country"}` binds the answer `country` as `:COUNTRY`). The value of a parameter can be
  any answer or a loaded record field (`app.country`).
  **PLSQL lists:** `lov_type = 'PLSQL'`, `target` = `function f(p_payload clob) return clob`, which receives
  `{"lov", "params", "appUser", "verified", "context"}` and returns `[{"value", "label"}]`.
- The flow only names the list. The SQL never reaches the browser, and parameters are always bound,
  never concatenated.
- Lists are read again on every turn, so they are always current. A list whose parameters aren't all
  answered yet has no options.
- The server checks every answer against the list, and checks again before submit.
- **Depends on an earlier answer:** if that answer changes (Back, or Edit from the summary) and the
  saved choice is no longer offered, the question is asked again with `staleMessage`.
  `emptyMessage` is shown when a list has no options.
- Works the same for **Change fields** fields (`fields[].input.optionsFrom`). Record fields show their label.
- **In the designer:** set the answer type to *Choice*, then *Options come from: A lookup list*. Pick
  the list and map each parameter to an earlier answer. In database mode the designer reads `FC_LOVS`,
  so it lists the parameters each SQL list needs and flags unknown lists or missing parameters. The
  Test tab then uses the real options. In the standalone designer, the Test tab uses test options that
  you can edit (a row field named like a parameter, for example `"country"`, filters by it).
- **JavaScript engine / Node:** pass `lovs: { id: (req) => [{value, label}] }` to `createEngine`
  (`req` = `{lov, params, context, verified}`; it may return a Promise). See `demo/demo-lovs.js`.

The `loan_application` sample now asks for a country, using a searchable list of 13 countries, and then
a branch in that country, filtered by `:COUNTRY`.

Built-in conversation behaviour:
- **Back:** returns to the previous question.
- **Start over:** clears everything and starts again.
- **Edit from the summary:** after the change, the flow is replayed. Branches are re-evaluated,
  any newly required question is asked, and questions you've already answered are skipped.

## 6. Search and update flows

`flows/update_application.json` is a complete example: ask for an email (and optionally a
reference), find the application, change some fields, review the changes, and save.

### Data sources (server-side registry)

A flow never contains table names or SQL. It names a **data source**, which an administrator
defines in `FC_DATA_SOURCES` and `FC_DATA_SOURCE_FIELDS` (see `db/06_demo_data_source.sql`):

| Column | Meaning |
|---|---|
| `source_type` | `TABLE` (no code: FC_DATA builds bound SQL from the registered columns) or `PLSQL` (your own search/get/update functions) |
| `object_name`, `key_column` | table or view, and its unique key |
| `version_column` | optional NUMBER column, incremented on every update and used to detect conflicts. Without it, the original values of the changed columns are compared instead |
| `row_filter` | trusted SQL predicate added to every search, get and update, e.g. `t.email = lower(:APP_USER)`. `:APP_USER` is bound to the signed-in APEX user |
| field `searchable` / `search_ops` | which fields can be searched, and with which of `eq, starts, contains, gte, lte` |
| field `updatable` | the server-side whitelist. A field that isn't updatable here can't be changed, whatever the flow says |
| field `mask` | `last4` shows only the last 4 characters on search result cards |

### New node types

- **findRecord**: builds criteria from captured slots and searches the source.
  - No match goes to `notFound`.
  - One match is loaded straight away (`autoPick`).
  - Several matches show result cards to pick from (`card.title` and `card.subtitle` use the row's masked values).
  - More than `maxResults` matches goes to `tooMany`.
  - The loaded record's fields are then available as `{{as.field}}`, in conditions, and in bindings such as `"app.phone": {...}`.
  - **The signed-in user's records** (`"byRowFilter": true`, no `criteria`): nothing is asked; the data
    source's `row_filter` alone picks the rows, for example `upper(t.username) = upper(:APP_USER)`.
    `:APP_USER` is bound by the database from the APEX session, so the browser can't change whose
    records are found. One row loads straight away; several show the pick cards; none goes to
    `notFound`. The server refuses a search with no criteria on a source without a row filter, so it
    can never return the whole table. A PL/SQL source's search function is called with empty
    `criteria` and must limit the rows itself (`appUser` is in the payload). In the designer: Find record
    → **Find: The signed-in user's records**.
- **changeFields**: shows the record's current values and a chip for each field. The user edits any
  number of fields, and each one is validated exactly like an Ask (`input`, `validators`). Use
  `editableWhen` to lock a field conditionally, for example the amount once the status isn't `NEW`.
  **Done** goes to `done`, or to `noChanges` if nothing changed.
- **summary** with `"mode": "changes"` shows only the changed fields as old → new, each with Edit.
- **saveChanges**: re-validates every changed field and checks it's editable and updatable, then
  updates only those columns, guarded by the version. Its exits:
  - `saved`: the update succeeded.
  - `conflict`: someone else changed the record. The latest version is reloaded with the user's
    edits applied on top, so routing back to the review shows the new diff.
  - `forbidden`: the field or row isn't allowed.
  - `error`: anything else.

  Every save writes the before and after values to `FC_EVENTS`.

### Verify step (one-time code) for public pages

On a page without login there is no `:APP_USER`, so a row filter can't limit people to their own
records: anyone who typed someone else's email could open their application. Put a **Verify** step
between the question that captures the email (or phone) and **Find record**.
`flows/update_application_public.json` shows the pattern.

```json
{ "id": "verify_email", "type": "verify", "slot": "email", "channel": "email", "connector": "send_code",
  "codeLength": 6, "ttlMinutes": 10, "maxAttempts": 3, "maxResends": 2,
  "verified": "ask_ref", "failed": "locked" }
```

- The engine generates the code with `DBMS_CRYPTO` and keeps only a salted SHA-256 hash in the session.
  The code itself is never in a turn, never in the session state, and never written to `FC_EVENTS`.
  The user's answer is logged there as `(one-time code, not logged)`.
- The node's **connector** delivers it. It receives the usual payload plus
  `{"channel", "to", "code", "ttlMinutes"}` and returns `{"ok": true}` or `{"ok": false, "message": "…"}`.
  The demo connector `fc_demo_verify.send_code` writes to `FC_DEMO_OUTBOX` instead of sending
  (`select * from fc_demo_outbox order by msg_id desc`); its comments show the `APEX_MAIL` call to use instead.
- Wrong codes count down (`maxAttempts`). Expired codes are replaced automatically. **Send a new code**
  is offered under the input (`maxResends`), and the previous code stops working. Running out of
  attempts or resends, or a failed send, goes to `failed` (or ends the conversation as failed).
- Verification is tied to the value: changing the email afterwards (Back, or Edit) needs a new code.
  Back skips over a Verify step that has already passed.
- **Two locks on the data:**
  1. On Find record, set `"requireVerified": "email"`. The engine refuses to search unless that answer
     passed verification with its current value. The designer also checks there's a required
     *equals* criterion on it.
  2. On the data source, bind the verified value in the row filter:
     `upper(t.email) = upper(:FC_VERIFIED)` (see `loan_apps_public` in `db/10_verify_demo.sql`).
     `:FC_VERIFIED` is null until the conversation passes a Verify step, so nothing is visible before then,
     even if a flow is misdesigned. PLSQL sources get the same value as `"verified"` in their payload.
- In the designer, the **Test** tab shows each code in a pop-up message, because nothing is sent.
  Data sources whose row filter uses `:FC_VERIFIED` return no sample rows in the Data tab, because
  nothing is verified there.

**Upgrading an existing install:** from the `db` folder run `@upgrade_phase_d.sql`. It creates
`FC_LOVS` (and the demo table `FC_DEMO_BRANCHES`), re-creates the packages, adds the demo connector,
data source and lookup lists, and publishes `update_application_public` and a new version of
`loan_application`, which now asks for a country and a branch. Tables and data are kept, and the
script is safe to re-run. Then upload the new `flowchat.js` and `designer.js` (APEX static files), and add
`update_application_public` to a page without authentication the same way as the other flows.

**Security:** record keys never reach the browser. Search results are sent as opaque tokens
(`r1`, `r2`) that the engine maps back to keys on the server, so users can't reach other rows
by tampering with ids.

Turn-protocol additions:
- `await.type` can now be `pick` (`items: [{token, title, subtitle}]`) or `fieldMenu`
  (`fields: [{field, label, display, changed, editable, reason}]`). When editing a single field it's an
  `ask` with `sub: true`.
- New input payloads: `{"pick": "r1"}`, `{"pick": null}`, `{"field": "phone"}` and `{"command": "done"}`.
- Choice inputs arrive with their `options` already resolved (lookup lists included); `optionsFrom` and
  `optionsParams` are not sent. `display: "list"` (or more than 8 options) makes the widget show a
  searchable list instead of buttons.
- Verify step: an `ask` with `secret: true` (the widget echoes dots instead of the code), input hints
  (`inputMode`, `autocomplete: "one-time-code"`, `maxLength`) and `actions: [{command: "resend", label}]`,
  which the widget shows as links. Input `{"command": "resend"}` sends a new code.
- New message types: `record`, a read-only card, and `changes`, the old → new card.

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

- The JavaScript engine and widget are tested: 46 unit tests (`tests/engine.test.js`,
  `tests/update.test.js`, `tests/verify.test.js`, `tests/lov.test.js`, `tests/mine.test.js`,
  `tests/appuser.test.js`), plus manual end-to-end runs of the demos.
- **The Phase D PL/SQL (Verify step and lookup lists in `FC_ENGINE`, `FC_DATA`, `FC_DESIGNER`,
  `02c_lovs.sql`, `10_verify_demo.sql`, `12_lov_demo.sql`) has not been compiled yet.** It mirrors the
  JavaScript engine, which is tested. Expect possible small compile fixes when you run `upgrade_phase_d.sql`.
- Phases 1 to C (`FC_ENGINE`, `FC_DATA`, `FC_DESIGNER`) have been installed and run on Oracle with APEX,
  including the designer's database mode.
- **Standalone designer:** without `data-backend="apex"`, the data source catalog is local. Keep it
  in step with `FC_DATA_SOURCES` through Registration SQL and Import/Export.
- **"Create from table"** lists only the parsing schema's own tables and views (`USER_OBJECTS`).
  Sources on other schemas can still be typed in by hand.
- **Re-upload changed files:** after updating `designer.js` or `designer.css` in APEX, re-upload
  them. APEX versions static file URLs, so browsers pick up the change. On a plain web server,
  force-reload to avoid a cached copy.
- Not done yet (rest of Phase D): child rows / line items (repeat), bulk updates, resuming a conversation after a reload, file uploads, LLM extraction from free text, PII masking in `FC_EVENTS`, and a
  packaged APEX region plugin. The Static Content region approach above is the stand-in for the plugin.
- When an edit replays the flow, lookups are not re-run. For example, if you change the email,
  the customer lookup keeps its earlier result.
