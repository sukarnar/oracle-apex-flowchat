# FlowChat: conversational forms driven by a flow definition (Phase 1)

**Author:** Sukarna Chinchod

A chat widget you can drop into any page. It asks the questions defined in a flow, validates every
answer on the server, branches on the answers, and fills the page's existing form as it goes.

```
flows/      loan_application.json    sample "create" flow (collect answers, submit)
            update_application.json  sample "search and update" flow (find, change, review, save)
            update_application_public.json  same, for public pages: verifies a one-time code first
            expense_claim.json       Phase E sample: line items (Repeat), a file answer, a PII answer, debug logging
            flow.schema.json         JSON Schema for flow definitions
designer/   index.html               visual flow designer (no dependencies)
apex/       region_type_plugin_com_flowchat_designer.sql  APEX region plugin "FlowChat Designer" (import in App Builder)
            region_type_plugin_com_flowchat_chat.sql      APEX region plugin "FlowChat Chat": the chat widget on a page
widget/     flowchat.js              <flow-chat> Web Component + transports + adapters (no dependencies)
            flowchat-engine.js       reference engine in JS (demo, simulator, Node backends)
db/         install.sql              first-time install: runs 01..07, 09..12 in order (08 ORDS is optional)
            upgrade_phase_d.sql      upgrades an existing install with Phase D: Verify step, lookup lists (keeps your data)
            upgrade_phase_e.sql      upgrades with Phase E: versions, resume, debug, PII masking, Repeat, Bulk update, files
            upgrade_phase_f.sql      upgrades with Phase F: Agent node (FC_AI_PROVIDERS, FC_AI_TOOLS, FC_AI_SKILLS)
            upgrade_phase_g.sql      upgrades with the REST call node (FC_REST_ENDPOINTS)
            reinstall_packages.sql   re-creates FC_DATA, FC_ENGINE, FC_DESIGNER only (upgrades, compile fixes)
            01_tables.sql            FC_FLOWS, FC_FLOW_VERSIONS, FC_CONNECTORS, FC_SESSIONS, FC_EVENTS, FC_FILES
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
            13_seed_loan_flow.sql    generated: publishes loan_application with the country and branch lists
            14_seed_expense_flow.sql FC_DEMO_EXPENSES.submit_claim connector + publishes expense_claim
            15_ai_tables.sql         FC_AI_PROVIDERS, FC_AI_TOOLS, FC_AI_SKILLS (Agent node registries)
            16_seed_agent_demo.sql   Agent demo: FC_DEMO_LEAVE tables and connectors, 3 tools, a skill, flow leave_agent_demo
            17_rest_endpoints.sql    FC_REST_ENDPOINTS (the APIs a REST call node may call)
demo/       index.html               create demo (runs in the browser using the JS engine)
            update.html              search and update demo, with a live table and a conflict button
            verify.html              public-page demo: one-time code first, with an in-page outbox
            expenses.html            Phase E demo: line items, receipt upload, masked debug log
            demo-lovs.js             in-browser stand-ins for the "countries" and "branches" lookup lists
tests/      engine.test.js           node tests/engine.test.js
            update.test.js           node tests/update.test.js
            verify.test.js           node tests/verify.test.js
            lov.test.js              node tests/lov.test.js
            mine.test.js             node tests/mine.test.js (Find record by row filter only)
            appuser.test.js          node tests/appuser.test.js (built-in {{app_user}})
            phase-e.test.js          node tests/phase-e.test.js (versions, debug, PII, resume, Repeat, Bulk update, files)
            set.test.js              node tests/set.test.js (Set values node, context variables)
            menu.test.js             node tests/menu.test.js (Menu node: pills, routing, loops, back/edit)
            email.test.js            node tests/email.test.js (Email node: templates, connector, attachments, failures)
            rest.test.js             node tests/rest.test.js (REST call node: URL building, body template, mapping, routing, refusals, replay)
            agent.test.js            node tests/agent.test.js (Agent node, scripted model: questions, tools, confirm, finish, handoff, limits, JSON mode, pick_record, files, PII placeholders, set_field, REST tools)
            apex-embed-test.html     designer inside a page-wide form, like APEX
            apex-designer-db-test.html  designer in database mode against a fake FC_DESIGNER back end
            apex-plugin-test.html    the designer as the region plugin renders it (plugin AJAX callback, fake back end)
            apex-chat-plugin-test.html  the chat as the FlowChat Chat plugin renders it (plugin AJAX callback, fake page items)
            fake-apex-backend.js     emulates the FC_DESIGNER Ajax protocol in the browser (testing only)
tools/      build-seed.js            flow JSON -> SQL publish script
            build-apex-plugin.js     rebuilds both apex/ plugin exports from the source files
```

## 1. Try the demos (no database needed)

```bash
python -m http.server 8765
```
Then open <http://localhost:8765/demo/> (create), <http://localhost:8765/demo/update.html> (search and update)
or <http://localhost:8765/demo/verify.html> (search and update on a public page, with a one-time code),
or <http://localhost:8765/demo/expenses.html> (line items, a file upload and the masked debug log).
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

**With the region plugin (recommended).** `apex/region_type_plugin_com_flowchat_designer.sql` is a
region plugin export for APEX 23.2 and later. The designer, the engine, the chat widget and the sample
flows are all inside it as plugin files, so nothing else needs uploading.

1. Install the database objects first (`FC_DESIGNER` from `db/09_fc_designer.sql` must be in the
   application's parsing schema).
2. **App Builder > your application > Shared Components > Plug-ins > Import**, choose the file and
   install it. Importing it again replaces the plugin (same internal name `COM.FLOWCHAT.DESIGNER`).
3. On a page, add a region of type **FlowChat Designer** (template *Blank with Attributes* works best).
   Its attributes:
   - **Mode:** *Database* (default) opens, saves and publishes flows in the database. It uses the
     region's own AJAX callback, so the page needs no `FC_DESIGNER` process. *Files* works on JSON
     files only, like the standalone designer.
   - **Height:** a CSS length (default `calc(100vh - 140px)`).
   - **Theme:** Automatic, Light or Dark.
4. **Protect the page or the region with an authorization scheme.** Anyone who can open it can
   publish flows and change data source definitions.

Use one designer region per page. After changing `designer.js`, the engine, the widget or a sample
flow, run `node tools/build-apex-plugin.js` (it rebuilds both plugins) and import the new file. Installing from a script instead
of the UI also works; set the target first:
```sql
begin
  apex_application_install.set_workspace('MY_WORKSPACE');
  apex_application_install.set_application_id(100);
  apex_application_install.set_schema('MY_SCHEMA');
end;
/
@apex/region_type_plugin_com_flowchat_designer.sql
```

**Without the plugin** (a Static Content region and a page process):

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

### With the region plugin (recommended)

`apex/region_type_plugin_com_flowchat_chat.sql` is a region plugin for APEX 23.2 and later, with
`flowchat.js` inside it.

1. **Import it:** App Builder > your application > Shared Components > Plug-ins > Import. Importing it
   again replaces it (internal name `COM.FLOWCHAT.CHAT`).
2. **The form:** a normal APEX form region with items whose names match `bindings.*.apex` in the flow
   (`P10_EMAIL`, `P10_AMOUNT`, ...). Give date items the format mask `YYYY-MM-DD`.
3. **The chat:** add a region of type **FlowChat Chat** (e.g. in the right column) and set:

   | Attribute | |
   |---|---|
   | **Flow** | the flow id, e.g. `loan_application` (required) |
   | **Version** | pins a published version; empty = the latest published |
   | **Heading**, **Subheading** | header text (translatable) |
   | **Context** | page values read at start: `customer_id:P10_CUSTOMER_ID,dept:P10_DEPT` |
   | **When Finished** | Nothing (the flow's Submit node saved it), Submit Page (with **Submit Request**, default `FC_COMPLETE`), or Reload Page |
   | **Keep Conversation** | across reloads: No, Browser Tab (sessionStorage) or Browser (localStorage) |
   | **Theme** | Automatic, Light or Dark |
   | **Start Automatically** | off: start it from JavaScript with `document.getElementById('<static id>_chat').start()` |
   | **Height** | a CSS length, default `560px` |

No `FC_START` / `FC_INPUT` processes are needed: the region has its own AJAX callback, and it is
stricter than the processes. It starts only the flow (and version) set on the region, whatever the
browser sends, and continues only conversations of that flow. The chat element's id is the region's
static id plus `_chat` (`R<region id>_chat` without a static id). Several chat regions can be on one page.

### Without the plugin (a Static Content region and two processes)

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
- **Context variables:** values the page passes at start (the `context` attribute,
  `context="dept:P10_DEPT,emp_id:P10_EMP_ID"`). Every one is readable as `{{context.dept}}` in messages,
  prompts, conditions (`{"slot": "context.dept", ...}`), search criteria and Set values. Declare them in
  the designer's flow settings under **Context variables** (`"context": ["dept", "emp_id"]`): a declared
  name also fills the field of the same name, so `{{dept}}` works and connectors get it in `slots`.
  (A context value also fills an asked or bound field of the same name, as before.) Context comes from
  the browser: show it and search with it, but never use it to decide what a user may see.
- **Set values node:** initialises or copies values without asking anything, in order:
  ```json
  { "id": "init", "type": "set", "assign": [
      { "slot": "status", "value": "NEW" },
      { "slot": "priority", "value": "LOW", "onlyIfEmpty": true },
      { "slot": "dept", "from": "context.dept" },
      { "slot": "title", "template": "Request from {{app_user}} for {{dept}}" },
      { "slot": "note", "clear": true } ], "next": "ask_amount" }
  ```
  `from` copies a slot, `alias.field`, `context.<name>`, `<list>.count` or `app_user`. A Set node runs
  again when the flow is replayed after an Edit, so use `onlyIfEmpty` for defaults the user may change
  later. `app_user` can't be set.
- **Menu node:** fixed options shown as buttons (pills), each leading to its own step, like a menu:
  ```json
  { "id": "main", "type": "menu", "prompt": "What can I help with?", "slot": "topic",
    "options": [
      { "value": "leave",   "label": "Apply for leave",  "next": "ask_days" },
      { "value": "payslip", "label": "Payslip question", "next": "payslip_info" },
      { "value": "admin",   "label": "Admin tools",      "next": "admin",
        "when": { "slot": "context.role", "op": "=", "value": "ADMIN" } },
      { "value": "bye",     "label": "Nothing, thanks",  "next": "end" } ] }
  ```
  The user taps a pill, or types an option's label or number. A menu is shown every time the flow
  reaches it, so a later step can loop back (e.g. an "Anything else?" menu whose "Yes" goes to `main`).
  `slot` is optional: it keeps the chosen value for `{{topic}}`, conditions and the summary. An option
  with `when` is only offered while the condition holds. Back returns to the menu; an Edit replays
  through the option chosen before.
- **Email node:** sends an email built from the answers:
  ```json
  { "id": "notify", "type": "email", "from": "no-reply@yourcompany.com",
    "to": "{{email}}", "cc": "hr@yourcompany.com", "bcc": "", "replyTo": "",
    "subject": "Your leave request for {{days}} days",
    "body": "Hi {{name}},

We received your request.

HR team",
    "attachments": ["receipt"],
    "message": "I've emailed a copy to {{email}}.", "errorMessage": "Sorry, I couldn't send the email.",
    "next": "done", "onError": "done" }
  ```
  - **APEX:** without a `connector`, FC_ENGINE queues the email with `APEX_MAIL` (`from` is then
    required). APEX sends its mail queue after the commit, through the instance's SMTP settings;
    the queue job runs every few minutes, or call `apex_mail.push_queue` to send at once. The FlowChat
    request must run in an APEX session (the APEX transport does); over ORDS, use a connector.
  - **Connector:** with `"connector": "my_mailer"`, the connector gets the usual payload plus
    `to`, `cc`, `bcc` (arrays), `replyTo`, `from`, `subject`, `body` and `attachments`
    (`[{slot, id, name, size, mimeType}]`; read the content from `FC_FILES` by `id` and `sessionId`).
    It returns `{"ok": true}` or `{"ok": false, "message": "..."}`.
  - **JavaScript engine:** pass `createEngine({ sendEmail: (msg) => ({ ok: true }) })`, or use a connector.
    The designer's Test tab sends nothing; it shows the email instead.
  - Templates take `{{placeholders}}`. Recipients are separated by commas or semicolons. Every
    address is checked, there are at most 50 recipients, and line breaks are removed from the subject
    and addresses. The body is plain text; it's also sent as HTML with the values escaped.
  - **Attachments:** list file-answer slots in `attachments`.
  - **On failure:** the user sees `errorMessage` and the flow goes to `onError`, or carries on to
    `next` when there is none. The error is in the debug log (event `email`).
  - **Edits:** an Edit that replays the flow doesn't send the email again.
  - **Spam:** a `to` filled from an answer lets anyone using the flow send that email to any address,
    so send to addresses typed by users only where that's fine (for example after a Verify step).
- **REST call node:** calls a REST API and puts parts of its JSON answer into fields:
  ```json
  { "id": "get_rate", "type": "rest", "endpoint": "fx_rates", "method": "GET",
    "path": "/rates/{{currency}}", "query": { "amount": "{{amount}}" },
    "map": { "rate": "$.rate", "rate_date": "$.date", "first_bank": "$.sources[0].name" },
    "statusSlot": "rate_status",
    "message": "Today's rate is {{rate}}.", "notFoundMessage": "I don't know {{currency}}.",
    "errorMessage": "The rate service isn't answering. Please try later.",
    "next": "ask_amount", "onNotFound": "ask_currency", "onError": "manual_rate" }
  ```
  - **Endpoints are registered, not written in the flow.** `endpoint` is an id in
    `FC_REST_ENDPOINTS`, which holds the base URL, the allowed methods (default `GET` only), an APEX
    Web Credential for the key, headers sent on every call, the timeout and the largest response.
    So a flow (or whoever can publish one) can't send data to a host you haven't registered, and no
    key is ever in a flow:
    ```sql
    insert into fc_rest_endpoints (endpoint_id, base_url, allowed_methods, credential_static_id, description)
    values ('fx_rates', 'https://api.example.com/v1', 'GET', 'FX_API_KEY', 'Exchange rates');
    ```
  - **The call:** `path` is added to the base URL and must start with `/` or `?`. Values in
    `{{placeholders}}` in the path and `query` are URL-encoded, including `/` and `.`, so an answer
    can't change the path. `headers` adds headers from templates; `Authorization`, `Cookie`, `Host`
    and the like are refused (put them on the endpoint). `body` (not for GET) is a JSON template:
    `"{{amount}}"` on its own keeps the answer's type (a number stays a number, a Repeat list stays a
    list), and other strings are filled in as text.
  - **The answer:** `map` puts values into fields by JSON path (`$.a.b`, `$.items[0].id`, or `$` for
    all of it); a missing path clears the field. Mapped fields update bound page items like any
    answer. `statusSlot` gets the HTTP status.
  - **Routing:** 2xx goes to `next`. 404 goes to `onNotFound` when it's set. Any other status, a
    timeout, a response that's too big, or a refused call shows `errorMessage` and goes to
    `onError`; without `onError` the conversation ends as failed.
  - **Edits:** when an Edit replays the flow, a GET runs again quietly with the new answers, and
    other methods are not repeated.
  - **Debug:** the debug log gets an event `rest` with the method, path, status, time and the mapped
    field names, never the response body.
  - **APEX:** FC_ENGINE calls `APEX_WEB_SERVICE.MAKE_REST_REQUEST` with the endpoint's Web Credential
    and wallet. The database needs a network ACL for the host, and an https host needs a wallet (the
    endpoint's `WALLET_PATH`, or the instance wallet in APEX), as for the Agent's model provider:
    ```sql
    begin
      dbms_network_acl_admin.append_host_ace(
        host => 'api.example.com',
        ace  => xs$ace_type(privilege_list => xs$name_list('http'),
                            principal_name => 'APEX_230200', principal_type => xs_acl.ptype_db));
    end;
    /
    ```
  - **JavaScript engine:** pass `createEngine({ restEndpoints: { fx_rates: { baseUrl, methods: ['GET'],
    headers: { Authorization: 'Bearer ...' }, timeoutMs: 20000 } } })` (it uses `fetch`, or
    `options.fetch`), or `rest: (req) => ({ status, body })` to make the call yourself. Keep keys on
    the server: in the browser demo anyone can read them.
  - **Designer:** the endpoint field lists `FC_REST_ENDPOINTS` (database mode) and checks the
    method against it. The Test tab never calls the API: each REST call node answers with a mock
    (`{"status": 200, "body": {...}}`, with buttons for 404, 500 and a timeout).
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

## 7. Phase E: versions, resume, debugging, PII, line items, bulk updates, files

**Upgrading an existing install:** from the `db` folder run `@upgrade_phase_e.sql`. It lets
FC_EVENTS hold debug rows, creates `FC_FILES`, re-creates the packages and publishes the
`expense_claim` sample. Tables and data are kept and it is safe to re-run. Then upload the new
`flowchat.js`, `flowchat-engine.js` and `designer.js`.

### Pin a flow version

```html
<flow-chat flow="loan_application" version="3" transport="apex"></flow-chat>
```
Without `version` the latest published version is used. A pinned version must be published (not a
draft or retired), otherwise the start fails with "Version 3 of flow … is not published". The APEX
transport sends it as `x03`, REST as `"version"` in the body, and `fc_engine.start_session` takes it
as `p_version`. A conversation always stays on the version it started with.

### Resume after a page reload

```html
<flow-chat flow="loan_application" transport="apex" resume="session"></flow-chat>
```
- `resume="session"` keeps the session id and transcript in `sessionStorage` (cleared when the
  tab closes); `resume="local"` uses `localStorage` (kept until the conversation ends, at most a day).
- On load the widget redraws the transcript and sends `{"command": "resume"}`. The engine answers with
  "Welcome back…" (the flow's `resumeText`), asks the current question again and re-sends every value,
  so the page's fields are filled in again. Nothing in the conversation changes.
- If the conversation has expired, finished, or belongs to another APEX session, the widget silently
  starts a new one. The browser storage holds the transcript as the user saw it, so leave `resume`
  off on shared computers if answers are sensitive.

### Debug logging

- Tick **Debug logging** in the designer's flow settings (`"debug": true`), or run
  `fc_engine.set_debug(true)` in a database session (for a test script).
- Every step, branch, skip, connector call (payload, response, milliseconds), search and bulk update
  is written to `FC_EVENTS` with `direction = 'DBG'`. A failed turn is rolled back, but its error is still
  logged as a DBG row. When APEX debug is on, the same events go to the APEX debug log.
- One-time codes and file contents are never logged; PII values are masked (below).
```sql
select event_id, node_id, json_value(payload, '$.event') event, payload
  from fc_events where session_id = :sid and direction = 'DBG' order by event_id;
```
- The JavaScript engine calls `createEngine({ onDebug: (event) => ... })`. The designer's Test tab
  shows the events under the session state when the flow has debug on.

### PII masking in FC_EVENTS

- Mark a question **In logs: Redact it** (`"pii": true`) or **Show only the last 4 characters**
  (`"pii": "last4"`). The same setting exists on Change fields fields and Repeat item fields. Values set
  by a lookup or page context go in the flow's **PII answers** (`"piiSlots": ["ssn"]`); a page context
  value is named `context.<name>` (`"piiSlots": ["context.emp_id"]`).
- Every FC_EVENTS row (IN, OUT, DBG and the update audit) has those values replaced by `[redacted]`
  or `••••1234`, wherever they appear: the answer itself, the summary, messages that repeat it, record
  values. The input that sets a PII answer is logged as `[redacted]`.
- The chat, the session state (`FC_SESSIONS.STATE`, needed to run the conversation) and connector
  payloads still hold the real values. Purge sessions with `fc_engine.purge_expired`.

### Repeat: line items and child rows

```json
{ "id": "lines", "type": "repeat", "slot": "lines", "label": "Expenses", "itemLabel": "expense",
  "min": 1, "max": 10, "itemTitle": "{{description}} ({{amount}})",
  "fields": [
    { "field": "description", "prompt": "What was expense {{n}} for?", "input": { "kind": "text" } },
    { "field": "amount", "prompt": "How much was {{description}}?", "input": { "kind": "number", "prefix": "$" } }
  ], "next": "review" }
```
- The questions are asked in order for each item, validated like Ask nodes (validators included).
  Then the widget shows the items with **Remove**, **Add another** and **Done**.
- The slot holds `[{"description": "Taxi", "amount": 42.5}, …]`, which is what the Submit connector
  receives. `{{lines}}` shows the number of items and `{{lines.count}}` works in conditions.
- Back inside an item returns to its previous question, or drops the unfinished item. The summary lists
  the items with Edit, which reopens the list. `min` items are re-checked before submit.

### Bulk update

```json
{ "id": "close_old", "type": "bulkUpdate", "source": "loan_apps",
  "criteria": [{ "field": "status", "op": "eq", "slot": "old_status" }],
  "set": { "status": { "value": "CLOSED", "label": "Status" } },
  "maxRows": 50, "card": { "title": "{{reference}}" },
  "done": "finished", "none": "nothing", "cancelled": "nothing" }
```
- Searches like Find record (criteria or `byRowFilter`), then shows "This will set Status = CLOSED on
  12 records" with the first 10 and a red **Update 12** button. Nothing changes until the user confirms.
- Each record is then read again and updated with its own version through FC_DATA, so the updatable
  whitelist, the row filter and conflict detection apply to every row. The keys never reach the browser.
- More than `maxRows` matches (at most 500) goes to `tooMany`. Rows that fail (changed meanwhile,
  not allowed) are counted, and `partial` (or `done`) follows. The result goes to FC_EVENTS.
- New values come from `{"value": …}` or an earlier answer `{"slot": "new_status"}`.

### File answers

```json
{ "id": "ask_receipt", "type": "ask", "slot": "receipt", "prompt": "Please attach your receipt.",
  "input": { "kind": "file", "accept": [".pdf", "image/*"], "maxSizeKb": 5120 }, "next": "review" }
```
- The widget shows **Choose file** with drag and drop, checks type and size, and sends the file
  base64-encoded (in `p_clob_01` with the APEX transport). The server checks the decoded size, the
  extension and the declared type again.
- The content goes to `FC_FILES`; the answer is `{"id", "name", "size", "mimeType"}`. A Submit connector
  reads the content with `where file_id = :id and session_id = :sessionId` (see `fc_demo_expenses`).
  Files are deleted with their session, and a replaced answer deletes the old file.
- The type check trusts the browser's file name and declared type. Scan files before using them.
- JavaScript engine: pass `files: { save(file) -> id, remove({sessionId, fileId}) }`, or use the
  default memory store and `engine.getFile(sessionId, fileId)`.

Turn-protocol additions: `await.type` can be `listMenu` (`items: [{index, title}], canAdd, canDone,
addLabel, doneLabel`) or `confirm` (`confirmLabel, cancelLabel, danger`); an `ask` inside a Repeat has
`item: n`; message type `list` is a read-only list card. New inputs: `{"command": "resume"}`,
`{"command": "add"}`, `{"command": "remove", "index": 0}`, `{"command": "confirm"}`, `{"command": "cancel"}`
and `{"file": {"name", "mimeType", "data"}}`.

## 8. Agent node (AI)

An **Agent** step works toward a goal with a language model. It asks the user questions, calls the
tools and skills you allow, and then fills fields, hands off to another step, or gives up. The loop
runs inside FC_ENGINE, so APEX session security, row filters, `app_user` and logging all apply.

```json
{ "id": "leave_agent", "type": "agent", "provider": "corp_gpt_oss",
  "goal": "Help {{app_user}} apply for leave: check their balance and the policy, then collect the leave type and days.",
  "intro": "Let me help you with your leave request.",
  "inputs": ["context.emp_id"], "tools": ["get_leave_balance", "book_leave"], "skills": ["leave_policy"],
  "outputs": [ { "name": "leave_type", "label": "Leave type", "kind": "choice", "options": ["annual", "sick"] },
               { "name": "start_date", "label": "First day", "kind": "date" },
               { "name": "days", "label": "Days", "kind": "number", "min": 0.5, "max": 30 } ],
  "exits": [ { "name": "payslip", "description": "the user asks about payslips", "next": "payslip_menu" } ],
  "limits": { "maxSteps": 20, "maxQuestions": 10, "maxCallsPerTurn": 4 },
  "next": "review", "onError": "manual_form" }
```

**How it talks and finishes.**
- **Questions:** the model asks with `ask_user`. FlowChat renders the question (text, number, date,
  email, yes/no, or choice pills) and checks the answer with the same parsing and limits as an Ask
  node. A plain reply from the model is shown, and the user's free-text answer goes back to it.
- **Files:** `ask_user` with kind `file` (or a question for a `file` output) shows the upload
  button. The file is stored like an Ask node's (FC_FILES), and the model gets only its id, name,
  size and type. A `file` output is filled only by the user's upload, never by the model.
- **Picking a record:** `pick_record` runs one of the node's SEARCH tools and shows the rows as
  pick cards, with **None of these** at the end. The row values stay on the server; the model gets
  the row the user picked (or `null`). Card text comes from the tool's `TITLE_TEMPLATE` and
  `SUBTITLE_TEMPLATE` (e.g. `{{last_name}}, {{first_name}}`), else its first three values.
- **`set_field`:** fills one output straight away (checked like an answer), so the APEX page item
  updates while the conversation goes on. `finish` still ends the task.
- **`finish`:** each output is checked like an answer (type, options, min/max). A bad value goes back
  to the model to fix. Valid outputs become ordinary fields: they're shown in the Summary, can be
  edited there (Edit asks for that one field directly; the agent isn't run again), and are sent
  to Submit.
- **Other endings:** `handoff` follows an exit. `give_up`, a model error or a limit goes to
  `onError`; without it the conversation ends as failed.

**The two ways of writing data:**
- **Agent gathers, flow commits** (recommended): connect `next` to a Summary and a Submit node.
- **Agent writes:** give it a tool with `IS_WRITE = 'Y'`. FlowChat shows a confirmation card
  (Confirm / Cancel) before the tool runs, and the model can't skip it. Set `NEEDS_CONFIRM = 'N'`
  only for harmless writes.

### Set up a model provider (APEX 23.2: direct REST, no APEX_AI)

1. **Serve the model** on an OpenAI-style endpoint (`/v1/chat/completions`), for example vLLM or
   Ollama. Turn on tool calling (in vLLM, `--enable-auto-tool-choice` with the tool-call parser
   for that model family).
2. **Allow the host** (as ADMIN):
   ```sql
   begin
     dbms_network_acl_admin.append_host_ace(host => 'llm.corp.local', lower_port => 443, upper_port => 443,
       ace => xs$ace_type(privilege_list => xs$name_list('http'), principal_name => 'APEX_230200',
                          principal_type => xs_acl.ptype_db));
   end;
   /
   ```
3. **Certificates:** put the corporate root CA (and, for mutual TLS, the client certificate) in an
   auto-login Oracle wallet. Set the provider's `WALLET_PATH` (e.g. `file:/u01/wallets/llm`), or
   leave it null to use the APEX instance wallet.
4. **API key:** create an APEX **Web Credential** (Workspace Utilities > Web Credentials):
   - type *HTTP Header*, name `Authorization`, secret `Bearer <key>`;
   - *Valid for URLs* set to the base URL.

   Put its static id in `CREDENTIAL_ID`. The key never appears in a flow or in FlowChat tables.
5. **Register the provider:**
   ```sql
   insert into fc_ai_providers (provider_id, base_url, model, credential_id, wallet_path, tool_mode, description)
   values ('corp_gpt_oss', 'https://llm.corp.local/v1', 'openai/gpt-oss-120b', 'LLM_API_KEY', null, 'native',
           'GPT OSS 120B');
   ```
   - Other columns: `TEMPERATURE` (0.2), `MAX_TOKENS` (1024), `TIMEOUT_SECS` (120), and
     `EXTRA_HEADERS` (JSON, e.g. a gateway's tenant header).
   - **`TOOL_MODE = 'json'`** is for a model whose tool calling is unreliable on your server. The
     engine then asks for one JSON object per reply and parses it itself.

**Which model:** start with GPT OSS 120B or Llama 3.3 70B in `native` mode. Gemma 4 26B/31B work
well for small toolsets (5–8 tools); if their tool calls misbehave on your server, register them with
`TOOL_MODE = 'json'`.

### Tools and skills

```sql
insert into fc_ai_tools (tool_id, tool_type, target, description, parameters)
values ('get_leave_balance', 'CONNECTOR', 'leave_balance', 'Leave balance (days) of an employee by type',
        '{"type":"object","properties":{"emp_id":{"type":"string"}},"required":["emp_id"]}');
insert into fc_ai_tools (tool_id, tool_type, target, description, parameters, is_write, confirm_text)
values ('book_leave', 'CONNECTOR', 'book_leave', 'Book leave for the signed-in user',
        '{"type":"object","properties":{"leave_type":{"type":"string"},"start_date":{"type":"string"},"days":{"type":"number"}}}',
        'Y', 'Book {{days}} days of {{leave_type}} leave from {{start_date}}?');
insert into fc_ai_skills (skill_id, name, description, content)
values ('leave_policy', 'Leave policy', 'Rules for annual and sick leave', 'Annual leave needs two weeks notice ...');
```

**Tool types:**
- **CONNECTOR** gets the usual connector payload (`slots`, `context`, `appUser` from the APEX
  session) plus `tool` and `args`.
- **LOV** returns the options of an FC_LOVS list; `args` are its parameters.
- **SEARCH** searches an FC_DATA source. Its row filter applies; `args` are `{field: value}` or
  `{"criteria": [...]}`, and at most `MAX_ROWS` rows (up to 50) come back. The model can also hand
  a SEARCH tool to `pick_record` so the user picks the row:
  ```sql
  insert into fc_ai_tools (tool_id, tool_type, target, description, parameters, title_template, subtitle_template)
  values ('find_employee', 'SEARCH', 'employees', 'Find employees by name',
          '{"type":"object","properties":{"last_name":{"type":"string"}}}',
          '{{last_name}}, {{first_name}}', '{{department}}');
  ```
- **REST** calls an endpoint from `FC_REST_ENDPOINTS` (`TARGET`), with the same rules as the REST
  call node: registered host, Web Credential, allowed methods, URL-encoded values, no
  `Authorization` header from the request. `REQUEST` is the request template, and its
  `{{placeholders}}` are the model's arguments (plus `{{app_user}}`, which the model can't change):
  ```sql
  insert into fc_ai_tools (tool_id, tool_type, target, description, parameters, request)
  values ('public_holidays', 'REST', 'hr_api', 'Public holidays in a year and region',
          '{"type":"object","properties":{"year":{"type":"string"},"region":{"type":"string"}},"required":["year"]}',
          '{"method":"GET","path":"/holidays/{{year}}","query":{"region":"{{region}}"},
            "map":{"dates":"$.items","count":"$.total"}}');
  ```
  The model gets `{"status": 200, "data": ...}`: the `map`ped values, or the whole JSON answer when
  there's no `map` (cut to 6,000 characters, with `"truncated": true`). A 404 comes back as
  `{"status": 404, "found": false}`, and anything else as `{"error": "..."}`, so the model can
  explain or try again. **A REST tool whose method isn't GET always asks the user to confirm first**
  (it counts as a write tool whatever `IS_WRITE` says; `NEEDS_CONFIRM = 'N'` still turns that off).
  Its `body` template works like the node's: `"{{days}}"` alone keeps the argument's type. Calls
  are in the debug log as event `rest` with the tool id, never with the answer.

A tool runs only if the node lists it, and its result reaches the model cut to 8,000 characters.
**Skills** load in stages: the prompt carries only each skill's name and description, and the
model calls `load_skill` for the full text.

### Guardrails

- **What the model sees:** the goal, the instructions, the `inputs` you tick, `app_user` and
  today's date. The system prompt tells the model that user and tool text is data, not
  instructions. Even so, what it can do is limited by the tools you register, not by the prompt.
- **PII placeholders** (unless `sendPii` is true): personal values reach the model as `[PII_1]`,
  `[PII_2]` and so on. That covers `"pii"` answers, `piiSlots`, outputs marked `"pii"`, and answers to
  `ask_user` questions the model marks `sensitive`. The same value always gets the same token, in
  `inputs`, answers, tool results and the user's free text. When the model uses a token in tool
  arguments, `finish`/`set_field` values or a message to the user, FlowChat puts the real value back
  first, so tools and the user see real data while the model never does. Values shorter than three
  characters, and values inside a longer free-text sentence that isn't itself a PII value, are not
  replaced.
- **What the model can't do:** it never writes SQL or creates nodes that persist. Questions it
  asks exist only for that conversation, and their answers are checked by FlowChat.
- **Limits:**
  - `maxSteps` caps model calls in total (default 20).
  - `maxQuestions` caps questions to the user (default 10).
  - `maxCallsPerTurn` caps model calls per request (default 4); after that the user sees a
    **Continue** button, so a request never runs past APEX's time limits.
- **Logging:** with debug on, each model call, tool call, handoff and failure is logged (event
  `agent`, `agentDone`, `agentFailed`) with PII masked. The conversation itself is kept in the
  session state.
- **Replays:** when an Edit replays the flow, a finished agent isn't run again.

### Design and test

- **In the designer:** the **Agent** palette item edits the provider (picked from FC_AI_PROVIDERS),
  the goal, the fields, the values it sees, tools, skills, exits and limits. The checklist flags
  unknown providers, tools and skills.
- **Testing:** the Test tab never calls a real model. Each agent replays an editable **script**
  (`[{"tool": "ask_user", "args": {...}}, {"tool": "finish", "args": {"fields": {...}}}]`), and
  each tool returns a JSON mock, so tests behave the same every run. A SEARCH tool's mock returns
  `{"rows": [...]}`, which `pick_record` shows as cards. Test against the real model
  on an APEX page.
- **JavaScript engine:** pass `aiProviders`, `aiTools` and `aiSkills` to `createEngine`.
  `FlowChatEngine.openAIProvider({baseUrl, model, apiKey, fetchOptions})` builds a provider for
  Node.js; pass a certificate through `fetchOptions` (an undici Agent with `ca`, `cert` and `key`).

**Try it:** `@16_seed_agent_demo.sql` sets up a leave assistant (flow `leave_agent_demo`, also under
Samples in the designer). It uses a provider registered as `corp_llm`.

**Install:**
- On an existing install, run `@upgrade_phase_f.sql`. It creates the three tables (or, if they
  exist, adds the Phase 2 columns `TITLE_TEMPLATE` and `SUBTITLE_TEMPLATE`) and recompiles the
  packages. Re-running it is safe.
- On a new instance, `install.sql` includes them.
- **REST call node and REST tools:** on an existing install run `@upgrade_phase_g.sql` (after
  `upgrade_phase_f.sql`). It creates `FC_REST_ENDPOINTS`, adds `FC_AI_TOOLS.REQUEST` and the `REST`
  tool type, and recompiles the packages. `install.sql` includes it.

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

- The JavaScript engine and widget are tested: 96 unit tests (`tests/engine.test.js`,
  `tests/update.test.js`, `tests/verify.test.js`, `tests/lov.test.js`, `tests/mine.test.js`,
  `tests/appuser.test.js`, `tests/phase-e.test.js`, `tests/set.test.js`, `tests/menu.test.js`,
  `tests/email.test.js`, `tests/agent.test.js`, `tests/rest.test.js`), plus manual end-to-end runs of the demos.
- **The REST call node's and REST tools' PL/SQL (`run_rest`, `rest_call`, `rest_tool` and the other `rest_*` helpers in `FC_ENGINE`,
  `17_rest_endpoints.sql`, `list_rest` in `FC_DESIGNER`) has not been compiled or called a real API
  yet.** It mirrors the tested JavaScript engine.
- **The Agent node's PL/SQL (the `ag_*` routines in `FC_ENGINE`, `15_ai_tables.sql`, `list_ai` in
  `FC_DESIGNER`) has not been compiled or run against a real model yet.** It mirrors the tested
  JavaScript engine.
- **The Email node's PL/SQL (`run_email` in `FC_ENGINE`) has not been compiled or sent a real email
  yet.** It mirrors the tested JavaScript engine.
- **The Phase E PL/SQL (`FC_ENGINE`, `01_tables.sql`, `upgrade_phase_e.sql`, `14_seed_expense_flow.sql`)
  has not been compiled yet.** It mirrors the JavaScript engine, which is tested. Expect possible small
  compile fixes when you run `upgrade_phase_e.sql`.
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
- **The designer region plugin has not been imported into a real APEX instance yet.** Its PL/SQL and
  the export format follow APEX 23.2; the designer side (`apex.server.plugin`) is tested in
  `tests/apex-plugin-test.html`. If the import fails, the manual setup above works the same way.
- **The FlowChat Chat region plugin has not been imported into a real APEX instance yet** either.
  The widget side (`apex.server.plugin`, region-locked flow) is tested in `tests/apex-chat-plugin-test.html`.
  If the import fails, the Static Content region with `<flow-chat>` works the same way.
- Not done yet: LLM extraction from free text. Repeat items can't contain file answers yet;
  use a separate Ask step for the file.
- When an edit replays the flow, lookups are not re-run. For example, if you change the email,
  the customer lookup keeps its earlier result.
