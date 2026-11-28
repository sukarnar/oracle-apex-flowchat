/*!
 * FlowChat Designer: visual editor for FlowChat flow definitions.
 * No dependencies. Produces the same JSON the engines run (plus "ui" positions, which engines ignore).
 *
 * Mounts into <div id="fcd-root"></div>. Load order: flowchat-engine.js, flowchat.js, designer.js.
 */
(function () {
  'use strict';
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  function boot() {

  // ======================================================================== constants
  const VERSION = '1.6.0 (phase D: verify step, lookup lists)';
  const NODE_W = 230;
  const BUILTIN_USER = 'app_user';   // {{app_user}}: the signed-in user, filled in by the server
  const STORE_KEY = 'flowchat-designer:v1';

  // The designer mounts into <div id="fcd-root" class="fcd"></div> (standalone page or APEX region).
  const ROOT = document.getElementById('fcd-root');
  if (!ROOT) { console.error('[FlowChat Designer] No element with id "fcd-root" found.'); return; }
  // Where the sample flows live: data-flows-base (e.g. "#APP_FILES#" in APEX), else the folder of
  // data-sample-url, else ../flows/.
  const FLOWS_BASE = ROOT.dataset.flowsBase ||
    (ROOT.dataset.sampleUrl ? ROOT.dataset.sampleUrl.replace(/[^/]*$/, '') : '../flows/');
  const SAMPLES = [
    { file: 'loan_application.json', label: 'Loan application', desc: 'Create: ask, branch, summary, submit' },
    { file: 'leave_agent_demo.json', label: 'Leave assistant (agent)', desc: 'Agent: gather then submit, book with a write tool, answer questions' },
    { file: 'update_application.json', label: 'Update application', desc: 'Search & update: find, change, save' },
    { file: 'update_application_public.json', label: 'Update (public page)', desc: 'Verify a one-time code, then find and update' },
    { file: 'trip_booking.json', label: 'Trip booking', desc: 'Contacts and destinations (Repeat), export and clearance questions, save, approval workflow' },
    { file: 'it_helpdesk.json', label: 'IT help desk (Teams)', desc: 'Made for a Teams channel: log, list and close tickets with short, numbered questions' }
  ];
  const STANDALONE = document.body.classList.contains('fcd-page');

  // Every <button> is type="button": inside APEX the page is one big <form>, and a default
  // (type="submit") button would submit and reload the page.
  const TEMPLATE = `
  <header class="bar">
    <span class="brand">FlowChat Designer</span>
    <span class="flow-title" id="fcd-flowTitle"></span>
    <span class="db-status" id="fcd-dbStatus" hidden></span>
    <button type="button" class="tb" id="fcd-btnNew" title="Start an empty flow">New</button>
    <button type="button" class="tb" id="fcd-btnOpen" title="Open a flow .json file">Open…</button>
    <button type="button" class="tb" id="fcd-btnSample" title="Load a sample flow">Samples ▾</button>
    <span class="sep"></span>
    <button type="button" class="tb" id="fcd-btnUndo" title="Undo (Ctrl+Z)">Undo</button>
    <button type="button" class="tb" id="fcd-btnRedo" title="Redo (Ctrl+Y)">Redo</button>
    <button type="button" class="tb" id="fcd-btnLayout" title="Arrange nodes top to bottom">Auto-layout</button>
    <span class="sep"></span>
    <button type="button" class="tb" id="fcd-btnExport" title="Download the flow definition">Export JSON</button>
    <button type="button" class="tb primary" id="fcd-btnPublish" title="Download a SQL script that publishes this flow to Oracle">Publish SQL</button>
    <button type="button" class="tb" id="fcd-btnSaveDb" title="Save to the database as a draft (not used by conversations yet)" hidden>Save draft</button>
    <button type="button" class="tb primary" id="fcd-btnPublishDb" title="Publish to the database: new conversations use this version" hidden>Publish</button>
    <input type="file" id="fcd-fileInput" accept=".json,application/json" hidden>
  </header>
  <div class="main">
    <aside class="palette" id="fcd-palette"><h3>Add a step</h3></aside>
    <section class="canvas" id="fcd-canvas" aria-label="Flow canvas">
      <div class="world" id="fcd-world">
        <svg class="edges" aria-hidden="true">
          <defs>
            <marker id="fcd-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" style="fill: var(--edge)"></path>
            </marker>
            <marker id="fcd-arrSel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" style="fill: var(--accent)"></path>
            </marker>
          </defs>
          <g id="fcd-edgeLayer"></g>
        </svg>
        <div id="fcd-nodes"></div>
      </div>
      <div class="zoom">
        <button type="button" id="fcd-zoomOut" title="Zoom out">−</button>
        <span id="fcd-zoomLabel">100%</span>
        <button type="button" id="fcd-zoomIn" title="Zoom in">+</button>
        <button type="button" id="fcd-zoomFit" title="Fit to screen">⤢</button>
      </div>
    </section>
    <aside class="panel">
      <nav class="tabs" role="tablist">
        <button type="button" data-tab="props" class="active" role="tab">Properties</button>
        <button type="button" data-tab="check" role="tab">Checklist <span class="badge" id="fcd-probBadge">0</span></button>
        <button type="button" data-tab="test" role="tab">Test</button>
        <button type="button" data-tab="data" role="tab" title="Data source catalog">Data</button>
        <button type="button" data-tab="json" role="tab">JSON</button>
      </nav>
      <div class="tab-body" id="fcd-tab-props"></div>
      <div class="tab-body" id="fcd-tab-check" hidden></div>
      <div class="tab-body" id="fcd-tab-data" hidden></div>
      <div class="tab-body" id="fcd-tab-test" hidden>
        <div class="test-bar">
          <button type="button" class="btn primary" id="fcd-btnRunTest">Restart test</button>
          <span class="test-note" id="fcd-testNote">Runs the current draft in your browser. Connectors return the mock responses below.</span>
        </div>
        <flow-chat class="sim" id="fcd-simChat" manual-start adapter="none" heading="Test run" subheading="Simulating the current draft"></flow-chat>
        <h4 class="sub">Captured answers & records</h4>
        <pre class="state" id="fcd-simState">{}</pre>
        <h4 class="sub">Mocks</h4>
        <div id="fcd-mocks"></div>
      </div>
      <div class="tab-body" id="fcd-tab-json" hidden>
        <p class="pdesc">This is the definition the engine runs. You can edit it directly; click Apply to load your changes.</p>
        <textarea class="in mono" id="fcd-jsonText" spellcheck="false" style="min-height: 60vh; font-size: 12px;"></textarea>
        <div class="actions">
          <button type="button" class="btn primary" id="fcd-btnApplyJson">Apply</button>
          <button type="button" class="btn" id="fcd-btnCopyJson">Copy</button>
        </div>
      </div>
    </aside>
  </div>
  <div class="toast" id="fcd-toast" role="status" aria-live="polite"></div>`;
  const KINDS = [['text', 'Text'], ['email', 'Email'], ['number', 'Number'], ['date', 'Date'], ['choice', 'Choice'], ['yesno', 'Yes / No']];
  const OPS = [['=', 'equals'], ['!=', 'not equal'], ['>', '>'], ['>=', '≥'], ['<', '<'], ['<=', '≤'], ['in', 'is one of'], ['empty', 'is empty'], ['notEmpty', 'is filled']];

  const TYPES = {
    message:   { label: 'Message',   color: '#64748b', desc: 'The assistant says something.',
                 make: (id) => ({ id, type: 'message', text: 'New message' }) },
    set:       { label: 'Set values', color: '#4f46e5', desc: 'Initialise or copy values into fields: defaults, values from page context, text built from answers.',
                 make: (id) => ({ id, type: 'set', assign: [{ slot: '', value: '', onlyIfEmpty: true }] }) },
    ask:       { label: 'Ask',       color: '#2563eb', desc: 'Ask a question and capture one form field.',
                 make: (id) => ({ id, type: 'ask', slot: 'field', label: 'New field', prompt: 'What is your …?', input: { kind: 'text' } }) },
    condition: { label: 'Condition', color: '#d97706', desc: 'Branch on captured answers.',
                 make: (id) => ({ id, type: 'condition', branches: [{ when: { slot: '', op: '=', value: '' } }] }) },
    menu:      { label: 'Menu',      color: '#e11d48', desc: 'Offer fixed options as buttons (pills); each option leads to its own step.',
                 make: (id) => ({ id, type: 'menu', prompt: 'What would you like to do?',
                                  options: [{ value: 'option_1', label: 'Option 1' }, { value: 'option_2', label: 'Option 2' }] }) },
    lookup:    { label: 'Lookup',    color: '#0891b2', desc: 'Fetch data (e.g. a customer) and prefill fields.',
                 make: (id) => ({ id, type: 'lookup', connector: '' }) },
    summary:   { label: 'Summary',   color: '#7c3aed', desc: 'Show all answers with Edit buttons, then confirm.',
                 make: (id) => ({ id, type: 'summary', text: "Here's what I have. Please check:", confirmLabel: 'Confirm & submit' }) },
    submit:    { label: 'Submit',    color: '#16a34a', desc: 'Re-validate everything and save via a connector.',
                 make: (id) => ({ id, type: 'submit', connector: '' }) },
    agent:     { label: 'Agent',     color: '#0f766e', desc: 'An AI agent works toward a goal: asks questions, uses tools and skills, then fills fields or hands off.',
                 make: (id) => ({ id, type: 'agent', provider: '', goal: '', outputs: [] }) },
    email:     { label: 'Email',     color: '#ea580c', desc: 'Send an email built from the answers (APEX_MAIL, or a connector).',
                 make: (id) => ({ id, type: 'email', to: '', from: '', subject: '', body: '' }) },
    teams:     { label: 'Post to Teams', color: '#5b5fc7', desc: 'Post a card to a Teams channel (FC_TEAMS_CHANNELS). One way: nobody answers it.',
                 make: (id) => ({ id, type: 'teams', channel: '', title: '', text: '' }) },
    rest:      { label: 'REST call', color: '#4f46e5', desc: 'Call a REST API registered in FC_REST_ENDPOINTS and put parts of its JSON answer into fields.',
                 make: (id) => ({ id, type: 'rest', endpoint: '', method: 'GET', path: '/', map: {} }) },
    workflow:  { label: 'Workflow',  color: '#0d9488', desc: 'Start an APEX workflow (an approval or back-office process) with parameters from the answers.',
                 make: (id) => ({ id, type: 'workflow', workflow: '', parameters: {}, resultSlot: 'workflow_id' }) },
    end:       { label: 'End',       color: '#475569', desc: 'Finish the conversation.',
                 make: (id) => ({ id, type: 'end', text: 'All done!' }) },
    repeat:    { label: 'Repeat',    color: '#0284c7', desc: 'Collect a list of items (line items, children, expenses), each with its own questions.',
                 make: (id) => ({ id, type: 'repeat', slot: uniqueSlot('items'), label: 'Items', itemLabel: 'item', min: 1, max: 20,
                                  fields: [{ field: 'description', label: 'Description', prompt: 'Description of {{item}} {{n}}?', input: { kind: 'text' } }] }) },
    verify:    { label: 'Verify', color: '#9333ea', group: 'data', desc: 'Send a one-time code to an answer (email or phone) and check it before searching.',
                 make: (id) => ({ id, type: 'verify', slot: '', channel: 'email', connector: '', codeLength: 6, ttlMinutes: 10,
                                  maxAttempts: 3, maxResends: 2 }) },
    findRecord: { label: 'Find record', color: '#0d9488', group: 'data', desc: 'Search a data source; pick among matches; load one.',
                 make: (id) => ({ id, type: 'findRecord', source: '', as: 'rec', criteria: [], maxResults: 10,
                                  card: { title: '' }, prompts: { many: 'I found {{count}} matching records. Which one?' } }) },
    changeFields: { label: 'Change fields', color: '#db2777', group: 'data', desc: 'Let the user change fields of the loaded record.',
                 make: (id) => ({ id, type: 'changeFields', record: '', prompt: 'What would you like to change?', fields: [] }) },
    saveChanges: { label: 'Save changes', color: '#059669', group: 'data', desc: 'Save only changed fields, with conflict detection.',
                 make: (id) => ({ id, type: 'saveChanges', record: '' }) },
    bulkUpdate: { label: 'Bulk update', color: '#b45309', group: 'data', desc: 'Apply the same change to every record a search finds, after the user confirms.',
                 make: (id) => ({ id, type: 'bulkUpdate', source: '', criteria: [], set: {}, maxRows: 50, card: { title: '' } }) }
  };

  const PORT_TITLES = {
    next: 'Then go to', onNotFound: 'If nothing is found, go to', onSuccess: 'On success, go to',
    onError: 'On error, go to', 'else': 'Otherwise go to',
    found: 'When a record is loaded, go to', notFound: 'If nothing matches, go to',
    tooMany: 'If too many match, go to', cancelled: 'If the user picks "None of these", go to',
    done: 'When the user clicks Done, go to', noChanges: 'If nothing was changed, go to',
    saved: 'After saving, go to', conflict: 'On a conflict (record changed meanwhile), go to',
    forbidden: 'If not allowed, go to', error: 'On any other error, go to',
    verified: 'Once the code is correct, go to', failed: 'After too many wrong codes, or if sending fails, go to',
    none: 'If no record matches (or the user cancels), go to', partial: 'If some records could not be changed, go to'
  };
  const PORT_HINTS = {
    tooMany: 'Optional. Defaults to the not-found path.', cancelled: 'Optional. Defaults to the not-found path.',
    noChanges: 'Optional. Defaults to the Done path.',
    conflict: 'Usually back to the review summary: the latest values are reloaded with the user\'s edits on top.',
    forbidden: 'Optional. Without it the conversation ends as failed.', error: 'Optional. Without it the conversation ends as failed.',
    failed: 'Optional. Without it the conversation ends as failed.',
    partial: 'Optional. Defaults to the Done path (the message says how many failed).'
  };

  // Default data source catalog: mirrors db/06_demo_data_source.sql so the update sample works in Test.
  const DEFAULT_CATALOG = {
    loan_apps: {
      objectName: 'fc_demo_loan_apps', keyColumn: 'app_id', versionColumn: 'version', rowFilter: '',
      fields: [
        { field: 'reference', column: 'REFERENCE', type: 'VARCHAR2', searchable: true, ops: 'eq', updatable: false },
        { field: 'email', column: 'EMAIL', type: 'VARCHAR2', searchable: true, ops: 'eq', updatable: false },
        { field: 'purpose', column: 'PURPOSE', type: 'VARCHAR2', searchable: false, ops: 'eq', updatable: false },
        { field: 'status', column: 'STATUS', type: 'VARCHAR2', searchable: false, ops: 'eq', updatable: false },
        { field: 'amount', column: 'AMOUNT', type: 'NUMBER', searchable: false, ops: 'eq', updatable: true },
        { field: 'phone', column: 'PHONE', type: 'VARCHAR2', searchable: false, ops: 'eq', updatable: true, mask: 'last4' },
        { field: 'start_date', column: 'START_DATE', type: 'DATE', searchable: false, ops: 'eq', updatable: true },
        { field: 'contact_ok', column: 'CONTACT_OK', type: 'VARCHAR2', searchable: false, ops: 'eq', updatable: true }
      ],
      sampleRows: [
        { _key: 1041, _version: 1, reference: 'LN-01041', email: 'jane.doe@example.com', purpose: 'Car', status: 'NEW',
          amount: 200000, phone: '+1 555 123 4567', start_date: '2026-12-31', contact_ok: 'Y' },
        { _key: 988, _version: 3, reference: 'LN-00988', email: 'jane.doe@example.com', purpose: 'Home improvement', status: 'APPROVED',
          amount: 15000, phone: '+1 555 123 4567', start_date: '2026-11-30', contact_ok: 'N' },
        { _key: 1050, _version: 1, reference: 'LN-01050', email: 'raj.kumar@example.com', purpose: 'Education', status: 'NEW',
          amount: 50000, phone: '+44 20 7946 0000', start_date: '2027-01-15', contact_ok: 'Y' }
      ]
    }
  };
  // Public-page variant (db/10_verify_demo.sql): same table, rows limited to the verified email.
  DEFAULT_CATALOG.loan_apps_public = Object.assign(JSON.parse(JSON.stringify(DEFAULT_CATALOG.loan_apps)),
    { rowFilter: 'upper(t.email) = upper(:FC_VERIFIED)' });
  // Test options for the sample lookup lists (db/12_lov_demo.sql), so the Test tab works without a database.
  // A row field named like a parameter ("country") filters the rows by that parameter.
  const DEFAULT_LOV_ROWS = (function () {
    const b = [['AU', 'Australia', 101, 'Sydney CBD'], ['AU', 'Australia', 102, 'Melbourne Collins St'], ['BR', 'Brazil', 111, 'São Paulo Paulista'],
      ['CA', 'Canada', 121, 'Toronto Bay St'], ['CA', 'Canada', 122, 'Vancouver Burrard'], ['CA', 'Canada', 123, 'Montréal Centre-Ville'],
      ['DE', 'Germany', 131, 'Berlin Mitte'], ['DE', 'Germany', 132, 'Frankfurt Zeil'], ['FR', 'France', 141, 'Paris Opéra'],
      ['IN', 'India', 151, 'Mumbai Fort'], ['IN', 'India', 152, 'Bengaluru MG Road'], ['IN', 'India', 153, 'Delhi Connaught Place'],
      ['IE', 'Ireland', 161, 'Dublin Grafton St'], ['JP', 'Japan', 171, 'Tokyo Marunouchi'], ['MX', 'Mexico', 181, 'Mexico City Reforma'],
      ['NZ', 'New Zealand', 191, 'Auckland Queen St'], ['SG', 'Singapore', 201, 'Singapore Raffles Place'],
      ['GB', 'United Kingdom', 211, 'London City'], ['GB', 'United Kingdom', 212, 'Manchester Spinningfields'],
      ['US', 'United States', 221, 'New York Midtown'], ['US', 'United States', 222, 'Chicago Loop'], ['US', 'United States', 223, 'San Francisco FiDi']];
    const countries = [];
    b.forEach((r) => { if (!countries.some((c) => c.value === r[0])) countries.push({ value: r[0], label: r[1] }); });
    countries.sort((x, y) => x.label.localeCompare(y.label));
    return { countries, branches: b.map((r) => ({ value: String(r[2]), label: r[3], country: r[0] })) };
  })();
  const SEARCH_OPS = [['eq', 'equals'], ['starts', 'starts with'], ['contains', 'contains'], ['gte', '≥'], ['lte', '≤']];
  const FIELD_TYPES = ['VARCHAR2', 'NUMBER', 'DATE'];

  // ======================================================================== state
  const S = {
    flow: null, sel: null, view: { x: 60, y: 50, z: 1 }, mocks: {}, catalog: null, dataSel: null,
    // database state (APEX back end only)
    db: { flowId: null, version: null, status: null, dirty: false, savedAt: null },
    dbCatalog: null,      // source id -> signature of the definition last read from / saved to the database
    dbConnectors: null,   // [{id, type, description}] registered in FC_CONNECTORS
    dbLovs: null,         // [{id, type, description, query, params}] registered in FC_LOVS (null: unknown)
    undo: [], redo: [], lastKey: null, lastTime: 0, tab: 'props', drag: null, testStale: false
  };

  // ======================================================================== dom helpers
  // All designer element ids are prefixed "fcd-" so they can't collide with the host page (e.g. APEX).
  const $ = (id) => document.getElementById('fcd-' + id);
  function h(tag, attrs) {
    const e = document.createElement(tag);
    // Inside APEX the whole page is a <form>; a button without type="button" would submit (reload) it.
    if (tag === 'button') e.type = 'button';
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'style') e.style.cssText = v;
        else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
        else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'draggable' || k === 'hidden') e[k] = v;
        else e.setAttribute(k, v === true ? '' : v);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const kids = [].concat(arguments[i]);
      for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) e.append(kid instanceof Node ? kid : String(kid));
    }
    return e;
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const snap = (v) => Math.round(v / 10) * 10;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const isFilled = (v) => !(v === undefined || v === null || v === '');

  let toastTimer;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2600);
  }

  function download(name, text, type) {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ======================================================================== back end (APEX)
  // <div id="fcd-root" data-backend="apex" data-process="FC_DESIGNER"> talks to db/09_fc_designer.sql
  // through one page-level Ajax Callback. The region plugin sets data-ajax-identifier instead, and the
  // calls go to the plugin's own AJAX function. Without data-backend the designer works on files only.
  const BACKEND = (function () {
    if (ROOT.dataset.backend !== 'apex') return null;
    const proc = ROOT.dataset.process || 'FC_DESIGNER';
    const ajaxId = ROOT.dataset.ajaxIdentifier;
    return {
      call(action, payload) {
        if (!window.apex || !apex.server) return Promise.reject(new Error('The APEX JavaScript API is not on this page.'));
        return new Promise((resolve, reject) => {
          const data = { x01: action, p_clob_01: JSON.stringify(payload || {}) };
          (ajaxId ? apex.server.plugin(ajaxId, data, { dataType: 'text' }) : apex.server.process(proc, data, { dataType: 'text' }))
            .done((txt) => {
              let j;
              try { j = typeof txt === 'string' ? JSON.parse(txt) : txt; } catch (e) { reject(new Error('The server returned something that is not JSON.')); return; }
              if (!j || j.error) {
                const err = new Error((j && j.error) || 'Empty response from the server.');
                err.code = (j && j.code) || 'error';
                reject(err);
              } else resolve(j.data);
            })
            .fail((xhr, status, err) => reject(new Error(err || status || 'The request failed.')));
        });
      }
    };
  })();

  // Small modal dialog: returns { body, foot, close }.
  function modal(title, opts) {
    opts = opts || {};
    const back = h('div', { class: 'modal-back' });
    const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: opts.width ? 'width:' + opts.width : null });
    const body = h('div', { class: 'modal-body' });
    const foot = h('div', { class: 'modal-foot' });
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    box.append(h('div', { class: 'modal-head' }, h('b', { text: title }), h('button', { class: 'x', text: '×', title: 'Close', onclick: close })), body, foot);
    back.append(box);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey, true);
    ROOT.append(back);
    return { body, foot, close };
  }

  // ======================================================================== model helpers
  const byId = (id) => S.flow.nodes.find((n) => n.id === id);

  function ports(n) {
    switch (n.type) {
      case 'message': case 'ask': case 'set': return [{ key: 'next', label: 'next' }];
      case 'summary': return [{ key: 'next', label: 'confirm' }];
      case 'lookup': return [{ key: 'next', label: 'next' }, { key: 'onNotFound', label: 'not found', optional: true }];
      case 'submit': return [{ key: 'onSuccess', label: 'success' }, { key: 'onError', label: 'error', optional: true }];
      case 'email': return [{ key: 'next', label: 'sent' }, { key: 'onError', label: 'error', optional: true }];
      case 'teams': return [{ key: 'next', label: 'posted' }, { key: 'onError', label: 'error', optional: true }];
      case 'workflow': return [{ key: 'next', label: 'started' }, { key: 'onError', label: 'error', optional: true }];
      case 'rest': return [{ key: 'next', label: 'ok' }, { key: 'onNotFound', label: '404', optional: true }, { key: 'onError', label: 'error', optional: true }];
      case 'agent': return [{ key: 'next', label: 'finished' }]
        .concat((n.exits || []).map((e, i) => ({ key: 'exit:' + i, label: e.name || 'exit ' + (i + 1) })))
        .concat([{ key: 'onError', label: 'error', optional: true }]);
      case 'verify': return [{ key: 'verified', label: 'verified' }, { key: 'failed', label: 'failed', optional: true }];
      case 'findRecord': return [{ key: 'found', label: 'found' }, { key: 'notFound', label: 'not found' },
        { key: 'tooMany', label: 'too many', optional: true }, { key: 'cancelled', label: 'none of these', optional: true }];
      case 'changeFields': return [{ key: 'done', label: 'done' }, { key: 'noChanges', label: 'no changes', optional: true }];
      case 'saveChanges': return [{ key: 'saved', label: 'saved' }, { key: 'conflict', label: 'conflict', optional: true },
        { key: 'forbidden', label: 'forbidden', optional: true }, { key: 'error', label: 'error', optional: true }];
      case 'repeat': return [{ key: 'next', label: 'done' }];
      case 'bulkUpdate': return [{ key: 'done', label: 'done' }, { key: 'none', label: 'none' },
        { key: 'tooMany', label: 'too many', optional: true }, { key: 'cancelled', label: 'cancelled', optional: true },
        { key: 'partial', label: 'partly failed', optional: true }];
      case 'menu':
        return (n.options || []).map((o, i) => ({ key: 'option:' + i, label: o.label || o.value || 'option ' + (i + 1) }));
      case 'condition':
        return (n.branches || []).map((b, i) => ({ key: 'branch:' + i, label: condText(b.when) || 'branch ' + (i + 1) }))
          .concat([{ key: 'else', label: 'else' }]);
      default: return [];
    }
  }
  function getPort(n, key) {
    if (key.indexOf('branch:') === 0) { const b = (n.branches || [])[+key.slice(7)]; return b && b.next; }
    if (key.indexOf('option:') === 0) { const o = (n.options || [])[+key.slice(7)]; return o && o.next; }
    if (key.indexOf('exit:') === 0) { const e = (n.exits || [])[+key.slice(5)]; return e && e.next; }
    return n[key];
  }
  function setPort(n, key, target) {
    if (key.indexOf('exit:') === 0) {
      const e = (n.exits || [])[+key.slice(5)];
      if (e) { if (target) e.next = target; else delete e.next; }
      return;
    }
    if (key.indexOf('option:') === 0) {
      const o = (n.options || [])[+key.slice(7)];
      if (o) { if (target) o.next = target; else delete o.next; }
      return;
    }
    if (key.indexOf('branch:') === 0) {
      const b = (n.branches || [])[+key.slice(7)];
      if (b) { if (target) b.next = target; else delete b.next; }
      return;
    }
    if (target) n[key] = target; else delete n[key];
  }

  function condText(c) {
    if (!c) return '';
    if (c.all || c.any) return (c.all || c.any).map(condText).join(c.all ? ' and ' : ' or ');
    if (c.not) return 'not (' + condText(c.not) + ')';
    if (!c.slot) return '';
    if (c.op === 'empty') return c.slot + ' is empty';
    if (c.op === 'notEmpty') return c.slot + ' is filled';
    const v = Array.isArray(c.value) ? '[' + c.value.join(', ') + ']' : c.value;
    return c.slot + ' ' + c.op + ' ' + v;
  }

  function uniqueId(base) {
    let i = 1;
    while (byId(base + '_' + i)) i++;
    return base + '_' + i;
  }
  function askSlots() {
    const out = [];
    S.flow.nodes.forEach((n) => { if (n.type === 'ask' && n.slot && out.indexOf(n.slot) < 0) out.push(n.slot); });
    return out;
  }
  function repeatNodes() { return S.flow.nodes.filter((n) => n.type === 'repeat' && n.slot); }
  function fileSlots() {
    return S.flow.nodes.filter((n) => n.type === 'ask' && n.slot && n.input && n.input.kind === 'file').map((n) => n.slot);
  }
  // Names declared in the flow's "context" list (values the page passes to the widget).
  function contextNames() {
    return (S.flow.context || []).map((c) => (c && typeof c === 'object' ? c.name : c)).filter(Boolean).map(String);
  }
  function menuSlots() {
    const out = [];
    S.flow.nodes.forEach((n) => { if (n.type === 'menu' && n.slot && out.indexOf(n.slot) < 0) out.push(n.slot); });
    return out;
  }
  function setSlots() {
    const out = [];
    const push = (k) => { if (k && out.indexOf(k) < 0) out.push(k); };
    S.flow.nodes.forEach((n) => {
      if (n.type === 'set') (n.assign || []).forEach((a) => push(a.slot));
      if (n.type === 'rest') { Object.keys(n.map || {}).forEach(push); push(n.statusSlot); }
      if (n.type === 'workflow') push(n.resultSlot);
    });
    return out;
  }
  // Values a search criterion can use: answers, Set values, context values, other records' fields
  // and the signed-in user (never the node's own record, which isn't loaded yet).
  function critValues(n) {
    const own = (n && n.as) ? n.as + '.' : null;
    return knownSlots().filter((x) => !(own && x.indexOf(own) === 0)).concat([BUILTIN_USER])
      .filter((x, i, a) => a.indexOf(x) === i);
  }
  function knownSlots() {
    const s = askSlots();
    menuSlots().concat(agentSlots(), setSlots(), contextNames()).forEach((k) => { if (s.indexOf(k) < 0) s.push(k); });
    contextNames().forEach((k) => { if (s.indexOf('context.' + k) < 0) s.push('context.' + k); });
    repeatNodes().forEach((n) => { [n.slot, n.slot + '.count'].forEach((k) => { if (s.indexOf(k) < 0) s.push(k); }); });
    Object.keys(S.flow.bindings || {}).forEach((k) => { if (s.indexOf(k) < 0) s.push(k); });
    recordFields().forEach((k) => { if (s.indexOf(k) < 0) s.push(k); });
    return s;
  }

  // ---- data source helpers
  function catalog() { return S.catalog || (S.catalog = clone(DEFAULT_CATALOG)); }
  function sourceDef(id) { return id ? catalog()[id] || null : null; }
  function sourceField(srcId, field) {
    const src = sourceDef(srcId);
    return src ? (src.fields || []).find((f) => f.field === field) || null : null;
  }
  function findNodes() { return S.flow.nodes.filter((n) => n.type === 'findRecord'); }
  function verifiedSlots() {
    const out = [];
    S.flow.nodes.forEach((n) => { if (n.type === 'verify' && n.slot && out.indexOf(n.slot) < 0) out.push(n.slot); });
    return out;
  }
  function aliases() {
    const out = [];
    findNodes().forEach((n) => { if (n.as && out.indexOf(n.as) < 0) out.push(n.as); });
    return out;
  }
  function sourceForAlias(alias) {
    const f = findNodes().find((n) => n.as === alias);
    return f ? f.source : null;
  }
  // "alias.field" names a flow can use once a record is loaded.
  function recordFields() {
    const out = [];
    findNodes().forEach((n) => {
      if (!n.as) return;
      const src = sourceDef(n.source);
      (src ? src.fields : []).forEach((f) => out.push(n.as + '.' + f.field));
    });
    S.flow.nodes.forEach((n) => {
      if (n.type === 'changeFields' && n.record) (n.fields || []).forEach((f) => {
        const k = n.record + '.' + f.field;
        if (f.field && out.indexOf(k) < 0) out.push(k);
      });
    });
    return out;
  }
  function sourceUses() {
    const out = {};
    S.flow.nodes.forEach((n) => { if ((n.type === 'findRecord' || n.type === 'bulkUpdate') && n.source) out[n.source] = true; });
    return Object.keys(out);
  }
  function inputKindFor(type) { return type === 'NUMBER' ? 'number' : type === 'DATE' ? 'date' : 'text'; }
  function uniqueSlot(base) {
    const used = knownSlots();
    let i = 1;
    while (used.indexOf(base + '_' + i) >= 0) i++;
    return base + '_' + i;
  }
  // Lookup lists used by choice answers: id -> [{ where: node id, spec }]
  function lovUses() {
    const out = {};
    const add = (spec, where) => {
      if (spec && spec.kind === 'choice' && 'optionsFrom' in spec && spec.optionsFrom) (out[spec.optionsFrom] = out[spec.optionsFrom] || []).push({ where, spec });
    };
    S.flow.nodes.forEach((n) => {
      if (n.type === 'ask') add(n.input, n.id);
      if (n.type === 'changeFields' || n.type === 'repeat') (n.fields || []).forEach((f) => add(f.input, n.id));
    });
    return out;
  }
  function dbLov(id) { return (S.dbLovs || []).find((l) => l.id === id) || null; }

  function connectorUses() {
    const map = {};
    S.flow.nodes.forEach((n) => {
      if ((n.type === 'lookup' || n.type === 'submit') && n.connector) map[n.connector] = map[n.connector] || n.type;
      if (n.type === 'verify' && n.connector) map[n.connector] = map[n.connector] || 'sender';
      if (n.type === 'email' && n.connector) map[n.connector] = map[n.connector] || 'mailer';
      if (n.type === 'teams' && n.connector) map[n.connector] = map[n.connector] || 'poster';
      if (n.type === 'ask') (n.validators || []).forEach((v) => {
        if (v.type === 'server' && v.connector) map[v.connector] = map[v.connector] || 'validator';
      });
    });
    return map;
  }

  function renameNode(oldId, newId) {
    S.flow.nodes.forEach((n) => {
      if (n.id === oldId) n.id = newId;
    });
    S.flow.nodes.forEach((n) => {
      ports(n).forEach((p) => { if (getPort(n, p.key) === oldId) setPort(n, p.key, newId); });
    });
    if (S.flow.start === oldId) S.flow.start = newId;
  }

  // Rename a slot everywhere: ask nodes, bindings, conditions, {{placeholders}}, summary fields.
  function renameSlot(oldSlot, newSlot) {
    const f = S.flow;
    const re = new RegExp('\\{\\{\\s*' + oldSlot + '\\s*\\}\\}', 'g');
    const fixCond = (c) => {
      if (!c) return;
      if (c.slot === oldSlot) c.slot = newSlot;
      (c.all || c.any || []).forEach(fixCond);
      if (c.not) fixCond(c.not);
    };
    f.nodes.forEach((n) => {
      if ((n.type === 'ask' || n.type === 'menu') && n.slot === oldSlot) n.slot = newSlot;
      if (n.type === 'set') (n.assign || []).forEach((a) => {
        if (a.from === oldSlot) a.from = newSlot;
        if (typeof a.template === 'string') a.template = a.template.replace(re, '{{' + newSlot + '}}');
      });
      ['text', 'prompt', 'note', 'to', 'cc', 'bcc', 'replyTo', 'from', 'subject', 'body', 'message', 'errorMessage']
        .forEach((k) => { if (typeof n[k] === 'string') n[k] = n[k].replace(re, '{{' + newSlot + '}}'); });
      (n.fields || []).forEach((fd) => { if (fd && typeof fd.note === 'string') fd.note = fd.note.replace(re, '{{' + newSlot + '}}'); });
      if (n.type === 'email' && n.attachments) n.attachments = n.attachments.map((s) => (s === oldSlot ? newSlot : s));
      if (n.type === 'workflow') {
        if (n.resultSlot === oldSlot) n.resultSlot = newSlot;
        if (typeof n.detailKey === 'string') n.detailKey = n.detailKey.replace(re, '{{' + newSlot + '}}');
        Object.keys(n.parameters || {}).forEach((k) => { n.parameters[k] = String(n.parameters[k]).replace(re, '{{' + newSlot + '}}'); });
      }
      if (n.type === 'rest') {
        if (n.map && oldSlot in n.map && !(newSlot in n.map)) { n.map[newSlot] = n.map[oldSlot]; delete n.map[oldSlot]; }
        if (n.statusSlot === oldSlot) n.statusSlot = newSlot;
        ['path', 'notFoundMessage'].forEach((k) => { if (typeof n[k] === 'string') n[k] = n[k].replace(re, '{{' + newSlot + '}}'); });
        ['query', 'headers'].forEach((k) => Object.keys(n[k] || {}).forEach((q) => { n[k][q] = String(n[k][q]).replace(re, '{{' + newSlot + '}}'); }));
        if (n.body !== undefined) n.body = JSON.parse(JSON.stringify(n.body).replace(re, '{{' + newSlot + '}}'));
      }
      if (n.type === 'agent') {
        (n.outputs || []).forEach((o) => { if (o.name === oldSlot) o.name = newSlot; });
        if (n.inputs) n.inputs = n.inputs.map((s) => (s === oldSlot ? newSlot : s));
        ['goal', 'instructions', 'intro', 'errorMessage'].forEach((k) => { if (typeof n[k] === 'string') n[k] = n[k].replace(re, '{{' + newSlot + '}}'); });
      }
      (n.branches || []).forEach((b) => fixCond(b.when));
      if (n.type === 'summary' && n.fields) n.fields = n.fields.map((s) => (s === oldSlot ? newSlot : s));
      (n.criteria || []).forEach((c) => { if (c.slot === oldSlot) c.slot = newSlot; });
    });
    if (f.bindings && f.bindings[oldSlot] && !f.bindings[newSlot]) {
      f.bindings[newSlot] = f.bindings[oldSlot];
      delete f.bindings[oldSlot];
    }
  }

  function blankFlow() {
    return {
      flowId: 'new_flow', version: 1, name: 'New flow', start: 'welcome', bindings: {},
      nodes: [
        { id: 'welcome', type: 'message', text: "Hi! I'll help you fill in this form.", next: 'done', ui: { x: 0, y: 0 } },
        { id: 'done', type: 'end', text: 'All done, thank you!', ui: { x: 0, y: 170 } }
      ]
    };
  }

  function checkShape(f) {
    if (!f || typeof f !== 'object' || !Array.isArray(f.nodes)) throw new Error('A flow needs a "nodes" array.');
    f.nodes.forEach((n, i) => {
      if (!n || !n.id || !TYPES[n.type]) throw new Error('Node #' + (i + 1) + ' needs an id and a known type.');
    });
    return f;
  }

  // ======================================================================== mutations & history
  function mutate(fn, opts) {
    opts = opts || {};
    const now = Date.now();
    const coalesce = opts.key && opts.key === S.lastKey && now - S.lastTime < 1500;
    if (!coalesce) {
      S.undo.push(JSON.stringify(S.flow));
      if (S.undo.length > 150) S.undo.shift();
      S.redo = [];
    }
    S.lastKey = opts.key || null; S.lastTime = now;
    fn(S.flow);
    changed(opts);
  }

  function changed(opts) {
    opts = opts || {};
    S.testStale = true;
    renderCanvas();
    if (opts.panel) renderProps();
    renderCheck();
    renderTitle();
    updateTestNote();
    if (S.tab === 'json' && document.activeElement !== $('jsonText')) renderJson();
    updateUndoButtons();
    markDirty();
    save();
  }
  function markDirty() { if (BACKEND && !S.db.dirty) { S.db.dirty = true; renderDbStatus(); } }

  // dbInfo: {flowId, version, status} when the flow came from the database; otherwise it's a new/local flow.
  function replaceFlow(f, msg, dbInfo) {
    S.undo.push(JSON.stringify(S.flow));
    S.redo = [];
    S.flow = f;
    S.db = dbInfo ? { flowId: dbInfo.flowId, version: dbInfo.version, status: dbInfo.status, dirty: false, savedAt: null }
                  : { flowId: null, version: null, status: null, dirty: !!BACKEND, savedAt: null };
    renderDbStatus();
    normalize();
    S.sel = null;
    renderAll();
    fitView();
    save();
    if (msg) toast(msg);
  }

  function undo() {
    if (!S.undo.length) return;
    S.redo.push(JSON.stringify(S.flow));
    S.flow = JSON.parse(S.undo.pop());
    S.lastKey = null;
    fixSelection();
    renderAll();
    markDirty();
    save();
  }
  function redo() {
    if (!S.redo.length) return;
    S.undo.push(JSON.stringify(S.flow));
    S.flow = JSON.parse(S.redo.pop());
    S.lastKey = null;
    fixSelection();
    renderAll();
    markDirty();
    save();
  }
  function fixSelection() {
    if (!S.sel) return;
    if (S.sel.kind === 'node' && !byId(S.sel.id)) S.sel = null;
    if (S.sel && S.sel.kind === 'edge') { const n = byId(S.sel.from); if (!n || !getPort(n, S.sel.port)) S.sel = null; }
  }
  function updateUndoButtons() {
    $('btnUndo').disabled = !S.undo.length;
    $('btnRedo').disabled = !S.redo.length;
  }

  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify({ flow: S.flow, mocks: S.mocks, catalog: S.catalog, db: S.db, dbCatalog: S.dbCatalog })); } catch (e) { /* storage unavailable */ }
    }, 300);
  }
  function loadSaved() {
    try { const raw = localStorage.getItem(STORE_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }

  function normalize() {
    const f = S.flow;
    f.nodes = f.nodes || [];
    if (!f.bindings) f.bindings = {};
    if (f.nodes.some((n) => !n.ui || typeof n.ui.x !== 'number')) autoLayout();
  }

  // ======================================================================== analysis
  function reachable() {
    const seen = new Set();
    const stack = [S.flow.start];
    while (stack.length) {
      const id = stack.pop();
      const n = byId(id);
      if (!n || seen.has(id)) continue;
      seen.add(id);
      ports(n).forEach((p) => { const t = getPort(n, p.key); if (t) stack.push(t); });
    }
    return seen;
  }

  // For every slot: is it asked on all / some / no paths from start to submit (or to the end)?
  function coverage() {
    const nodes = S.flow.nodes;
    const hasSubmit = nodes.some((n) => n.type === 'submit');
    const isGoal = (n) => (hasSubmit ? n.type === 'submit' : n.type === 'end' || ports(n).every((p) => !getPort(n, p.key)));
    const paths = [];
    let budget = 20000;
    (function dfs(id, seen, slots) {
      if (budget-- <= 0 || paths.length >= 1000) return;
      const n = byId(id);
      if (!n || seen.has(id)) return;
      const s2 = (n.type === 'ask' || n.type === 'repeat') && n.slot ? slots.concat(n.slot) : slots;
      if (isGoal(n)) { paths.push(new Set(s2)); return; }
      seen.add(id);
      ports(n).forEach((p) => { const t = getPort(n, p.key); if (t) dfs(t, seen, s2); });
      seen.delete(id);
    })(S.flow.start, new Set(), []);
    const cov = {};
    knownSlots().forEach((s) => {
      const c = paths.filter((p) => p.has(s)).length;
      cov[s] = !paths.length || c === 0 ? 'never' : c === paths.length ? 'always' : 'sometimes';
    });
    return { cov, paths: paths.length, goal: hasSubmit ? 'submit' : 'the end' };
  }

  function analyze() {
    const f = S.flow;
    const list = [];
    const byNode = {};
    const add = (level, msg, nodeId) => {
      list.push({ level, msg, nodeId });
      if (nodeId) byNode[nodeId] = byNode[nodeId] === 'error' ? 'error' : level;
    };
    if (!/^[a-z0-9_]{1,100}$/.test(f.flowId || '')) add('error', 'Flow id must use lowercase letters, digits and _ (set it in Properties with nothing selected).');
    if (!byId(f.start)) add('error', 'The flow has no valid start node.');

    const slots = knownSlots();
    if (slots.indexOf(BUILTIN_USER) >= 0) {
      add('error', 'A field is named "' + BUILTIN_USER + '", which is reserved for the signed-in user. Rename it.',
        (f.nodes.find((n) => n.slot === BUILTIN_USER) || {}).id);
    }
    const als = aliases();
    const placeholders =(text, nodeId) => {
      String(text || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
        const dot = k.indexOf('.');
        // alias.field of a source missing from the catalog can't be checked; only flag unknown aliases then
        const unchecked = dot > 0 && als.indexOf(k.slice(0, dot)) >= 0 && !sourceDef(sourceForAlias(k.slice(0, dot)));
        if (slots.indexOf(k) < 0 && !unchecked && k !== BUILTIN_USER) add('warning', '{{' + k + '}} is not a known field.', nodeId);
        return _;
      });
    };
    const checkValidators = (vals, nodeId) => {
      (vals || []).forEach((v) => {
        if (v.type === 'regex') {
          try { new RegExp(v.pattern); } catch (e) { add('error', 'Invalid pattern: ' + v.pattern, nodeId); }
          if (/\(\?[=!<]/.test(v.pattern || '')) add('warning', 'Pattern uses a lookahead/lookbehind, which Oracle regex does not support.', nodeId);
        }
        if (v.type === 'server' && !v.connector) add('error', 'Server check has no connector.', nodeId);
      });
    };
    // Choice answers: fixed options, or a lookup list with its parameters.
    const checkChoice = (spec, nodeId, what) => {
      if (spec.kind !== 'choice') return;
      if (!('optionsFrom' in spec)) {
        if (!(spec.options || []).length) add('error', what + ' has no options.', nodeId);
        return;
      }
      if (!spec.optionsFrom) { add('error', what + ' has no lookup list selected.', nodeId); return; }
      if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(spec.optionsFrom)) add('error', 'Lookup list id "' + spec.optionsFrom + '" must be letters, digits and _.', nodeId);
      const params = spec.optionsParams || {};
      Object.keys(params).forEach((k) => {
        if (!/^[a-z][a-z0-9_]{0,29}$/.test(k)) add('error', 'Parameter name "' + k + '" must be lowercase letters, digits and _ (up to 30).', nodeId);
        if (!params[k]) add('error', 'Parameter "' + k + '" of ' + spec.optionsFrom + ' has no answer selected.', nodeId);
        else if (slots.indexOf(params[k]) < 0) add('warning', 'Parameter "' + k + '" uses "' + params[k] + '", which is never asked or loaded.', nodeId);
      });
      const reg = dbLov(spec.optionsFrom);
      if (reg) {
        (reg.params || []).forEach((p) => { if (!(p in params)) add('error', 'Lookup list "' + spec.optionsFrom + '" needs the parameter :' + p.toUpperCase() + '.', nodeId); });
        Object.keys(params).forEach((k) => {
          if (reg.type === 'SQL' && (reg.params || []).indexOf(k) < 0) add('warning', 'Lookup list "' + spec.optionsFrom + '" doesn\'t use :' + k.toUpperCase() + '.', nodeId);
        });
      }
    };
    const checkCond = (c, nodeId) => {
      if (!c) { add('error', 'A branch has no condition.', nodeId); return; }
      if (c.all || c.any) { (c.all || c.any).forEach((x) => checkCond(x, nodeId)); return; }
      if (c.not) { checkCond(c.not, nodeId); return; }
      if (!c.slot) add('error', 'A condition has no field selected.', nodeId);
      else if (slots.indexOf(c.slot) < 0) add('warning', 'Condition uses "' + c.slot + '", which is never asked or bound.', nodeId);
    };

    f.nodes.forEach((n) => {
      ports(n).forEach((p) => {
        const t = getPort(n, p.key);
        if (t && !byId(t)) add('error', '"' + p.label + '" points to missing node "' + t + '".', n.id);
        else if (!t && !p.optional && n.type !== 'end') add('warning', '"' + p.label + '" is not connected; the conversation would stop here.', n.id);
      });
      switch (n.type) {
        case 'menu': {
          const opts = n.options || [];
          if (!opts.length) add('error', 'Menu has no options.', n.id);
          if (!n.prompt) add('warning', 'Menu has no question text; only the buttons are shown.', n.id);
          else placeholders(n.prompt, n.id);
          if (n.note) placeholders(n.note, n.id);
          if (n.slot) {
            if (n.slot === BUILTIN_USER) add('error', '"' + BUILTIN_USER + '" is set by the server and can\'t be changed.', n.id);
            else if (!/^[a-z][a-z0-9_]{0,99}$/.test(n.slot)) add('error', 'Field name "' + n.slot + '" must be lowercase letters, digits and _.', n.id);
          }
          const seenVals = {};
          opts.forEach((o, i) => {
            const v = String(o.value === undefined || o.value === null ? '' : o.value).trim();
            if (!v) add('error', 'Option ' + (i + 1) + ' has no value.', n.id);
            else if (seenVals[v]) add('error', 'Two options have the value "' + v + '".', n.id);
            seenVals[v] = true;
            if (!o.label) add('warning', 'Option ' + (i + 1) + ' has no label, so its value "' + v + '" is shown.', n.id);
            else placeholders(o.label, n.id);
            if (o.when) checkCond(o.when, n.id);
          });
          if (opts.length && opts.every((o) => o.when)) add('warning', 'Every option has a condition; when none holds the menu shows no buttons.', n.id);
          break;
        }
        case 'ask': {
          const spec = n.input || {};
          if (!n.slot) add('error', 'Ask has no field (slot) name.', n.id);
          else if (!/^[a-z][a-z0-9_]{0,99}$/.test(n.slot)) add('error', 'Field name "' + n.slot + '" must be lowercase letters, digits and _.', n.id);
          if (!n.prompt) add('error', 'Ask has no question text.', n.id);
          placeholders(n.prompt, n.id);
          if (n.note) placeholders(n.note, n.id);
          checkChoice(spec, n.id, 'Choice question');
          if (spec.kind === 'number' && isFilled(spec.min) && isFilled(spec.max) && spec.min > spec.max) add('error', 'Minimum is greater than maximum.', n.id);
          if (spec.kind === 'file') {
            if (isFilled(spec.maxSizeKb) && (spec.maxSizeKb < 1 || spec.maxSizeKb > 20480)) add('error', 'File size limit must be 1 to 20480 KB.', n.id);
            if (!spec.accept || !String(spec.accept).trim()) add('warning', 'Any type of file is accepted. Set the accepted types (e.g. .pdf, image/*).', n.id);
            if (!f.nodes.some((x) => x.type === 'submit' || (x.type === 'email' && (x.attachments || []).indexOf(n.slot) >= 0))) {
              add('warning', 'Files are kept in FC_FILES; without a Submit step (or an Email that attaches it) nothing ever reads them.', n.id);
            }
          }
          checkValidators(n.validators, n.id);
          break;
        }
        case 'repeat': {
          const seen = {};
          if (!n.slot) add('error', 'Repeat has no list name (slot).', n.id);
          else if (!/^[a-z][a-z0-9_]{0,99}$/.test(n.slot)) add('error', 'List name "' + n.slot + '" must be lowercase letters, digits and _.', n.id);
          else if (askSlots().indexOf(n.slot) >= 0) add('error', 'An Ask step also uses "' + n.slot + '".', n.id);
          if (!(n.fields || []).length) add('error', 'Repeat has no questions for each item.', n.id);
          if (isFilled(n.min) && isFilled(n.max) && Number(n.min) > Number(n.max)) add('error', 'Minimum items is greater than maximum.', n.id);
          if (isFilled(n.max) && (n.max < 1 || n.max > 100)) add('error', 'Maximum items must be 1 to 100.', n.id);
          (n.fields || []).forEach((fd) => {
            if (!/^[a-z][a-z0-9_]{0,49}$/.test(fd.field || '')) { add('error', 'Item field "' + (fd.field || '') + '" must be lowercase letters, digits and _.', n.id); return; }
            if (seen[fd.field]) add('error', 'Item field "' + fd.field + '" is listed twice.', n.id);
            seen[fd.field] = true;
            const spec = fd.input || {};
            if (spec.kind === 'file') add('error', 'Item fields can\'t be file answers. Use a separate Ask step for the file.', n.id);
            checkChoice(spec, n.id, 'Choice field "' + fd.field + '"');
            checkValidators(fd.validators, n.id);
            if (fd.note) placeholders(fd.note, n.id);
          });
          const itemNames = (n.fields || []).map((fd) => fd.field).concat(['n', 'item', 'count', 'min', 'max', 'title']);
          [n.prompt].concat((n.fields || []).map((fd) => fd.prompt)).forEach((t) => placeholders(String(t || '')
            .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => (itemNames.indexOf(k) >= 0 ? '' : m)), n.id));
          String(n.itemTitle || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => {
            if (itemNames.indexOf(k) < 0) add('warning', 'Item title uses {{' + k + '}}, which is not an item field.', n.id);
            return m;
          });
          break;
        }
        case 'bulkUpdate': {
          const src = sourceDef(n.source);
          const crit = n.byRowFilter ? [] : (n.criteria || []);
          if (!n.source) add('error', 'Bulk update has no data source.', n.id);
          else if (!src) add('warning', 'Data source "' + n.source + '" is not in the designer catalog, so its fields can\'t be checked. Add it in the Data tab.', n.id);
          if (!crit.length && !n.byRowFilter) add('error', 'Bulk update has no search criteria. Add one, or choose "The signed-in user\'s records".', n.id);
          if (n.byRowFilter && src && src.sourceType !== 'PLSQL' && !String(src.rowFilter || '').trim()) {
            add('error', 'Data source "' + n.source + '" has no row filter, so "the signed-in user\'s records" would be every record.', n.id);
          }
          crit.forEach((c) => {
            if (!c.field || !c.slot) { add('error', 'A search criterion is incomplete.', n.id); return; }
            const sf = sourceField(n.source, c.field);
            if (src && (!sf || !sf.searchable)) add('error', 'Field "' + c.field + '" is not searchable in ' + n.source + '.', n.id);
          });
          const setKeys = Object.keys(n.set || {});
          if (!setKeys.length) add('error', 'Bulk update doesn\'t change any field. Add one under "Set".', n.id);
          setKeys.forEach((k) => {
            const sf = sourceField(n.source, k);
            if (src && !sf) add('error', '"' + k + '" is not a field of ' + n.source + '.', n.id);
            else if (sf && !sf.updatable) add('error', '"' + k + '" is not updatable in ' + n.source + '; every row would be refused.', n.id);
            const v = n.set[k];
            if (v && v.slot && slots.indexOf(v.slot) < 0) add('warning', 'The new value of "' + k + '" comes from "' + v.slot + '", which is never captured.', n.id);
          });
          if (isFilled(n.maxRows) && (n.maxRows < 1 || n.maxRows > 500)) add('error', 'Maximum records must be 1 to 500.', n.id);
          if (n.requireVerified && verifiedSlots().indexOf(n.requireVerified) < 0) add('error', 'No Verify step checks "' + n.requireVerified + '".', n.id);
          Object.keys(n.prompts || {}).forEach((k) => placeholders(String(n.prompts[k])
            .replace(/\{\{\s*(count|records|changes|updated|failed|max)\s*\}\}/g, ''), n.id));
          break;
        }
        case 'lookup': case 'submit':
          if (!n.connector) add('error', TYPES[n.type].label + ' has no connector.', n.id);
          break;
        case 'agent': {
          if (!n.provider) add('error', 'Agent has no model provider.', n.id);
          else if (BACKEND && S.ai && !S.ai.providers.some((p) => p.id === n.provider)) add('error', 'Provider "' + n.provider + '" is not in FC_AI_PROVIDERS (or not enabled).', n.id);
          if (!String(n.goal || '').trim()) add('error', 'Agent has no task (goal).', n.id);
          placeholders(n.goal, n.id); placeholders(n.instructions, n.id); placeholders(n.intro, n.id);
          const seenOut = {};
          (n.outputs || []).forEach((o, i) => {
            if (!o.name) { add('error', 'Field ' + (i + 1) + ' has no name.', n.id); return; }
            if (o.name === BUILTIN_USER) add('error', '"' + BUILTIN_USER + '" is set by the server and can\'t be changed.', n.id);
            else if (!/^[a-z][a-z0-9_]{0,99}$/.test(o.name)) add('error', 'Field name "' + o.name + '" must be lowercase letters, digits and _.', n.id);
            if (seenOut[o.name]) add('error', 'Two fields are named "' + o.name + '".', n.id);
            seenOut[o.name] = true;
            if (o.kind === 'choice' && !(o.options || []).length) add('error', 'Choice field "' + o.name + '" has no options.', n.id);
          });
          if (!(n.outputs || []).length && !(n.exits || []).length) add('warning', 'The agent fills no fields and has no exits; it can only finish without results.', n.id);
          const seenEx = {};
          (n.exits || []).forEach((e, i) => {
            if (!e.name || !/^[a-z][a-z0-9_]{0,49}$/.test(e.name)) add('error', 'Exit ' + (i + 1) + ' needs a name of lowercase letters, digits and _.', n.id);
            else if (seenEx[e.name]) add('error', 'Two exits are named "' + e.name + '".', n.id);
            seenEx[e.name] = true;
            if (!e.next) add('warning', 'Exit "' + (e.name || i + 1) + '" goes nowhere.', n.id);
          });
          (n.inputs || []).forEach((k) => { if (slots.indexOf(k) < 0) add('warning', 'The agent sees "' + k + '", which the flow never sets.', n.id); });
          if (BACKEND && S.ai) {
            (n.tools || []).forEach((t) => { if (!S.ai.tools.some((x) => x.id === t)) add('error', 'Tool "' + t + '" is not in FC_AI_TOOLS (or not enabled).', n.id); });
            (n.skills || []).forEach((t) => { if (!S.ai.skills.some((x) => x.id === t)) add('error', 'Skill "' + t + '" is not in FC_AI_SKILLS (or not enabled).', n.id); });
          }
          break;
        }
        case 'email': {
          if (!String(n.to || '').trim()) add('error', 'Email has no recipient (To).', n.id);
          if (!String(n.subject || '').trim()) add('error', 'Email has no subject.', n.id);
          if (!String(n.body || '').trim()) add('warning', 'Email has no message text.', n.id);
          if (!n.connector && !String(n.from || '').trim()) add('error', 'Email needs a From address (APEX_MAIL requires one), or a connector that sends it.', n.id);
          ['to', 'cc', 'bcc', 'replyTo', 'from', 'subject', 'body', 'message', 'errorMessage'].forEach((k) => placeholders(n[k], n.id));
          ['to', 'cc', 'bcc', 'replyTo', 'from'].forEach((k) => String(n[k] || '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean).forEach((a) => {
            if (!/\{\{/.test(a) && !/^[^\s@<>,;"()]+@[^\s@<>,;"()]+\.[^\s@<>,;"()]+$/.test(a)) add('error', '"' + a + '" is not an email address.', n.id);
          }));
          const files = fileSlots();
          (n.attachments || []).forEach((a) => { if (files.indexOf(a) < 0) add('error', 'Attachment "' + a + '" is not a file answer.', n.id); });
          break;
        }
        case 'teams': {
          if (!String(n.channel || '').trim()) add('error', 'Post to Teams has no channel.', n.id);
          else if (!/\{\{/.test(n.channel) && !/^[a-z0-9_-]+$/.test(n.channel)) add('error', 'Channel names use lower case letters, digits, _ and - (as in FC_TEAMS_CHANNELS).', n.id);
          if (!String(n.title || '').trim() && !String(n.text || '').trim()) add('error', 'Post to Teams needs a title or text.', n.id);
          if ((n.facts || []).length > 20) add('error', 'A card can show at most 20 facts.', n.id);
          (n.facts || []).forEach((f) => { if (!String(f.title || '').trim()) add('warning', 'A fact has no label.', n.id); placeholders(f.title, n.id); placeholders(f.value, n.id); });
          if (n.link && !/^(https:\/\/|\{\{)/i.test(String(n.link).trim())) add('error', 'The link must start with https://.', n.id);
          ['channel', 'title', 'text', 'link', 'linkLabel', 'message', 'errorMessage'].forEach((k) => placeholders(n[k], n.id));
          break;
        }
        case 'workflow': {
          if (!String(n.workflow || '').trim()) add('error', 'Workflow has no static ID.', n.id);
          if (n.applicationId !== undefined && !/^\d+$/.test(String(n.applicationId))) add('error', 'Application ID must be a number.', n.id);
          Object.keys(n.parameters || {}).forEach((k) => {
            if (!/^[A-Za-z][A-Za-z0-9_$#]{0,254}$/.test(k)) add('error', 'Parameter "' + k + '" is not a valid static ID.', n.id);
            placeholders(n.parameters[k], n.id);
          });
          if (n.resultSlot && !/^[a-z][a-z0-9_]{0,99}$/.test(n.resultSlot)) add('error', 'Workflow ID field "' + n.resultSlot + '" must be lowercase letters, digits and _.', n.id);
          if (!n.onError) add('warning', 'If the workflow can\'t start, the conversation ends as failed. Connect "error" to a step that explains what to do.', n.id);
          ['detailKey', 'message', 'errorMessage'].forEach((k) => placeholders(n[k], n.id));
          break;
        }
        case 'rest': {
          const m = String(n.method || 'GET').toUpperCase();
          if (!n.endpoint) add('error', 'REST call has no endpoint.', n.id);
          else if (BACKEND && S.rest) {
            const ep = S.rest.find((x) => x.id === n.endpoint);
            if (!ep) add('error', 'Endpoint "' + n.endpoint + '" is not in FC_REST_ENDPOINTS (or not enabled).', n.id);
            else if (String(ep.methods || 'GET').split(',').indexOf(m) < 0) add('error', 'Endpoint "' + n.endpoint + '" allows only ' + (ep.methods || 'GET') + ', not ' + m + '.', n.id);
          }
          if (n.path && !/^[\/?]/.test(n.path)) add('error', 'The path must start with / or ?.', n.id);
          if (/^\/\/|:\/\/|\\/.test(n.path || '')) add('error', 'The path must be relative to the endpoint (no host).', n.id);
          Object.keys(n.headers || {}).forEach((k) => {
            if (REST_BLOCKED.test(k) || !/^[A-Za-z0-9-]+$/.test(k)) add('error', 'Header "' + k + '" can only be set on the endpoint (FC_REST_ENDPOINTS.EXTRA_HEADERS or its Web Credential).', n.id);
          });
          Object.keys(n.map || {}).forEach((k) => {
            if (k === BUILTIN_USER) add('error', '"' + BUILTIN_USER + '" is set by the server and can\'t be changed.', n.id);
            else if (!/^[a-z][a-z0-9_]{0,99}$/.test(k)) add('error', 'Field name "' + k + '" must be lowercase letters, digits and _.', n.id);
          });
          if (n.statusSlot && !/^[a-z][a-z0-9_]{0,99}$/.test(n.statusSlot)) add('error', 'Status field "' + n.statusSlot + '" must be lowercase letters, digits and _.', n.id);
          if (m === 'GET' && n.body !== undefined) add('warning', 'A GET sends no body; the body template is ignored.', n.id);
          if (m !== 'GET' && !Object.keys(n.map || {}).length && !n.message) add('warning', 'Nothing tells the user the call worked: add a message or map a field.', n.id);
          if (m === 'GET' && !Object.keys(n.map || {}).length && !n.statusSlot) add('warning', 'The GET result is not used: map at least one field.', n.id);
          ['path', 'message', 'errorMessage', 'notFoundMessage'].forEach((k) => placeholders(n[k], n.id));
          ['query', 'headers'].forEach((k) => Object.keys(n[k] || {}).forEach((q) => placeholders(n[k][q], n.id)));
          if (n.body !== undefined) placeholders(JSON.stringify(n.body), n.id);
          break;
        }
        case 'set': {
          if (!(n.assign || []).length) add('warning', 'Set values sets nothing.', n.id);
          (n.assign || []).forEach((a) => {
            if (!a.slot) { add('error', 'A value has no field name.', n.id); return; }
            if (a.slot === BUILTIN_USER) add('error', '"' + BUILTIN_USER + '" is set by the server and can\'t be changed.', n.id);
            else if (!/^[a-z][a-z0-9_]{0,99}$/.test(a.slot)) add('error', 'Field name "' + a.slot + '" must be lowercase letters, digits and _.', n.id);
            if ('from' in a) {
              if (!a.from) add('error', 'Copy into "' + a.slot + '" has no source.', n.id);
              else if (slots.indexOf(a.from) < 0 && a.from !== BUILTIN_USER && aliases().indexOf(String(a.from).split('.')[0]) < 0) {
                add('warning', '"' + a.slot + '" copies "' + a.from + '", which the flow never sets' +
                  (/^context\./.test(a.from) ? ' (declare it under Context variables in flow settings).' : '.'), n.id);
              }
            }
            if ('template' in a) placeholders(a.template, n.id);
          });
          break;
        }
        case 'condition':
          if (!(n.branches || []).length) add('warning', 'Condition has no branches.', n.id);
          (n.branches || []).forEach((b) => checkCond(b.when, n.id));
          break;
        case 'message': case 'end':
          placeholders(n.text, n.id);
          break;
        case 'summary':
          placeholders(n.text, n.id);
          if (n.mode === 'changes') {
            if (!n.record) add('error', 'This changes summary has no record selected.', n.id);
            else if (als.indexOf(n.record) < 0) add('error', 'No Find record loads a record called "' + n.record + '".', n.id);
          }
          break;
        case 'verify': {
          if (!n.slot) add('error', 'Verify has no answer selected to send the code to.', n.id);
          else if (askSlots().indexOf(n.slot) < 0) add('error', 'Verify uses "' + n.slot + '", which is never asked.', n.id);
          if (!n.connector) add('error', 'Verify has no connector to send the code.', n.id);
          if (isFilled(n.codeLength) && (n.codeLength < 4 || n.codeLength > 10)) add('error', 'Code length must be 4 to 10 digits.', n.id);
          if (isFilled(n.maxAttempts) && n.maxAttempts < 1) add('error', 'Allow at least one attempt.', n.id);
          if (!findNodes().some((x) => x.requireVerified === n.slot)) {
            add('warning', 'No Find record requires "' + n.slot + '" to be verified, so searches are not limited to the verified identity.', n.id);
          }
          Object.keys(n.prompts || {}).forEach((k) => placeholders(String(n.prompts[k])
            .replace(/\{\{\s*(codeLength|ttlMinutes|remaining|tries)\s*\}\}/g, ''), n.id));
          break;
        }
        case 'findRecord': {
          const src = sourceDef(n.source);
          const crit = n.byRowFilter ? [] : (n.criteria || []);
          const rf = String((src && src.rowFilter) || '');
          if (n.byRowFilter && src) {
            if (src.sourceType === 'PLSQL') {
              add('warning', 'Data source "' + n.source + '" is PL/SQL: its search function gets no criteria and must limit the rows to the user itself (appUser in the payload).', n.id);
            } else if (!rf.trim()) {
              add('error', 'Data source "' + n.source + '" has no row filter, so it can\'t find "the signed-in user\'s records". Set one in the Data tab, e.g. upper(t.username) = upper(:APP_USER).', n.id);
            } else if (!/:(APP_USER|FC_VERIFIED)\b/i.test(rf)) {
              add('warning', 'The row filter of "' + n.source + '" doesn\'t use :APP_USER or :FC_VERIFIED, so every user gets the same records.', n.id);
            }
          }
          if (n.requireVerified) {
            if (verifiedSlots().indexOf(n.requireVerified) < 0) add('error', 'No Verify step checks "' + n.requireVerified + '".', n.id);
            else if (n.byRowFilter) {
              if (src && src.sourceType !== 'PLSQL' && rf.trim() && !/:FC_VERIFIED\b/i.test(rf)) add('error', 'The row filter of "' + n.source + '" must use :FC_VERIFIED, so the records are limited to the verified identity.', n.id);
            } else if (!crit.some((c) => c.slot === n.requireVerified && (c.op || 'eq') === 'eq' && !c.optional)) {
              add('error', 'Add a required "equals" criterion on "' + n.requireVerified + '", so the search is limited to the verified identity.', n.id);
            }
          } else if (verifiedSlots().length) {
            add('warning', 'This flow verifies "' + verifiedSlots().join('", "') + '" but this search doesn\'t require it.', n.id);
          }
          if (!n.source) add('error', 'Find record has no data source.', n.id);
          else if (!src) add('warning', 'Data source "' + n.source + '" is not in the designer catalog, so its fields can\'t be checked. Add it in the Data tab.', n.id);
          if (!/^[a-z][a-z0-9_]{0,49}$/.test(n.as || '')) add('error', 'Record alias must use lowercase letters, digits and _.', n.id);
          else if (n.as === 'context') add('error', 'The alias "context" is reserved for page context values.', n.id);
          else if (findNodes().filter((x) => x.as === n.as).length > 1) add('error', 'Another Find record already uses the alias "' + n.as + '".', n.id);
          if (!crit.length && !n.byRowFilter) add('error', 'Find record has no search criteria. Add one, or choose "The signed-in user\'s records".', n.id);
          crit.forEach((c) => {
            if (!c.field || !c.slot) { add('error', 'A search criterion is incomplete.', n.id); return; }
            const sf = sourceField(n.source, c.field);
            if (src && (!sf || !sf.searchable)) add('error', 'Field "' + c.field + '" is not searchable in ' + n.source + '.', n.id);
            else if (sf && String(sf.ops || 'eq').split(',').map((s) => s.trim()).indexOf(c.op || 'eq') < 0) {
              add('error', '"' + c.field + '" does not allow the "' + (c.op || 'eq') + '" search.', n.id);
            }
            if (critValues(n).indexOf(c.slot) < 0) {
              add('warning', 'Criterion uses "' + c.slot + '", which the flow never sets' +
                (/^context\./.test(c.slot) ? ' (declare it under Context variables in flow settings).' : '.'), n.id);
            }
          });
          if (crit.length && crit.every((c) => c.optional)) add('warning', 'Every criterion is optional; with no answers the search goes straight to "not found".', n.id);
          Object.keys(n.prompts || {}).forEach((k) => placeholders(String(n.prompts[k]).replace(/\{\{\s*count\s*\}\}/g, ''), n.id));
          if (src) {
            const names = src.fields.map((f) => f.field);
            [(n.card || {}).title, (n.card || {}).subtitle].forEach((t) => String(t || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => {
              if (names.indexOf(k) < 0) add('warning', 'Result card uses {{' + k + '}}, which is not a field of ' + n.source + '.', n.id);
              return m;
            }));
          }
          break;
        }
        case 'changeFields': {
          const srcId = sourceForAlias(n.record);
          const seen = {};
          if (!n.record) add('error', 'Change fields has no record selected.', n.id);
          else if (als.indexOf(n.record) < 0) add('error', 'No Find record loads a record called "' + n.record + '".', n.id);
          if (!(n.fields || []).length) add('error', 'Change fields has no fields.', n.id);
          (n.fields || []).forEach((fd) => {
            if (!fd.field) { add('error', 'A field has no source field selected.', n.id); return; }
            if (seen[fd.field]) add('error', 'Field "' + fd.field + '" is listed twice.', n.id);
            seen[fd.field] = true;
            const sf = sourceField(srcId, fd.field);
            if (sourceDef(srcId) && !sf) add('error', '"' + fd.field + '" is not a field of ' + srcId + '.', n.id);
            else if (sf && !sf.updatable) add('error', '"' + fd.field + '" is not updatable in ' + srcId + '; the server would refuse the change.', n.id);
            const spec = fd.input || {};
            checkChoice(spec, n.id, 'Choice field "' + fd.field + '"');
            checkValidators(fd.validators, n.id);
            if (fd.editableWhen) checkCond(fd.editableWhen, n.id);
            placeholders(fd.prompt, n.id);
          });
          [n.prompt, n.cardTitle, n.againPrompt].forEach((t) => placeholders(t, n.id));
          if (n.record && !f.nodes.some((x) => x.type === 'saveChanges' && x.record === n.record)) {
            add('warning', 'No Save changes node saves "' + n.record + '", so edits are never stored.', n.id);
          }
          break;
        }
        case 'saveChanges':
          if (!n.record) add('error', 'Save changes has no record selected.', n.id);
          else if (als.indexOf(n.record) < 0) add('error', 'No Find record loads a record called "' + n.record + '".', n.id);
          else if (!f.nodes.some((x) => x.type === 'changeFields' && x.record === n.record)) {
            add('warning', 'No Change fields node edits "' + n.record + '", so there is never anything to save.', n.id);
          }
          if (!n.conflict && !n.error) add('warning', 'Neither "conflict" nor "error" is connected: if someone else changes the record meanwhile, the conversation ends as failed.', n.id);
          break;
      }
    });

    const reach = reachable();
    f.nodes.forEach((n) => { if (byId(f.start) && !reach.has(n.id)) add('warning', 'Not reachable from the start.', n.id); });
    if (byId(f.start) && !f.nodes.some((n) => n.type === 'end' && reach.has(n.id))) add('warning', 'No End node is reachable.');

    const cv = coverage();
    Object.keys(f.bindings || {}).forEach((s) => {
      const b = f.bindings[s];
      if (b && b.required && cv.cov[s] !== 'always' && slots.indexOf(s) >= 0 && askSlots().indexOf(s) >= 0) {
        add('warning', 'Required form field "' + s + '" is not asked on every path to ' + cv.goal + '.');
      }
    });

    if (BACKEND && S.dbConnectors) {
      const registered = S.dbConnectors.map((c) => c.id);
      Object.keys(connectorUses()).forEach((c) => {
        if (registered.indexOf(c) < 0) add('warning', 'Connector "' + c + '" is not registered in FC_CONNECTORS on the server.');
      });
    }
    if (BACKEND && S.dbLovs) {
      const lu = lovUses();
      Object.keys(lu).forEach((id) => {
        if (!dbLov(id)) add('error', 'Lookup list "' + id + '" is not in FC_LOVS on the server.', lu[id][0].where);
      });
    }
    if (BACKEND && S.dbCatalog) {
      sourceUses().forEach((id) => {
        const st = dbSourceState(id);
        const where = (findNodes().find((n) => n.source === id) || {}).id;
        if (st === 'local' && catalog()[id]) add('error', 'Data source "' + id + '" is not in the database yet. Save it from the Data tab.', where);
        else if (st === 'modified') add('warning', 'Data source "' + id + '" has changes that are not saved to the database.', where);
      });
    }

    list.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
    return { list, byNode, coverage: cv };
  }

  // ======================================================================== layout
  function autoLayout() {
    const f = S.flow;
    const state = {}, order = [], back = new Set();
    const dfs = (id) => {
      state[id] = 1;
      const n = byId(id);
      ports(n).forEach((p) => {
        const t = getPort(n, p.key);
        if (!t || !byId(t)) return;
        if (state[t] === 1) back.add(id + '>' + p.key);
        else if (!state[t]) dfs(t);
      });
      state[id] = 2;
      order.push(id);
    };
    if (byId(f.start)) dfs(f.start);
    f.nodes.forEach((n) => { if (!state[n.id]) dfs(n.id); });
    order.reverse();
    const rank = {};
    order.forEach((id) => { rank[id] = rank[id] || 0; });
    order.forEach((id) => {
      const n = byId(id);
      ports(n).forEach((p) => {
        const t = getPort(n, p.key);
        if (!t || !byId(t) || back.has(id + '>' + p.key)) return;
        rank[t] = Math.max(rank[t] || 0, rank[id] + 1);
      });
    });
    const rows = {};
    order.forEach((id) => { (rows[rank[id]] = rows[rank[id]] || []).push(id); });
    Object.keys(rows).forEach((r) => {
      const row = rows[r];
      row.forEach((id, i) => { byId(id).ui = { x: snap((i - (row.length - 1) / 2) * 300), y: r * 155 }; });
    });
  }

  // ======================================================================== canvas
  let canvas, world, nodesEl, edgeLayer;

  function nodeWidth(n) { return Math.max(NODE_W, ports(n).length * (n.type === 'menu' || n.type === 'agent' ? 120 : 96)); }

  function nodeSummary(n) {
    switch (n.type) {
      case 'ask': return n.prompt;
      case 'condition': return (n.branches || []).length ? null : 'No branches yet';
      case 'menu': return (n.options || []).length ? (n.prompt || '') : 'No options yet';
      case 'lookup': case 'submit': return n.connector ? 'Calls ' + n.connector : '';
      case 'agent': return n.goal ? (n.provider ? '[' + n.provider + '] ' : '') + n.goal : 'No task yet';
      case 'email': return n.to ? 'To ' + n.to + (n.subject ? ': ' + n.subject : '') : 'No recipient yet';
      case 'teams': return n.channel ? 'Post to ' + n.channel + (n.title ? ': ' + n.title : '') : 'No channel yet';
      case 'workflow': return n.workflow ? 'Start ' + n.workflow + (Object.keys(n.parameters || {}).length ? ' (' + Object.keys(n.parameters).join(', ') + ')' : '') +
        (n.resultSlot ? ' → ' + n.resultSlot : '') : 'No workflow yet';
      case 'rest': return n.endpoint ? (n.method || 'GET') + ' ' + n.endpoint + (n.path && n.path !== '/' ? ' ' + n.path : '') +
        (Object.keys(n.map || {}).length ? ' → ' + Object.keys(n.map).join(', ') : '') : 'No endpoint yet';
      case 'verify': return n.slot ? 'Send a code to ' + n.slot + (n.connector ? ' via ' + n.connector : '') : '';
      case 'findRecord': return n.source ? (n.requireVerified ? '\uD83D\uDD12 ' : '') + 'Search ' + n.source + (n.as ? ' → ' + n.as : '') : '';
      case 'changeFields': return n.record ? 'Edit ' + (n.fields || []).length + ' field(s) of ' + n.record : '';
      case 'saveChanges': return n.record ? 'Save changes to ' + n.record : '';
      case 'set': return (n.assign || []).filter((a) => a.slot).map((a) => a.slot + (a.clear ? ' := (empty)' : 'from' in a ? ' := ' + (a.from || '?')
        : 'template' in a ? ' := "' + a.template + '"' : ' := ' + JSON.stringify(a.value))).join('; ') || 'Nothing set yet';
      case 'repeat': return n.slot ? 'List of ' + (n.itemLabel || 'item') + 's → ' + n.slot + ' (' + (isFilled(n.min) ? n.min : 1) + '–' + (n.max || 20) + ')' : '';
      case 'bulkUpdate': return n.source ? 'Update ' + Object.keys(n.set || {}).join(', ') + ' in ' + n.source + ' (max ' + (n.maxRows || 50) + ')' : '';
      case 'summary': return n.mode === 'changes' ? 'Review changes to ' + (n.record || '?') : n.text;
      default: return n.text;
    }
  }

  function renderCanvas() {
    const an = analyze();
    nodesEl.textContent = '';
    S.flow.nodes.forEach((n) => {
      const t = TYPES[n.type];
      const selected = S.sel && S.sel.kind === 'node' && S.sel.id === n.id;
      const el = h('div', {
        class: 'node' + (selected ? ' selected' : '') + (an.byNode[n.id] ? ' has-' + an.byNode[n.id] : ''),
        'data-id': n.id,
        style: 'left:' + n.ui.x + 'px;top:' + n.ui.y + 'px;width:' + nodeWidth(n) + 'px;--c:' + t.color
      });
      if (S.flow.start === n.id) el.append(h('span', { class: 'start-pill', text: 'START' }));
      el.append(h('div', { class: 'nh' }, h('span', { class: 'dot' }), h('span', { class: 'type', text: t.label }), h('span', { class: 'nid', text: n.id, title: n.id })));
      const sum = nodeSummary(n);
      if (n.type !== 'condition' || sum) el.append(h('div', { class: 'nb' + (sum ? '' : ' empty'), text: sum || 'Not configured' }));
      const chips = [];
      if (n.type === 'ask') {
        if (n.slot) chips.push(h('span', { class: 'chip slot', text: n.slot }));
        chips.push(h('span', { class: 'chip', text: (n.input && n.input.kind) || 'text' }));
        if ((n.validators || []).length) chips.push(h('span', { class: 'chip', text: n.validators.length + ' check' + (n.validators.length > 1 ? 's' : '') }));
      }
      if (n.type === 'condition') (n.branches || []).forEach((b, i) => chips.push(h('span', { class: 'chip', text: (i + 1) + ': ' + (condText(b.when) || '?') })));
      if (n.type === 'findRecord') (n.criteria || []).forEach((c) => chips.push(h('span', { class: 'chip', text: c.field + ' ' + (c.op || 'eq') + ' ' + c.slot + (c.optional ? '?' : '') })));
      if (n.type === 'changeFields') (n.fields || []).forEach((f) => chips.push(h('span', { class: 'chip slot', text: f.field || '?' })));
      if (n.type === 'repeat') (n.fields || []).forEach((f) => chips.push(h('span', { class: 'chip slot', text: f.field || '?' })));
      if (n.type === 'bulkUpdate') (n.criteria || []).forEach((c) => chips.push(h('span', { class: 'chip', text: c.field + ' ' + (c.op || 'eq') + ' ' + c.slot })));
      const hid = n.redact || ((n.type === 'changeFields' || n.type === 'repeat') && (n.fields || []).some((f) => f.redact))
        || (n.type === 'agent' && (n.outputs || []).some((o) => o && o.redact));
      if (n.note || ((n.type === 'changeFields' || n.type === 'repeat') && (n.fields || []).some((f) => f && f.note)))
        chips.push(h('span', { class: 'chip', text: 'Note', title: 'Shows an information note while the question is answered' }));
      if (hid) chips.push(h('span', { class: 'chip', text: 'Hidden', title: 'Hidden on screen and masked in logs' }));
      else if (n.pii || (n.type === 'ask' && (S.flow.piiSlots || []).indexOf(n.slot) >= 0)) chips.push(h('span', { class: 'chip', text: 'PII', title: 'Masked in logs' }));
      if (chips.length) el.append(h('div', { class: 'nchips' }, chips));
      const ps = ports(n);
      ps.forEach((p, i) => {
        const pe = h('div', {
          class: 'port' + (getPort(n, p.key) ? ' linked' : ''), 'data-port': p.key,
          title: 'Drag to connect: ' + p.label, style: 'left:' + ((i + 1) / (ps.length + 1)) * 100 + '%'
        }, h('span', { class: 'plabel', text: p.label }));
        el.append(pe);
      });
      nodesEl.append(el);
    });
    drawEdges();
    const pb = $('probBadge');
    const errs = an.list.filter((x) => x.level === 'error').length;
    const warns = an.list.length - errs;
    pb.textContent = an.list.length;
    pb.className = 'badge' + (errs ? ' err' : warns ? ' warn' : '');
    pb.title = errs + ' errors, ' + warns + ' warnings';
  }

  function geometry() {
    const g = {};
    for (const el of nodesEl.children) {
      const n = byId(el.dataset.id);
      if (n) g[n.id] = { x: n.ui.x, y: n.ui.y, w: el.offsetWidth, h: el.offsetHeight };
    }
    return g;
  }

  function curve(sx, sy, tx, ty) {
    const dy = Math.max(50, Math.abs(ty - sy) / 2);
    return 'M' + sx + ',' + sy + ' C' + sx + ',' + (sy + dy) + ' ' + tx + ',' + (ty - dy) + ' ' + tx + ',' + (ty - 2);
  }

  function drawEdges() {
    const g = geometry();
    const ns = 'http://www.w3.org/2000/svg';
    edgeLayer.textContent = '';
    const mk = (d, cls, marker) => {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d); p.setAttribute('class', cls);
      if (marker) p.setAttribute('marker-end', 'url(#fcd-' + marker + ')');
      return p;
    };
    S.flow.nodes.forEach((n) => {
      const ps = ports(n), a = g[n.id];
      if (!a) return;
      ps.forEach((p, i) => {
        const t = getPort(n, p.key), b = g[t];
        if (!b) return;
        const sx = a.x + a.w * (i + 1) / (ps.length + 1), sy = a.y + a.h;
        const d = curve(sx, sy, b.x + b.w / 2, b.y);
        const sel = S.sel && S.sel.kind === 'edge' && S.sel.from === n.id && S.sel.port === p.key;
        const hit = mk(d, 'hit');
        hit.dataset.from = n.id; hit.dataset.port = p.key;
        edgeLayer.append(hit, mk(d, 'edge' + (sel ? ' sel' : ''), sel ? 'arrSel' : 'arr'));
      });
    });
    const d = S.drag;
    if (d && d.mode === 'connect' && d.cur) {
      const n = byId(d.from), a = g[d.from], ps = ports(n);
      const i = ps.findIndex((p) => p.key === d.port);
      const sx = a.x + a.w * (i + 1) / (ps.length + 1), sy = a.y + a.h;
      edgeLayer.append(mk(curve(sx, sy, d.cur.x, d.cur.y), 'edge temp', 'arrSel'));
    }
  }

  function applyView() {
    const v = S.view;
    world.style.transform = 'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.z + ')';
    canvas.style.backgroundPosition = v.x + 'px ' + v.y + 'px';
    canvas.style.backgroundSize = 20 * v.z + 'px ' + 20 * v.z + 'px';
    $('zoomLabel').textContent = Math.round(v.z * 100) + '%';
  }

  function worldPos(cx, cy) {
    const r = canvas.getBoundingClientRect();
    return { x: (cx - r.left - S.view.x) / S.view.z, y: (cy - r.top - S.view.y) / S.view.z };
  }

  function zoomAt(factor, cx, cy) {
    const r = canvas.getBoundingClientRect();
    const mx = cx === undefined ? r.width / 2 : cx - r.left;
    const my = cy === undefined ? r.height / 2 : cy - r.top;
    const z0 = S.view.z, z = clamp(z0 * factor, 0.25, 2);
    S.view.x = mx - (mx - S.view.x) * z / z0;
    S.view.y = my - (my - S.view.y) * z / z0;
    S.view.z = z;
    applyView();
  }

  function fitView() {
    const g = geometry(), ids = Object.keys(g);
    if (!ids.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    ids.forEach((id) => {
      const b = g[id];
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y - 24);
      x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h + 12);
    });
    const r = canvas.getBoundingClientRect();
    // Never shrink below a readable zoom; tall flows open at the top instead.
    const z = clamp(Math.min((r.width - 60) / (x1 - x0), (r.height - 60) / (y1 - y0)), 0.6, 1);
    S.view.z = z;
    S.view.x = (r.width - (x1 - x0) * z) / 2 - x0 * z;
    S.view.y = Math.max(30, (r.height - (y1 - y0) * z) / 2) - y0 * z;
    applyView();
  }

  function select(sel) {
    S.sel = sel;
    renderCanvas();
    if (sel) setTab('props');
    renderProps();
  }

  function addNode(type, wx, wy, connectFrom) {
    const id = uniqueId(type);
    const n = TYPES[type].make(id);
    if (type === 'ask') n.slot = uniqueSlot('field');
    n.ui = { x: snap(wx - nodeWidth(n) / 2), y: snap(wy) };
    mutate((f) => {
      f.nodes.push(n);
      if (!byId(f.start)) f.start = id;
      if (connectFrom) setPort(byId(connectFrom.id), connectFrom.port, id);
    });
    select({ kind: 'node', id });
  }

  function deleteSelection() {
    const sel = S.sel;
    if (!sel) return;
    S.sel = null;
    if (sel.kind === 'node') {
      mutate((f) => {
        f.nodes = f.nodes.filter((n) => n.id !== sel.id);
        f.nodes.forEach((n) => ports(n).forEach((p) => { if (getPort(n, p.key) === sel.id) setPort(n, p.key, null); }));
        if (f.start === sel.id) f.start = f.nodes.length ? f.nodes[0].id : '';
      }, { panel: true });
      toast('Node deleted. Ctrl+Z to undo.');
    } else {
      mutate(() => setPort(byId(sel.from), sel.port, null), { panel: true });
    }
  }

  // Quick-add menu when a connection is dropped on empty canvas.
  let quickEl = null;
  function hideQuick() { if (quickEl) { quickEl.remove(); quickEl = null; } }
  function showQuick(cx, cy, from) {
    hideQuick();
    const r = canvas.getBoundingClientRect();
    const wp = worldPos(cx, cy);
    quickEl = h('div', { class: 'quick', style: 'left:' + clamp(cx - r.left, 4, r.width - 170) + 'px;top:' + clamp(cy - r.top, 4, r.height - 290) + 'px' },
      h('div', { text: 'Add and connect' }),
      Object.keys(TYPES).map((type) => h('button', {
        onclick: () => { hideQuick(); addNode(type, wp.x, wp.y, from); }
      }, h('span', { class: 'dot', style: '--c:' + TYPES[type].color }), TYPES[type].label)));
    canvas.append(quickEl);
  }

  function bindCanvas() {
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.zoom') || e.target.closest('.quick')) return;
      hideQuick();
      const portEl = e.target.closest('.port');
      const nodeEl = e.target.closest('.node');
      if (portEl && nodeEl) {
        e.preventDefault();
        S.drag = { mode: 'connect', from: nodeEl.dataset.id, port: portEl.dataset.port, cur: worldPos(e.clientX, e.clientY) };
        canvas.setPointerCapture(e.pointerId);
        drawEdges();
        return;
      }
      if (nodeEl) {
        const n = byId(nodeEl.dataset.id);
        const p = worldPos(e.clientX, e.clientY);
        S.drag = { mode: 'node', id: n.id, dx: p.x - n.ui.x, dy: p.y - n.ui.y, sx: e.clientX, sy: e.clientY, moved: false, snapshot: JSON.stringify(S.flow) };
        if (!(S.sel && S.sel.kind === 'node' && S.sel.id === n.id)) select({ kind: 'node', id: n.id });
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      const hit = e.target.closest('path.hit');
      if (hit) { select({ kind: 'edge', from: hit.dataset.from, port: hit.dataset.port }); return; }
      S.drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, vx: S.view.x, vy: S.view.y, moved: false };
      canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', (e) => {
      const d = S.drag;
      if (!d) return;
      if (d.mode === 'pan') {
        if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) { d.moved = true; canvas.classList.add('panning'); }
        S.view.x = d.vx + e.clientX - d.sx;
        S.view.y = d.vy + e.clientY - d.sy;
        applyView();
      } else if (d.mode === 'node') {
        if (!d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 4) return;
        d.moved = true;
        const p = worldPos(e.clientX, e.clientY);
        const n = byId(d.id);
        n.ui.x = snap(p.x - d.dx); n.ui.y = snap(p.y - d.dy);
        const el = nodesEl.querySelector('[data-id="' + d.id + '"]');
        if (el) { el.style.left = n.ui.x + 'px'; el.style.top = n.ui.y + 'px'; }
        drawEdges();
      } else if (d.mode === 'connect') {
        d.cur = worldPos(e.clientX, e.clientY);
        drawEdges();
      }
    });

    const end = (e) => {
      const d = S.drag;
      S.drag = null;
      canvas.classList.remove('panning');
      if (!d) return;
      if (d.mode === 'pan' && !d.moved && S.sel) select(null);
      if (d.mode === 'node' && d.moved) {
        S.undo.push(d.snapshot); S.redo = []; S.lastKey = null;
        updateUndoButtons(); save();
      }
      if (d.mode === 'connect') {
        const under = e.type === 'pointerup' ? document.elementFromPoint(e.clientX, e.clientY) : null;
        const target = under && under.closest('.node');
        if (target && target.dataset.id !== d.from) {
          mutate(() => setPort(byId(d.from), d.port, target.dataset.id), { panel: true });
        } else {
          drawEdges();
          if (under && !target && canvas.contains(under)) showQuick(e.clientX, e.clientY, { id: d.from, port: d.port });
        }
      }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
      else { S.view.x -= e.deltaX; applyView(); }
    }, { passive: false });

    canvas.addEventListener('dragover', (e) => e.preventDefault());
    canvas.addEventListener('drop', (e) => {
      e.preventDefault();
      const data = e.dataTransfer.getData('text/plain');
      if (data.indexOf('fc-node:') !== 0) return;
      const p = worldPos(e.clientX, e.clientY);
      addNode(data.slice(8), p.x, p.y - 20);
    });

    $('zoomIn').onclick = () => zoomAt(1.2);
    $('zoomOut').onclick = () => zoomAt(1 / 1.2);
    $('zoomFit').onclick = fitView;
  }

  // ======================================================================== properties panel
  function F(label, control, hint) {
    return h('div', { class: 'f' }, label ? h('label', { text: label }) : null, control, hint ? h('div', { class: 'hint', text: hint }) : null);
  }

  // Text input bound to a getter/setter; setter runs inside mutate().
  function bound(get, set, o) {
    o = o || {};
    const el = h(o.multiline ? 'textarea' : 'input', {
      class: 'in' + (o.mono ? ' mono' : ''), placeholder: o.placeholder || null,
      type: o.multiline ? null : (o.type || 'text'), rows: o.multiline ? (o.rows || 3) : null
    });
    const v = get();
    el.value = v === undefined || v === null ? '' : v;
    el.addEventListener(o.onChange ? 'change' : 'input', () => mutate(() => set(el.value), { key: o.key, panel: !!o.panel }));
    return el;
  }

  function sel(options, value, onChange, o) {
    o = o || {};
    const el = h('select', { class: 'in' + (o.mono ? ' mono' : '') });
    options.forEach((op) => {
      const [v, l] = Array.isArray(op) ? op : [op, op];
      el.append(h('option', { value: v, text: l }));
    });
    el.value = value === undefined || value === null ? '' : value;
    el.addEventListener('change', () => onChange(el.value));
    return el;
  }

  function checkbox(label, checked, onChange) {
    const cb = h('input', { type: 'checkbox', checked: !!checked });
    cb.addEventListener('change', () => onChange(cb.checked));
    return h('label', { class: 'check' }, cb, label);
  }

  function slotChips(target) {
    const slots = knownSlots().filter((s) => s !== BUILTIN_USER).concat([BUILTIN_USER]);
    return h('div', { class: 'chips-ins', title: 'Insert a captured answer' },
      slots.map((s) => h('button', {
        type: 'button', text: '{{' + s + '}}',
        title: s === BUILTIN_USER ? 'The signed-in APEX user (APP_USER), filled in by the server' : null,
        onclick: () => {
          const pos = target.selectionStart != null ? target.selectionStart : target.value.length;
          target.value = target.value.slice(0, pos) + '{{' + s + '}}' + target.value.slice(target.selectionEnd || pos);
          target.dispatchEvent(new Event('input'));
          target.focus();
        }
      })));
  }

  function setOrDelete(obj, key, v) { if (v === '' || v === null || v === undefined) delete obj[key]; else obj[key] = v; }
  function numOrNull(v) { return v === '' ? null : Number(v); }

  function targetSelect(n, key) {
    const opts = [['', '— not connected —']].concat(S.flow.nodes.filter((x) => x.id !== n.id)
      .map((x) => [x.id, x.id + '  (' + TYPES[x.type].label + ')']));
    return sel(opts, getPort(n, key) || '', (v) => mutate(() => setPort(n, key, v || null)), { mono: true });
  }

  function renderProps() {
    const body = $('tab-props');
    body.textContent = '';
    if (!S.sel) { body.append(flowSettings()); return; }
    if (S.sel.kind === 'edge') { body.append(edgePanel()); return; }
    const n = byId(S.sel.id);
    if (!n) { S.sel = null; renderProps(); return; }
    const t = TYPES[n.type];
    body.append(
      h('div', { class: 'ptitle', style: '--c:' + t.color }, h('span', { class: 'dot' }), h('b', { text: t.label })),
      h('p', { class: 'pdesc', text: t.desc }),
      idField(n)
    );
    const editors = { message: textEditor, end: textEditor, ask: askEditor, condition: condEditor, lookup: connEditor, submit: connEditor,
                      summary: summaryEditor, verify: verifyEditor, findRecord: findEditor, changeFields: changeEditor, saveChanges: saveEditor,
                      repeat: repeatEditor, bulkUpdate: bulkEditor, set: setEditor, menu: menuEditor, email: emailEditor, teams: teamsEditor, rest: restEditor, agent: agentEditor, workflow: workflowEditor };
    body.append(editors[n.type](n));
    if (n.type !== 'condition' && n.type !== 'menu' && n.type !== 'agent' && n.type !== 'end') {
      body.append(h('h4', { class: 'sub', text: 'Connections' }));
      const bulkTitles = { done: 'After updating, go to', cancelled: 'If the user cancels, go to' };
      ports(n).forEach((p) => body.append(F(n.type === 'summary' ? 'After confirm, go to'
        : n.type === 'repeat' ? 'When the list is done, go to'
        : n.type === 'bulkUpdate' && bulkTitles[p.key] ? bulkTitles[p.key] : PORT_TITLES[p.key], targetSelect(n, p.key),
        p.key === 'onNotFound' ? (n.type === 'rest' ? 'Optional. Used when the API answers 404 (not found); without it a 404 is an error.'
          : 'Optional. Used when the connector returns found: false.') :
        p.key === 'onError' ? (n.type === 'email' || n.type === 'teams' ? 'Optional. Without it the flow shows the error and carries on to the next step.'
          : n.type === 'rest' ? 'Optional. Used for any other status, a timeout or a refused call. Without it the conversation ends as failed.'
          : n.type === 'workflow' ? 'Optional. Used when the workflow can\'t start (unknown static ID, a missing required parameter, an error raised by the workflow). Without it the conversation ends as failed.'
          : 'Optional. Without it a failed submit ends the conversation.') : PORT_HINTS[p.key] || null)));
    }
    const probs = analyze().list.filter((x) => x.nodeId === n.id);
    if (probs.length) {
      body.append(h('h4', { class: 'sub', text: 'Problems' }));
      probs.forEach((p) => body.append(h('div', { class: 'prob ' + p.level }, p.msg)));
    }
    body.append(h('div', { class: 'actions' },
      S.flow.start === n.id ? null : h('button', { class: 'btn', text: 'Set as start', onclick: () => mutate((f) => { f.start = n.id; }, { panel: true }) }),
      h('button', { class: 'btn', text: 'Duplicate', onclick: () => duplicate(n) }),
      h('button', { class: 'btn danger', text: 'Delete', onclick: deleteSelection })));
  }

  function duplicate(n) {
    const c = clone(n);
    c.id = uniqueId(n.type);
    ports(c).forEach((p) => setPort(c, p.key, null));
    if (c.type === 'ask') c.slot = uniqueSlot(n.slot || 'field');
    c.ui = { x: n.ui.x + 40, y: n.ui.y + 40 };
    mutate((f) => f.nodes.push(c));
    select({ kind: 'node', id: c.id });
  }

  function idField(n) {
    const inp = h('input', { class: 'in mono', value: n.id });
    inp.addEventListener('change', () => {
      const v = inp.value.trim();
      if (v === n.id) return;
      if (!/^[A-Za-z0-9_]{1,200}$/.test(v)) { toast('Ids can only use letters, digits and _.'); inp.value = n.id; return; }
      if (byId(v)) { toast('Another node already uses "' + v + '".'); inp.value = n.id; return; }
      const old = n.id;
      S.sel = { kind: 'node', id: v };
      mutate(() => renameNode(old, v), { panel: true });
    });
    return F('Node id', inp, 'Used in connections and logs. Renaming updates every reference.');
  }

  function textEditor(n) {
    const ta = bound(() => n.text, (v) => setOrDelete(n, 'text', v), { multiline: true, key: n.id + '.text', rows: 4 });
    return h('div', null, F(n.type === 'end' ? 'Closing message' : 'Message', ta), slotChips(ta),
      n.type === 'end' ? h('p', { class: 'hint', text: 'Ends the conversation with status "completed".' }) : null);
  }

  function askEditor(n) {
    const spec = n.input || { kind: 'text' };
    const kind = spec.kind || 'text';
    const setIn = (k, v) => { n.input = n.input || { kind: 'text' }; setOrDelete(n.input, k, v); };
    const wrap = h('div');

    const slotIn = h('input', { class: 'in mono', value: n.slot || '' });
    slotIn.addEventListener('change', () => {
      const v = slotIn.value.trim();
      if (v === n.slot) return;
      if (!/^[a-z][a-z0-9_]{0,99}$/.test(v)) { toast('Field names: lowercase letters, digits and _, starting with a letter.'); slotIn.value = n.slot || ''; return; }
      const old = n.slot;
      mutate(() => { if (old && askSlots().filter((s) => s === old).length) renameSlot(old, v); n.slot = v; }, { panel: true });
    });
    wrap.append(h('div', { class: 'grid2' },
      F('Field (slot)', slotIn),
      F('Label', bound(() => n.label, (v) => setOrDelete(n, 'label', v), { key: n.id + '.label' }))));
    const prompt = bound(() => n.prompt, (v) => setOrDelete(n, 'prompt', v), { multiline: true, key: n.id + '.prompt' });
    wrap.append(F('Question', prompt), slotChips(prompt));
    wrap.append(noteEditor(n, n.id));

    wrap.append(answerEditor(n, n.id, { file: true }));

    wrap.append(validatorsEditor(n));
    wrap.append(bindingEditor(n.slot));

    const adv = h('details', { class: 'adv' }, h('summary', { text: 'Advanced: messages & behaviour' }),
      checkbox('Skip if already filled (e.g. by a lookup or page context)', n.skipIfFilled, (c) => mutate(() => setOrDelete(n, 'skipIfFilled', c || null))),
      checkbox('Show in the summary', n.inSummary !== false, (c) => mutate(() => { if (c) delete n.inSummary; else n.inSummary = false; })),
      F('Required message', bound(() => spec.requiredMessage, (v) => setIn('requiredMessage', v), { key: n.id + '.rm', placeholder: 'This one is required…' })),
      F('Unrecognised answer message', bound(() => spec.parseMessage, (v) => setIn('parseMessage', v), { key: n.id + '.pm' })),
      h('div', { class: 'grid2' },
        F('Too small / short message', bound(() => spec.minMessage, (v) => setIn('minMessage', v), { key: n.id + '.minm' })),
        F('Too large / long message', bound(() => spec.maxMessage, (v) => setIn('maxMessage', v), { key: n.id + '.maxm' }))));
    wrap.append(adv);
    return wrap;
  }

  // Information note shown with the question while the user answers it (Ask, Menu, list and record fields).
  const NOTE_STYLES = [['info', 'Information'], ['tip', 'Tip'], ['warning', 'Warning']];
  function noteEditor(o, kp) {
    const ta = bound(() => o.note, (v) => setOrDelete(o, 'note', v),
      { multiline: true, rows: 2, key: kp + '.note', placeholder: '(optional) e.g. Use the name exactly as it appears on your passport.' });
    return h('div', null,
      F('Note', ta, 'Shown in a box above the answer while this question is open. {{field}} placeholders work; leave empty for none.'),
      h('div', { class: 'grid2' },
        F('Note style', sel(NOTE_STYLES, o.noteStyle || 'info', (v) => mutate(() => setOrDelete(o, 'noteStyle', v === 'info' ? null : v)))),
        h('span')));
  }

  // Answer type + constraints for anything with an .input spec (Ask nodes, Change-fields fields).
  function answerEditor(o, kp, opts) {
    opts = opts || {};
    const spec = o.input || { kind: 'text' };
    const kind = spec.kind || 'text';
    const setIn = (k, v) => { o.input = o.input || { kind: 'text' }; setOrDelete(o.input, k, v); };
    const box = h('div');
    const kinds = opts.file ? KINDS.concat([['file', 'File upload']]) : KINDS;
    box.append(h('h4', { class: 'sub', text: 'Answer' }));
    box.append(h('div', { class: 'grid2' },
      F('Type', sel(kinds, kind, (v) => mutate(() => {
        o.input = { kind: v, required: spec.required, placeholder: spec.placeholder };
        Object.keys(o.input).forEach((k) => o.input[k] === undefined && delete o.input[k]);
        if (v === 'choice') o.input.options = spec.options || [{ value: 'A', label: 'Option A' }, { value: 'B', label: 'Option B' }];
      }, { panel: true }))),
      kind === 'choice' || kind === 'yesno' || kind === 'date' ? h('span') :
        F('Placeholder', bound(() => spec.placeholder, (v) => setIn('placeholder', v), { key: kp + '.ph' }))));
    box.append(checkbox('Required', spec.required !== false, (c) => mutate(() => setIn('required', c ? null : false))));

    if (kind === 'number') {
      box.append(h('div', { class: 'grid2' },
        F('Minimum', bound(() => spec.min, (v) => setIn('min', numOrNull(v)), { type: 'number', key: kp + '.min' })),
        F('Maximum', bound(() => spec.max, (v) => setIn('max', numOrNull(v)), { type: 'number', key: kp + '.max' }))),
        F('Display prefix', bound(() => spec.prefix, (v) => setIn('prefix', v), { key: kp + '.prefix', placeholder: 'e.g. $' }),
          'Shown in the summary. Users can type 25k, $1,250 etc.'));
    } else if (kind === 'date') {
      box.append(h('div', { class: 'grid2' },
        F('Earliest', bound(() => spec.minDate, (v) => setIn('minDate', v), { key: kp + '.mind', placeholder: 'today / 2026-01-01' })),
        F('Latest', bound(() => spec.maxDate, (v) => setIn('maxDate', v), { key: kp + '.maxd', placeholder: 'YYYY-MM-DD' }))));
    } else if (kind === 'text' || kind === 'email') {
      box.append(h('div', { class: 'grid2' },
        F('Min length', bound(() => spec.minLength, (v) => setIn('minLength', numOrNull(v)), { type: 'number', key: kp + '.minl' })),
        F('Max length', bound(() => spec.maxLength, (v) => setIn('maxLength', numOrNull(v)), { type: 'number', key: kp + '.maxl' }))));
    } else if (kind === 'choice') {
      box.append(choiceEditor(o, kp));
    } else if (kind === 'file') {
      const acc = Array.isArray(spec.accept) ? spec.accept.join(', ') : spec.accept;
      box.append(h('div', { class: 'grid2' },
        F('Accepted types', bound(() => acc, (v) => setIn('accept', v.split(',').map((x) => x.trim()).filter(Boolean).length
          ? v.split(',').map((x) => x.trim()).filter(Boolean) : ''), { key: kp + '.acc', placeholder: '.pdf, image/*' }),
          'Extensions or MIME types, checked in the browser and again on the server.'),
        F('Max size (KB)', bound(() => spec.maxSizeKb, (v) => setIn('maxSizeKb', numOrNull(v)), { type: 'number', key: kp + '.msz', placeholder: '5120' }),
          'Up to 20480 KB.')),
        h('p', { class: 'hint', text: 'The file goes to FC_FILES (in the Test tab: memory). The answer holds {id, name, size, mimeType}; your Submit connector reads the content by id.' }));
    }
    const typed = ['text', 'email', 'number'].indexOf(kind) >= 0;
    const rd = o.redact === true ? 'full' : (o.redact || '');
    if (typed || rd) {
      box.append(F('On screen', sel([['', 'Show as typed'], ['full', 'Hide it'], ['last4', 'Hide it, show the last 4 in the chat']], rd,
        (v) => mutate(() => { setOrDelete(o, 'redact', v); if (!v) delete o.allowReveal; }, { panel: true })),
        'Hidden answers are typed into a masked box and shown masked in the chat, in later messages and on the summary. Connectors and the save still get the real value.'));
      if (rd) box.append(checkbox('Let the user reveal what they typed', o.allowReveal !== false,
        (c) => mutate(() => { if (c) delete o.allowReveal; else o.allowReveal = false; })));
    }
    if (rd) {
      box.append(F('In logs', h('span', { class: 'hint', text: rd === 'last4' && !o.pii ? 'Only the last 4 characters (hidden answers are always masked in logs).' : 'Masked (hidden answers are always masked in logs).' })));
    } else {
      box.append(F('In logs', sel([['', 'Show the value'], ['true', 'Redact it (PII)'], ['last4', 'Show only the last 4 characters']],
        o.pii === true ? 'true' : (o.pii || ''), (v) => mutate(() => setOrDelete(o, 'pii', v === 'true' ? true : v), { panel: true })),
        'PII values are masked in FC_EVENTS and debug logs. To hide the value in the chat too, use On screen.'));
    }
    return box;
  }

  // Where a choice's options come from: a fixed list, or a lookup list (FC_LOVS) with parameters.
  function choiceEditor(o, kp) {
    const spec = o.input;
    const fromList = 'optionsFrom' in spec;
    const wrap = h('div');
    wrap.append(h('div', { class: 'grid2' },
      F('Options come from', sel([['fixed', 'A fixed list'], ['lov', 'A lookup list (database)']], fromList ? 'lov' : 'fixed', (v) => mutate(() => {
        if (v === 'lov') { o.input.optionsFrom = ''; delete o.input.options; }
        else {
          delete o.input.optionsFrom; delete o.input.optionsParams; delete o.input.staleMessage; delete o.input.emptyMessage;
          o.input.options = [{ value: 'A', label: 'Option A' }, { value: 'B', label: 'Option B' }];
        }
      }, { panel: true }))),
      F('Show as', sel([['auto', 'Automatic'], ['buttons', 'Buttons'], ['list', 'Searchable list']], spec.display || 'auto',
        (v) => mutate(() => { if (v === 'auto') delete o.input.display; else o.input.display = v; })),
        'Automatic: buttons for up to 8 options, a searchable list above that.')));
    if (!fromList) { wrap.append(optionsEditor(o, kp)); return wrap; }

    const reg = dbLov(spec.optionsFrom);
    const hint = !spec.optionsFrom ? 'The id of a list registered in FC_LOVS on the server.'
      : reg ? (reg.description ? reg.description + ' · ' : '') + (reg.type === 'SQL' ? reg.query : 'PL/SQL ' + reg.target)
      : BACKEND && S.dbLovs ? 'Not registered in FC_LOVS on the server.'
      : 'Registered in FC_LOVS on the server. In the Test tab you can set test options for it.';
    wrap.append(F('Lookup list', lovInput(() => spec.optionsFrom, (v) => { o.input.optionsFrom = v.trim(); }, kp + '.lov'), hint));

    const params = spec.optionsParams || {};
    const names = Object.keys(params);
    ((reg && reg.params) || []).forEach((p) => { if (names.indexOf(p) < 0) names.push(p); });
    const slots = knownSlots();
    const setParam = (p, v) => {
      o.input.optionsParams = o.input.optionsParams || {};
      o.input.optionsParams[p] = v;
    };
    const card = h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('span', { class: 'grow', text: 'Parameters' }),
      h('span', { class: 'hint', text: 'earlier answers, bound as :NAME' })));
    if (!names.length) card.append(h('p', { class: 'hint', style: 'margin:0 0 6px', text: 'None. Add one when the list depends on an earlier answer (for example the country).' }));
    names.forEach((p) => {
      const opts = [['', '— choose an answer —']].concat(slots.map((x) => [x, x]));
      if (params[p] && slots.indexOf(params[p]) < 0) opts.push([params[p], params[p] + ' (unknown)']);
      card.append(h('div', { class: 'rowx' },
        h('span', { class: 'mono', style: 'min-width:90px', text: ':' + p.toUpperCase() }),
        sel(opts, params[p] || '', (v) => mutate(() => setParam(p, v), { panel: true }), { mono: true }),
        h('button', { class: 'x', title: 'Remove', text: '×', onclick: () => mutate(() => {
          if (!o.input.optionsParams) return;
          delete o.input.optionsParams[p];
          if (!Object.keys(o.input.optionsParams).length) delete o.input.optionsParams;
        }, { panel: true }) })));
    });
    const nameIn = h('input', { class: 'in mono', placeholder: 'parameter_name' });
    card.append(h('div', { class: 'rowx' }, nameIn, h('button', { class: 'lnk', text: '+ Add parameter', onclick: () => {
      const v = nameIn.value.trim().toLowerCase();
      if (!/^[a-z][a-z0-9_]{0,29}$/.test(v)) { toast('Use lowercase letters, digits and _ (up to 30), starting with a letter.'); return; }
      mutate(() => setParam(v, (o.input.optionsParams || {})[v] || ''), { panel: true });
    } })));
    wrap.append(card);
    wrap.append(h('div', { class: 'grid2' },
      F('If an earlier answer changed', bound(() => spec.staleMessage, (v) => setOrDelete(o.input, 'staleMessage', v),
        { key: kp + '.stale', placeholder: 'Your earlier answer is no longer one of the options. Please choose again.' })),
      F('If the list is empty', bound(() => spec.emptyMessage, (v) => setOrDelete(o.input, 'emptyMessage', v),
        { key: kp + '.empty', placeholder: "There's nothing to choose from here right now." }))));
    return wrap;
  }

  // Re-reads FC_LOVS (lists inserted after the designer loaded). Quiet unless opts.toast.
  let lovReloadAt = 0, lovError = null;
  async function reloadLovs(opts) {
    if (!BACKEND) return;
    lovReloadAt = Date.now();
    try { S.dbLovs = (await BACKEND.call('listLovs')) || []; lovError = null; } catch (e) {
      lovError = e.message;
      if (opts && opts.toast) toast('Could not read FC_LOVS: ' + e.message, 7000);
      return;
    }
    if (!(opts && opts.quiet)) renderProps();
    renderCheck();
    if (S.tab === 'test') renderMocks();
    if (opts && opts.toast) toast(S.dbLovs.length + ' lookup list(s) in FC_LOVS (enabled ones only).');
  }

  function lovInput(get, set, key) {
    if (BACKEND && S.dbLovs) {
      // Database mode: pick from the lists registered in FC_LOVS (a datalist would hide every entry
      // that doesn't match the text already in the box).
      const cur = get() || '';
      const opts = [['', '— choose a list —']];
      S.dbLovs.forEach((l) => opts.push([l.id, l.id + (l.description ? ' — ' + l.description : '')]));
      if (cur && !dbLov(cur)) opts.push([cur, cur + ' (not in FC_LOVS)']);
      const el = sel(opts, cur, (v) => mutate(() => set(v), { panel: true }), { mono: true });
      el.classList.add('grow');
      return h('div', { class: 'rowx' }, el,
        h('button', { class: 'x', title: 'Reload lists from FC_LOVS', text: '↻', onclick: () => reloadLovs({ toast: true }) }));
    }
    const listId = 'fcd-lovlist';
    let dl = document.getElementById(listId);
    if (!dl) { dl = h('datalist', { id: listId }); ROOT.append(dl); }
    dl.textContent = '';
    const ids = Object.keys(lovUses());
    (S.dbLovs || []).forEach((l) => { if (ids.indexOf(l.id) < 0) ids.push(l.id); });
    if (!BACKEND) Object.keys(DEFAULT_LOV_ROWS).forEach((l) => { if (ids.indexOf(l) < 0) ids.push(l); });
    ids.forEach((id) => {
      const reg = dbLov(id);
      dl.append(h('option', { value: id, label: reg ? (reg.description || reg.type) : DEFAULT_LOV_ROWS[id] ? 'sample list' : 'used in this flow' }));
    });
    const el = bound(get, set, { mono: true, key, placeholder: 'list_id', panel: false });
    el.setAttribute('list', listId);
    el.addEventListener('change', () => renderProps());
    return el;
  }

  function optionsEditor(n, keyPrefix) {
    const kp = keyPrefix || n.id;
    const opts = (n.input && n.input.options) || [];
    const box = h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('span', { class: 'grow', text: 'Options' }),
      h('span', { class: 'hint', text: 'value · label' })));
    opts.forEach((o, i) => {
      box.append(h('div', { class: 'rowx' },
        bound(() => o.value, (v) => { o.value = v; }, { mono: true, key: kp + '.ov' + i, placeholder: 'VALUE' }),
        bound(() => o.label, (v) => setOrDelete(o, 'label', v), { key: kp + '.ol' + i, placeholder: 'Label shown' }),
        h('button', { class: 'x', title: 'Up', text: '↑', disabled: i === 0, onclick: () => mutate(() => { opts.splice(i - 1, 0, opts.splice(i, 1)[0]); }, { panel: true }) }),
        h('button', { class: 'x', title: 'Remove', text: '×', onclick: () => mutate(() => opts.splice(i, 1), { panel: true }) })));
    });
    box.append(h('button', { class: 'lnk', text: '+ Add option', onclick: () => mutate(() => {
      n.input.options = opts; opts.push({ value: 'OPT' + (opts.length + 1), label: 'Option ' + (opts.length + 1) });
    }, { panel: true }) }));
    return box;
  }

  function validatorsEditor(n, keyPrefix) {
    const kp = keyPrefix || n.id;
    const vals = n.validators || [];
    const box = h('div', null, h('h4', { class: 'sub', text: 'Extra checks' }));
    vals.forEach((v, i) => {
      const card = h('div', { class: 'card' }, h('div', { class: 'card-h' },
        h('span', { class: 'grow', text: v.type === 'regex' ? 'Pattern (regex)' : 'Server check (connector)' }),
        h('button', { class: 'x', text: '×', title: 'Remove', onclick: () => mutate(() => { vals.splice(i, 1); if (!vals.length) delete n.validators; }, { panel: true }) })));
      if (v.type === 'regex') {
        card.append(F(null, bound(() => v.pattern, (x) => { v.pattern = x; }, { mono: true, key: kp + '.vp' + i, placeholder: '^[0-9]{5}$' }),
          'Must work in both JavaScript and Oracle: avoid lookaheads.'));
      } else {
        card.append(F(null, connectorInput(() => v.connector, (x) => { v.connector = x; }, kp + '.vc' + i),
          'Connector returns {"valid": true|false, "message": "…"}.'));
      }
      card.append(F('Error message', bound(() => v.message, (x) => setOrDelete(v, 'message', x), { key: kp + '.vm' + i,
        placeholder: v.type === 'server' ? '(uses the connector message)' : "That value isn't in the expected format." })));
      box.append(card);
    });
    box.append(h('div', { class: 'rowx' },
      h('button', { class: 'lnk', text: '+ Pattern', onclick: () => mutate(() => { n.validators = vals; vals.push({ type: 'regex', pattern: '' }); }, { panel: true }) }),
      h('span', { class: 'hint', text: '·' }),
      h('button', { class: 'lnk', text: '+ Server check', onclick: () => mutate(() => { n.validators = vals; vals.push({ type: 'server', connector: '' }); }, { panel: true }) })));
    return box;
  }

  function connectorInput(get, set, key) {
    const listId = 'fcd-connlist';
    let dl = document.getElementById(listId);
    if (!dl) { dl = h('datalist', { id: listId }); ROOT.append(dl); }
    dl.textContent = '';
    const ids = Object.keys(connectorUses());
    (S.dbConnectors || []).forEach((c) => { if (ids.indexOf(c.id) < 0) ids.push(c.id); });
    ids.forEach((c) => {
      const reg = (S.dbConnectors || []).find((x) => x.id === c);
      dl.append(h('option', { value: c, label: reg ? reg.type + (reg.description ? ' · ' + reg.description : '') : 'used in this flow' }));
    });
    const el = bound(get, set, { mono: true, key, placeholder: 'connector_id' });
    el.setAttribute('list', listId);
    return el;
  }

  function bindingEditor(slot) {
    if (!slot) return h('span');
    const b = (S.flow.bindings || {})[slot] || {};
    const upd = (k, v) => {
      const f = S.flow;
      f.bindings = f.bindings || {};
      const cur = f.bindings[slot] = f.bindings[slot] || {};
      setOrDelete(cur, k, v);
      if (!Object.keys(cur).length) delete f.bindings[slot];
    };
    return h('div', null, h('h4', { class: 'sub', text: 'Form binding' }),
      h('div', { class: 'grid2' },
        F('APEX item', bound(() => b.apex, (v) => upd('apex', v.trim().toUpperCase()), { mono: true, key: 'bind.apex.' + slot, placeholder: 'P10_FIELD', onChange: true })),
        F('DOM selector', bound(() => b.dom, (v) => upd('dom', v.trim()), { mono: true, key: 'bind.dom.' + slot, placeholder: '#field' }))),
      checkbox('Required on the form (warn if some paths skip it)', b.required, (c) => mutate(() => upd('required', c || null))));
  }

  // ---- conditions
  function parseWhen(w) {
    if (!w) return { comb: 'all', rows: [{ slot: '', op: '=', value: '' }] };
    const simple = (c) => c && !c.all && !c.any && !c.not;
    if (simple(w)) return { comb: 'all', rows: [clone(w)] };
    const arr = w.all || w.any;
    if (arr && arr.every(simple)) return { comb: w.all ? 'all' : 'any', rows: clone(arr) };
    return null;
  }
  function numify(v) { return typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v; }
  function writeWhen(b, comb, rows) {
    const clean = rows.map((r) => {
      const o = { slot: r.slot, op: r.op };
      if (r.op === 'in') o.value = (Array.isArray(r.value) ? r.value : String(r.value || '').split(',')).map((x) => numify(String(x).trim())).filter((x) => x !== '');
      else if (r.op !== 'empty' && r.op !== 'notEmpty') o.value = numify(r.value === undefined ? '' : r.value);
      return o;
    });
    b.when = clean.length === 1 ? clean[0] : { [comb]: clean };
  }

  function condEditor(n) {
    const wrap = h('div');
    const slots = knownSlots().filter((s) => s !== BUILTIN_USER).concat([BUILTIN_USER]);
    (n.branches || []).forEach((b, i) => {
      const card = h('div', { class: 'card' });
      const parsed = parseWhen(b.when);
      card.append(h('div', { class: 'card-h' }, h('span', { class: 'grow', text: 'Branch ' + (i + 1) }),
        h('button', { class: 'x', text: '↑', title: 'Move up', disabled: i === 0, onclick: () => mutate(() => { n.branches.splice(i - 1, 0, n.branches.splice(i, 1)[0]); }, { panel: true }) }),
        h('button', { class: 'x', text: '×', title: 'Remove branch', onclick: () => mutate(() => n.branches.splice(i, 1), { panel: true }) })));
      if (!parsed) {
        const ta = h('textarea', { class: 'in mono', rows: 4 });
        ta.value = JSON.stringify(b.when, null, 1);
        ta.addEventListener('change', () => { try { const w = JSON.parse(ta.value); mutate(() => { b.when = w; }, { panel: true }); } catch (e) { ta.classList.add('bad'); toast('Not valid JSON'); } });
        card.append(F('Condition (advanced JSON)', ta));
      } else {
        const { rows } = parsed;
        let comb = parsed.comb;
        if (rows.length > 1) {
          card.append(F(null, sel([['all', 'All of these are true'], ['any', 'Any of these is true']], comb, (v) => { comb = v; mutate(() => writeWhen(b, comb, rows)); })));
        }
        rows.forEach((r, k) => {
          const slotOpts = [['', 'field…']].concat(slots.map((s) => [s, s]));
          if (r.slot && slots.indexOf(r.slot) < 0) slotOpts.push([r.slot, r.slot + ' (unknown)']);
          const valIn = h('input', { class: 'in', placeholder: r.op === 'in' ? 'A, B, C' : 'value' });
          valIn.value = Array.isArray(r.value) ? r.value.join(', ') : (r.value === undefined ? '' : r.value);
          valIn.hidden = r.op === 'empty' || r.op === 'notEmpty';
          valIn.addEventListener('input', () => { r.value = valIn.value; mutate(() => writeWhen(b, comb, rows), { key: n.id + '.cv' + i + '.' + k }); });
          card.append(h('div', { class: 'rowx' },
            sel(slotOpts, r.slot, (v) => { r.slot = v; mutate(() => writeWhen(b, comb, rows)); }, { mono: true }),
            sel(OPS, r.op || '=', (v) => { r.op = v; mutate(() => writeWhen(b, comb, rows), { panel: true }); }),
            valIn,
            rows.length > 1 ? h('button', { class: 'x', text: '×', title: 'Remove', onclick: () => { rows.splice(k, 1); mutate(() => writeWhen(b, comb, rows), { panel: true }); } }) : null));
        });
        card.append(h('button', { class: 'lnk', text: '+ Another condition', onclick: () => { rows.push({ slot: '', op: '=', value: '' }); mutate(() => writeWhen(b, comb, rows), { panel: true }); } }));
      }
      card.append(F('Then go to', targetSelect(n, 'branch:' + i)));
      wrap.append(card);
    });
    wrap.append(h('button', { class: 'btn', text: '+ Add branch', onclick: () => mutate(() => {
      n.branches = n.branches || [];
      n.branches.push({ when: { slot: '', op: '=', value: '' } });
    }, { panel: true }) }));
    wrap.append(h('div', { style: 'height:12px' }), F('Otherwise go to', targetSelect(n, 'else'), 'Used when no branch matches. Branches are checked top to bottom.'));
    return wrap;
  }

  function connEditor(n) {
    const isLookup = n.type === 'lookup';
    return h('div', null,
      F('Connector id', connectorInput(() => n.connector, (v) => setOrDelete(n, 'connector', v.trim()), n.id + '.conn'),
        'Registered in FC_CONNECTORS (a PL/SQL function or REST URL). The browser only ever sends this id.'),
      h('div', { class: 'card' }, h('div', { class: 'hint', style: 'margin:0' },
        isLookup
          ? 'Receives every captured answer. Returns {"found": true|false, "slots": {…}, "message": "…"}. Returned slots are filled in and mirrored to bound form fields.'
          : 'Re-validates every answer first, then calls the connector. Returns {"ok": true|false, "slots": {…}, "message": "…"}.'),
        h('button', { class: 'lnk', text: 'Edit the test mock →', onclick: () => setTab('test') })));
  }

  function summaryEditor(n) {
    const ta = bound(() => n.text, (v) => setOrDelete(n, 'text', v), { multiline: true, key: n.id + '.text' });
    const modeSel = F('Shows', sel([['answers', 'All answers (create flows)'], ['changes', 'Changes to a record: old → new (update flows)']],
      n.mode || 'answers', (v) => mutate(() => { if (v === 'changes') { n.mode = 'changes'; delete n.fields; } else { delete n.mode; delete n.record; } }, { panel: true })));
    if (n.mode === 'changes') {
      return h('div', null, modeSel, F('Record', recordSelect(n, 'record')),
        F('Intro text', ta, 'Default: "Please confirm these changes:"'), slotChips(ta),
        F('Confirm button label', bound(() => n.confirmLabel, (v) => setOrDelete(n, 'confirmLabel', v), { key: n.id + '.cl', placeholder: 'Save changes' })));
    }
    const fields = n.fields || [];
    const box = h('div', { class: 'card' }, h('div', { class: 'card-h', text: 'Fields to show' }));
    askSlots().forEach((s) => box.append(checkbox(s, fields.indexOf(s) >= 0, (c) => mutate(() => {
      const cur = (n.fields || []).filter((x) => x !== s);
      if (c) cur.push(s);
      if (cur.length) n.fields = askSlots().filter((x) => cur.indexOf(x) >= 0); else delete n.fields;
    }))));
    box.append(h('div', { class: 'hint', text: 'Nothing ticked = every answered question, in flow order.' }));
    return h('div', null, modeSel, F('Intro text', ta), slotChips(ta),
      F('Confirm button label', bound(() => n.confirmLabel, (v) => setOrDelete(n, 'confirmLabel', v), { key: n.id + '.cl', placeholder: 'Confirm & submit' })),
      box);
  }

  // ---- data nodes ---------------------------------------------------------------------------
  // Rename a record alias everywhere: findRecord.as, record refs, alias.field placeholders,
  // conditions and bindings.
  function renameAlias(oldA, newA) {
    const f = S.flow, pre = oldA + '.';
    const re = new RegExp('\\{\\{\\s*' + oldA + '\\.', 'g');
    const fixText = (t) => (typeof t === 'string' ? t.replace(re, '{{' + newA + '.') : t);
    const fixCond = (c) => {
      if (!c) return;
      if (c.slot && c.slot.indexOf(pre) === 0) c.slot = newA + '.' + c.slot.slice(pre.length);
      (c.all || c.any || []).forEach(fixCond);
      if (c.not) fixCond(c.not);
    };
    f.nodes.forEach((n) => {
      if (n.type === 'findRecord' && n.as === oldA) n.as = newA;
      if (n.record === oldA) n.record = newA;
      ['text', 'prompt', 'note', 'cardTitle', 'againPrompt'].forEach((k) => { n[k] = fixText(n[k]); });
      (n.fields || []).forEach((fd) => { if (fd && fd.note) fd.note = fixText(fd.note); });
      if (n.prompts) Object.keys(n.prompts).forEach((k) => { n.prompts[k] = fixText(n.prompts[k]); });
      (n.branches || []).forEach((b) => fixCond(b.when));
      if (n.type === 'changeFields') (n.fields || []).forEach((fd) => { fixCond(fd.editableWhen); fd.prompt = fixText(fd.prompt); });
    });
    Object.keys(f.bindings || {}).forEach((k) => {
      if (k.indexOf(pre) === 0) { f.bindings[newA + '.' + k.slice(pre.length)] = f.bindings[k]; delete f.bindings[k]; }
    });
  }

  function humanize(field) { return String(field || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()); }

  // {{field}} insert chips for result-card templates (raw source field names).
  function fieldChips(src, target) {
    if (!src || !(src.fields || []).length) return null;
    return h('div', { class: 'chips-ins', title: 'Insert a field of the data source' },
      src.fields.map((f) => h('button', {
        type: 'button', text: '{{' + f.field + '}}' + (f.mask ? ' •' : ''),
        onclick: () => {
          const pos = target.selectionStart != null ? target.selectionStart : target.value.length;
          target.value = target.value.slice(0, pos) + '{{' + f.field + '}}' + target.value.slice(target.selectionEnd || pos);
          target.dispatchEvent(new Event('input'));
          target.focus();
        }
      })));
  }

  function aliasInput(n) {
    const inp = h('input', { class: 'in mono', value: n.as || '', placeholder: 'app' });
    inp.addEventListener('change', () => {
      const v = inp.value.trim();
      if (v === n.as) return;
      if (!/^[a-z][a-z0-9_]{0,49}$/.test(v)) { toast('Alias: lowercase letters, digits and _, starting with a letter.'); inp.value = n.as || ''; return; }
      if (aliases().indexOf(v) >= 0) { toast('Another Find record already uses "' + v + '".'); inp.value = n.as || ''; return; }
      const old = n.as;
      mutate(() => { if (old) renameAlias(old, v); else n.as = v; }, { panel: true });
    });
    return inp;
  }

  function recordSelect(n, key) {
    const als = aliases();
    const opts = [['', '— choose a record —']].concat(als.map((a) => [a, a + '  (' + (sourceForAlias(a) || '?') + ')']));
    if (n[key] && als.indexOf(n[key]) < 0) opts.push([n[key], n[key] + ' (not loaded by any Find record)']);
    return sel(opts, n[key] || '', (v) => mutate(() => setOrDelete(n, key, v), { panel: true }), { mono: true });
  }

  function findEditor(n) {
    const wrap = h('div');
    const ids = Object.keys(catalog());
    const srcOpts = [['', '— choose a data source —']].concat(ids.map((s) => [s, s]));
    if (n.source && ids.indexOf(n.source) < 0) srcOpts.push([n.source, n.source + ' (not in catalog)']);
    const src = sourceDef(n.source);
    wrap.append(h('div', { class: 'grid2' },
      F('Data source', sel(srcOpts, n.source || '', (v) => mutate(() => setOrDelete(n, 'source', v), { panel: true }), { mono: true })),
      F('Record alias', aliasInput(n))));
    const vs = verifiedSlots();
    if (vs.length || n.requireVerified) {
      const vOpts = [['', 'No (signed-in pages only)']].concat(vs.map((s) => [s, 'Yes: "' + s + '" must be verified']));
      if (n.requireVerified && vs.indexOf(n.requireVerified) < 0) vOpts.push([n.requireVerified, n.requireVerified + ' (no Verify step)']);
      wrap.append(F('Require a verified identity', sel(vOpts, n.requireVerified || '', (v) => mutate(() => setOrDelete(n, 'requireVerified', v), { panel: true })),
        'The search is refused unless this answer passed a Verify step with its current value.'));
    }
    wrap.append(h('p', { class: 'hint' }, 'Loaded fields are available as ', h('code', { text: '{{' + (n.as || 'alias') + '.field}}' }),
      ' and in conditions. ', h('button', { class: 'lnk', text: 'Manage data sources →', onclick: () => setTab('data') })));

    // which records: criteria, or the source's row filter alone (e.g. the signed-in user\'s records)
    wrap.append(h('h4', { class: 'sub', text: 'Which records' }));
    wrap.append(F('Find', sel([['criteria', 'Records matching search criteria'], ['mine', 'The signed-in user\'s records (row filter only)']],
      n.byRowFilter ? 'mine' : 'criteria', (v) => mutate(() => {
        if (v === 'mine') { n.byRowFilter = true; delete n.criteria; delete n.minCriteria; }
        else { delete n.byRowFilter; n.criteria = n.criteria || []; }
      }, { panel: true }))));
    if (n.byRowFilter) {
      const rf = String((src && src.rowFilter) || '').trim();
      wrap.append(h('p', { class: 'hint' + (src && !rf && src.sourceType !== 'PLSQL' ? ' warn' : '') },
        !src ? 'Choose a data source. Its row filter decides which records are found; no questions are asked.'
          : src.sourceType === 'PLSQL' ? 'PL/SQL source: its search function is called with no criteria and must return only the user\'s records.'
          : rf ? h('span', null, 'No questions are asked. Found: the rows of ' + n.source + ' where ', h('code', { text: rf }),
                 '. :APP_USER is the signed-in APEX user, bound by the database.')
          : 'This data source has no row filter yet, so it can\'t be used this way. Add one in the Data tab, e.g. upper(t.username) = upper(:APP_USER).'));
      if (src && rf) wrap.append(h('p', { class: 'hint', text: 'In the Test tab the sample rows stand in for the user\'s rows.' }));
    }
    const crit = n.criteria || [];
    const searchable = src ? src.fields.filter((f) => f.searchable) : [];
    const asks = askSlots();
    const values = critValues(n);
    if (!n.byRowFilter) wrap.append(h('h4', { class: 'sub', text: 'Search criteria' }));
    if (!n.byRowFilter && src && !searchable.length) wrap.append(h('p', { class: 'hint', text: 'No field of ' + n.source + ' is searchable. Mark some in the Data tab.' }));
    if (!n.byRowFilter) crit.forEach((c, i) => {
      const fOpts = [['', 'field…']].concat((src ? searchable : []).map((f) => [f.field, f.field]));
      if (c.field && !fOpts.some((o) => o[0] === c.field)) fOpts.push([c.field, c.field + (src ? ' (not searchable)' : '')]);
      const sf = sourceField(n.source, c.field);
      const allowed = sf ? String(sf.ops || 'eq').split(',').map((s) => s.trim()) : SEARCH_OPS.map((o) => o[0]);
      const opOpts = SEARCH_OPS.filter((o) => allowed.indexOf(o[0]) >= 0 || o[0] === (c.op || 'eq'));
      const slotOpts = [['', 'value…']].concat(values.map((s) => [s, s]));
      if (c.slot && values.indexOf(c.slot) < 0) slotOpts.push([c.slot, c.slot + ' (not set by this flow)']);
      wrap.append(h('div', { class: 'card' },
        h('div', { class: 'rowx' },
          sel(fOpts, c.field || '', (v) => mutate(() => { c.field = v; }, { panel: true }), { mono: true }),
          sel(opOpts, c.op || 'eq', (v) => mutate(() => { if (v === 'eq') delete c.op; else c.op = v; })),
          sel(slotOpts, c.slot || '', (v) => mutate(() => { c.slot = v; }), { mono: true }),
          h('button', { class: 'x', text: '×', title: 'Remove', onclick: () => mutate(() => crit.splice(i, 1), { panel: true }) })),
        checkbox('Optional: skip it when the value is empty', c.optional, (ch) => mutate(() => setOrDelete(c, 'optional', ch || null)))));
    });
    if (!n.byRowFilter) wrap.append(h('button', { class: 'lnk', text: '+ Add criterion', onclick: () => mutate(() => {
      n.criteria = crit;
      const used = crit.map((c) => c.field);
      const nextField = searchable.find((f) => used.indexOf(f.field) < 0) || searchable[0];
      crit.push({ field: nextField ? nextField.field : '', op: 'eq',
        slot: values.find((s) => nextField && (s === nextField.field || s === 'context.' + nextField.field)) || asks[0] || '' });
    }, { panel: true }) }));
    wrap.append(h('div', { class: 'grid2', style: 'margin-top:10px' },
      F('Max results', bound(() => n.maxResults, (v) => setOrDelete(n, 'maxResults', numOrNull(v)), { type: 'number', key: n.id + '.maxr', placeholder: '10' }),
        'More matches go to "too many".'),
      n.byRowFilter ? h('span') :
      F('Min criteria', bound(() => n.minCriteria, (v) => setOrDelete(n, 'minCriteria', numOrNull(v)), { type: 'number', key: n.id + '.minc', placeholder: '1' }),
        'Fewer filled criteria = not found.')));
    wrap.append(checkbox('Load directly when exactly one record matches', n.autoPick !== false, (ch) => mutate(() => setOrDelete(n, 'autoPick', ch ? null : false))));
    wrap.append(checkbox('Offer "None of these" when picking', n.allowNone !== false, (ch) => mutate(() => setOrDelete(n, 'allowNone', ch ? null : false))));

    // result card
    wrap.append(h('h4', { class: 'sub', text: 'Result card (when several match)' }));
    const cardSet = (k) => (v) => { n.card = n.card || {}; setOrDelete(n.card, k, v); if (!Object.keys(n.card).length) delete n.card; };
    const t1 = bound(() => (n.card || {}).title, cardSet('title'), { key: n.id + '.ct', placeholder: '{{reference}} · {{status}}' });
    const t2 = bound(() => (n.card || {}).subtitle, cardSet('subtitle'), { key: n.id + '.cs' });
    wrap.append(F('Title', t1), fieldChips(src, t1), F('Subtitle', t2), fieldChips(src, t2),
      h('p', { class: 'hint', text: 'Fields marked • are masked: only their last 4 characters appear on cards.' }));

    // messages
    const pr = (k, ph) => bound(() => (n.prompts || {})[k], (v) => {
      n.prompts = n.prompts || {}; setOrDelete(n.prompts, k, v); if (!Object.keys(n.prompts).length) delete n.prompts;
    }, { key: n.id + '.p' + k, placeholder: ph });
    wrap.append(h('details', { class: 'adv' }, h('summary', { text: 'Messages' }),
      F('Several matches', pr('many', 'I found {{count}} matching records. Which one?'), 'Use {{count}} for the number of matches.'),
      F('No match', pr('none', "I couldn't find a matching record.")),
      F('Too many matches', pr('tooMany', "That matches too many records. Let's narrow it down.")),
      F('After loading', pr('found', 'Found {{' + (n.as || 'rec') + '.reference}}.')),
      F('After "None of these"', pr('cancelled', 'Okay.'))));
    return wrap;
  }

  // A single "editable when" comparison (or JSON for anything more complex).
  function editableWhenEditor(fd, key) {
    const c = fd.editableWhen;
    const toggle = checkbox('Only editable when…', !!c, (ch) => mutate(() => {
      if (ch) fd.editableWhen = { slot: '', op: '=', value: '' }; else { delete fd.editableWhen; delete fd.lockedMessage; }
    }, { panel: true }));
    if (!c) return toggle;
    const box = h('div', null, toggle);
    if (c.all || c.any || c.not) {
      const ta = h('textarea', { class: 'in mono', rows: 3 });
      ta.value = JSON.stringify(c);
      ta.addEventListener('change', () => { try { const w = JSON.parse(ta.value); mutate(() => { fd.editableWhen = w; }, { panel: true }); } catch (e) { ta.classList.add('bad'); } });
      box.append(ta);
    } else {
      const slots = knownSlots();
      const slotOpts = [['', 'field…']].concat(slots.map((s) => [s, s]));
      if (c.slot && slots.indexOf(c.slot) < 0) slotOpts.push([c.slot, c.slot + ' (unknown)']);
      const valIn = h('input', { class: 'in', placeholder: 'value' });
      valIn.value = Array.isArray(c.value) ? c.value.join(', ') : (c.value === undefined ? '' : c.value);
      valIn.hidden = c.op === 'empty' || c.op === 'notEmpty';
      valIn.addEventListener('input', () => mutate(() => {
        c.value = c.op === 'in' ? valIn.value.split(',').map((x) => numify(x.trim())).filter((x) => x !== '') : numify(valIn.value);
      }, { key: key + '.ewv' }));
      box.append(h('div', { class: 'rowx' },
        sel(slotOpts, c.slot || '', (v) => mutate(() => { c.slot = v; }), { mono: true }),
        sel(OPS, c.op || '=', (v) => mutate(() => { c.op = v; if (v === 'empty' || v === 'notEmpty') delete c.value; }, { panel: true })),
        valIn));
    }
    box.append(F('Message when locked', bound(() => fd.lockedMessage, (v) => setOrDelete(fd, 'lockedMessage', v),
      { key: key + '.lm', placeholder: 'This field cannot be changed right now.' })));
    return box;
  }

  const openFieldCards = new Set();
  function changeEditor(n) {
    const wrap = h('div');
    const srcId = sourceForAlias(n.record), src = sourceDef(srcId);
    wrap.append(F('Record', recordSelect(n, 'record'), 'The record loaded by a Find record node.'));
    const ct = bound(() => n.cardTitle, (v) => setOrDelete(n, 'cardTitle', v), { key: n.id + '.ct', placeholder: 'Current details' });
    const pr = bound(() => n.prompt, (v) => setOrDelete(n, 'prompt', v), { key: n.id + '.pr', placeholder: 'What would you like to change?' });
    wrap.append(F('Card title', ct), slotChips(ct), F('Prompt', pr),
      h('div', { class: 'grid2' },
        F('After each change', bound(() => n.againPrompt, (v) => setOrDelete(n, 'againPrompt', v), { key: n.id + '.ag', placeholder: 'Got it. Anything else?' })),
        F('Done button', bound(() => n.doneLabel, (v) => setOrDelete(n, 'doneLabel', v), { key: n.id + '.dl', placeholder: 'Done' }))));

    wrap.append(h('h4', { class: 'sub', text: 'Editable fields' }));
    if (!n.record) wrap.append(h('p', { class: 'hint', text: 'Choose a record first.' }));
    const flds = n.fields || [];
    flds.forEach((fd, i) => {
      const kp = n.id + '.f' + i;
      const sf = sourceField(srcId, fd.field);
      const fOpts = [['', 'field…']].concat((src ? src.fields : []).map((x) => [x.field, x.field + (x.updatable ? '' : ' (read-only)')]));
      if (fd.field && !fOpts.some((o) => o[0] === fd.field)) fOpts.push([fd.field, fd.field + (src ? ' (not in source)' : '')]);
      const det = h('details', { class: 'card' });
      det.open = openFieldCards.has(kp);
      det.addEventListener('toggle', () => { if (det.open) openFieldCards.add(kp); else openFieldCards.delete(kp); });
      const warn = sf && !sf.updatable ? ' ⚠ read-only' : '';
      det.append(h('summary', { class: 'card-h', style: 'cursor:pointer' },
        h('span', { class: 'grow mono', text: (fd.field || '(no field)') + warn }),
        h('span', { class: 'chip', text: (fd.input && fd.input.kind) || 'text' }),
        fd.editableWhen ? h('span', { class: 'chip', text: 'conditional' }) : null,
        h('button', { class: 'x', text: '↑', title: 'Move up', disabled: i === 0, onclick: (e) => { e.preventDefault(); mutate(() => { flds.splice(i - 1, 0, flds.splice(i, 1)[0]); }, { panel: true }); } }),
        h('button', { class: 'x', text: '×', title: 'Remove field', onclick: (e) => { e.preventDefault(); mutate(() => flds.splice(i, 1), { panel: true }); } })));
      det.append(h('div', { class: 'grid2' },
        F('Source field', sel(fOpts, fd.field || '', (v) => mutate(() => {
          fd.field = v;
          const x = sourceField(srcId, v);
          if (!fd.label || fd.label === humanize(fd.field)) fd.label = humanize(v);
          if (x && (!fd.input || !fd.input.kind || fd.input.kind === 'text')) fd.input = { kind: inputKindFor(x.type) };
        }, { panel: true }), { mono: true })),
        F('Label', bound(() => fd.label, (v) => setOrDelete(fd, 'label', v), { key: kp + '.lb' }))));
      det.append(F('Question (optional)', bound(() => fd.prompt, (v) => setOrDelete(fd, 'prompt', v),
        { key: kp + '.pq', placeholder: (fd.label || 'Field') + ' is currently …. What should it be?' })));
      det.append(noteEditor(fd, kp), answerEditor(fd, kp), validatorsEditor(fd, kp), h('h4', { class: 'sub', text: 'Lock' }), editableWhenEditor(fd, kp));
      wrap.append(det);
    });
    if (n.record) {
      wrap.append(h('button', { class: 'lnk', text: '+ Add field', onclick: () => mutate(() => {
        n.fields = flds;
        const used = flds.map((f) => f.field);
        const next = src && src.fields.find((x) => x.updatable && used.indexOf(x.field) < 0);
        flds.push(next ? { field: next.field, label: humanize(next.field), input: { kind: inputKindFor(next.type) } } : { field: '', input: { kind: 'text' } });
        openFieldCards.add(n.id + '.f' + (flds.length - 1));
      }, { panel: true }) }));
    }
    return wrap;
  }

  function emailEditor(n) {
    const wrap = h('div');
    const tpl = (label, key, ph, hint, multi) => {
      const el = bound(() => n[key], (v) => setOrDelete(n, key, v), { key: n.id + '.e' + key, placeholder: ph, multiline: !!multi, rows: multi ? 6 : null });
      wrap.append(F(label, el, hint), slotChips(el));
    };
    tpl('To', 'to', '{{email}}, team@example.com', 'Comma or semicolon separated. {{placeholders}} are filled in from the answers.');
    tpl('Subject', 'subject', 'Your request {{reference}}');
    tpl('Message', 'body', 'Hi {{name}},\n\nThanks for your request…', 'Plain text. Also sent as HTML, with the answers escaped.', true);
    const files = fileSlots();
    if (files.length) {
      const box = h('div', { class: 'card' }, h('div', { class: 'card-h', text: 'Attach file answers' }));
      files.forEach((s) => box.append(checkbox(s, (n.attachments || []).indexOf(s) >= 0, (c) => mutate(() => {
        const cur = (n.attachments || []).filter((x) => x !== s);
        if (c) cur.push(s);
        if (cur.length) n.attachments = cur; else delete n.attachments;
      }, { panel: true }))));
      wrap.append(box);
    }
    wrap.append(h('h4', { class: 'sub', text: 'Sender' }));
    wrap.append(F('From', bound(() => n.from, (v) => setOrDelete(n, 'from', v.trim()), { key: n.id + '.efrom', placeholder: 'no-reply@yourcompany.com' }),
      'Required by APEX_MAIL. Use an address your mail server accepts.'));
    wrap.append(h('div', { class: 'grid2' },
      F('Cc', bound(() => n.cc, (v) => setOrDelete(n, 'cc', v), { key: n.id + '.ecc' })),
      F('Bcc', bound(() => n.bcc, (v) => setOrDelete(n, 'bcc', v), { key: n.id + '.ebcc' }))));
    wrap.append(F('Reply-to', bound(() => n.replyTo, (v) => setOrDelete(n, 'replyTo', v), { key: n.id + '.erep' })));
    wrap.append(F('Send through connector (optional)', connectorInput(() => n.connector, (v) => setOrDelete(n, 'connector', v.trim()), n.id + '.econn'),
      'Leave empty to queue the email with APEX_MAIL. A connector receives {"to", "cc", "bcc", "replyTo", "from", "subject", "body", "attachments"} and returns {"ok": true} or {"ok": false, "message": "…"}.'));
    wrap.append(h('h4', { class: 'sub', text: 'Chat messages' }));
    wrap.append(F('After sending (optional)', bound(() => n.message, (v) => setOrDelete(n, 'message', v), { key: n.id + '.emsg', placeholder: "I've emailed you a copy." })));
    wrap.append(F('If sending fails', bound(() => n.errorMessage, (v) => setOrDelete(n, 'errorMessage', v), { key: n.id + '.eerr', placeholder: "Sorry, I couldn't send the email." })));
    wrap.append(h('p', { class: 'hint', text: 'The email is not sent again when the user edits an answer and the flow replays. In Test, nothing is sent: the email is shown instead.' }));
    return wrap;
  }

  // ---- Post to Teams (FC_CHANNEL)
  const TEAMS_STYLES = [['default', 'Plain'], ['attention', 'Red (attention)'], ['warning', 'Amber (warning)'], ['good', 'Green (good)'],
                        ['accent', 'Blue (accent)'], ['emphasis', 'Grey (emphasis)']];
  function teamsEditor(n) {
    const wrap = h('div');
    const tpl = (label, key, ph, hint, multi) => {
      const el = bound(() => n[key], (v) => setOrDelete(n, key, v), { key: n.id + '.t' + key, placeholder: ph, multiline: !!multi, rows: multi ? 4 : null });
      wrap.append(F(label, el, hint), slotChips(el));
    };
    wrap.append(F('Channel', bound(() => n.channel, (v) => setOrDelete(n, 'channel', v.trim().toLowerCase()), { key: n.id + '.tch', placeholder: 'it_alerts' }),
      'A name in FC_TEAMS_CHANNELS (fc_channel.add_channel). The workflow URL stays in the database, never in the flow.'));
    tpl('Title', 'title', 'New request {{reference}}');
    wrap.append(F('Colour', sel(TEAMS_STYLES, n.style || 'default', (v) => mutate(() => { if (v === 'default') delete n.style; else n.style = v; }, { panel: true }))));
    tpl('Text (optional)', 'text', 'Raised by {{app_user}}.', 'Teams shows simple Markdown (**bold**, lists). Links typed in answers are not made clickable.', true);
    const facts = n.facts || [];
    const box = h('div', { class: 'card' }, h('div', { class: 'card-h', text: 'Facts (label: value)' }),
      h('p', { class: 'hint', text: 'Shown as a two-column list. A fact whose value is empty is left out.' }));
    facts.forEach((f, i) => {
      box.append(h('div', { class: 'grid2' },
        F('Label', bound(() => f.title, (v) => { f.title = v; }, { key: n.id + '.tf' + i + 't', placeholder: 'Reference' })),
        h('div', null, F('Value', bound(() => f.value, (v) => { f.value = v; }, { key: n.id + '.tf' + i + 'v', placeholder: '{{reference}}' })),
          h('button', { class: 'lnk', text: 'Remove', onclick: () => mutate(() => { facts.splice(i, 1); if (!facts.length) delete n.facts; }, { panel: true }) }))));
    });
    box.append(h('button', { class: 'lnk', text: '+ Add fact', onclick: () => mutate(() => { n.facts = facts; facts.push({ title: '', value: '' }); }, { panel: true }) }));
    wrap.append(box);
    wrap.append(h('div', { class: 'grid2' },
      F('Button link (optional)', bound(() => n.link, (v) => setOrDelete(n, 'link', v.trim()), { key: n.id + '.tlink', placeholder: 'https://…/r/app/request?id={{reference}}' })),
      F('Button text', bound(() => n.linkLabel, (v) => setOrDelete(n, 'linkLabel', v), { key: n.id + '.tlbl', placeholder: 'Open' }))));
    wrap.append(F('Post through connector (optional)', connectorInput(() => n.connector, (v) => setOrDelete(n, 'connector', v.trim()), n.id + '.tconn'),
      'Leave empty to post with FC_CHANNEL. A connector receives {"channel", "title", "text", "facts", "link", "linkLabel", "style"} and returns {"ok": true} or {"ok": false, "message": "…"}.'));
    wrap.append(h('h4', { class: 'sub', text: 'Chat messages' }));
    wrap.append(F('After posting (optional)', bound(() => n.message, (v) => setOrDelete(n, 'message', v), { key: n.id + '.tmsg', placeholder: "I've let the team know in Teams." })));
    wrap.append(F('If posting fails', bound(() => n.errorMessage, (v) => setOrDelete(n, 'errorMessage', v), { key: n.id + '.terr', placeholder: "Sorry, I couldn't post to Teams." })));
    wrap.append(h('p', { class: 'hint', text: 'Not posted again when the user edits an answer and the flow replays. In Test, nothing is posted: the card is shown instead.' }));
    return wrap;
  }

  // ---- REST call
  const REST_BLOCKED = /^(authorization|cookie|host|content-length|transfer-encoding|connection|proxy-.*|x-forwarded-.*)$/i;
  // name -> value rows over an object property (query, headers, response mapping)
  function kvRows(n, prop, o) {
    const box = h('div', { class: 'card' }, h('div', { class: 'card-h', text: o.title }));
    if (o.hint) box.append(h('p', { class: 'hint', text: o.hint }));
    const obj = n[prop] || {};
    const keys = Object.keys(obj);
    const put = (fn) => mutate(() => {
      const cur = Object.assign({}, n[prop] || {});
      fn(cur);
      if (Object.keys(cur).length || o.keepEmpty) n[prop] = cur; else delete n[prop];
    }, { panel: true });
    keys.forEach((k, i) => {
      const kIn = h('input', { class: 'in mono', value: k, placeholder: o.keyPh });
      kIn.addEventListener('change', () => put((cur) => {
        const nk = kIn.value.trim(), out = {};
        Object.keys(cur).forEach((x) => { out[x === k ? nk : x] = cur[x]; });
        Object.keys(cur).forEach((x) => delete cur[x]);
        Object.keys(out).forEach((x) => { if (x) cur[x] = out[x]; });
      }));
      const vIn = bound(() => obj[k], (v) => { n[prop] = n[prop] || {}; n[prop][k] = v; }, { mono: true, key: n.id + '.' + prop + '.' + i, placeholder: o.valPh });
      box.append(h('div', { class: 'grid2 kv' }, kIn, h('div', { class: 'rowx' }, vIn,
        h('button', { class: 'btn', text: '×', title: 'Remove', onclick: () => put((cur) => { delete cur[k]; }) }))));
    });
    const add = h('button', { class: 'btn', text: o.addLabel, onclick: () => put((cur) => {
      let k = o.newKey, i = 2;
      while (k in cur) k = o.newKey + '_' + i++;
      cur[k] = o.newVal;
    }) });
    box.append(h('div', { class: 'rowx' }, add));
    return box;
  }
  function restEditor(n) {
    const wrap = h('div');
    const eps = S.rest || [];
    const m = String(n.method || 'GET').toUpperCase();
    const listId = 'fcd-restlist';
    let dl = document.getElementById(listId);
    if (!dl) { dl = h('datalist', { id: listId }); ROOT.append(dl); }
    dl.textContent = '';
    eps.forEach((e) => dl.append(h('option', { value: e.id, label: e.methods + ' ' + e.baseUrl + (e.description ? ' · ' + e.description : '') })));
    const epIn = bound(() => n.endpoint, (v) => setOrDelete(n, 'endpoint', v.trim()), { mono: true, key: n.id + '.rep', placeholder: 'endpoint_id', onChange: true, panel: true });
    epIn.setAttribute('list', listId);
    const ep = eps.find((e) => e.id === n.endpoint);
    wrap.append(F('Endpoint', epIn, ep ? ep.baseUrl + ' · allows ' + ep.methods + (ep.credential ? ' · uses a Web Credential' : '')
      : 'Registered in FC_REST_ENDPOINTS (base URL, Web Credential, allowed methods). The flow never holds the host name or a key.'));
    wrap.append(h('div', { class: 'grid2' },
      F('Method', sel(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], m, (v) => mutate(() => { n.method = v; if (v === 'GET') delete n.body; }, { panel: true }))),
      F('Path', bound(() => n.path, (v) => setOrDelete(n, 'path', v.trim()), { mono: true, key: n.id + '.rpath', placeholder: '/customers/{{customer_id}}' }))));
    wrap.append(h('p', { class: 'hint', text: 'Added to the endpoint\'s base URL. {{placeholders}} are URL-encoded, so an answer can\'t change the path.' }));
    wrap.append(kvRows(n, 'query', { title: 'Query parameters', keyPh: 'name', valPh: '{{field}}', addLabel: '+ Parameter', newKey: 'param', newVal: '' }));
    wrap.append(F(null, checkbox('Leave out empty query parameters', !!n.skipEmptyQuery, (c) => mutate(() => { if (c) n.skipEmptyQuery = true; else delete n.skipEmptyQuery; }))));
    if (m !== 'GET') {
      const ta = h('textarea', { class: 'in mono', rows: 6, spellcheck: 'false', placeholder: '{"amount": "{{amount}}", "note": "From {{name}}"}' });
      ta.value = n.body === undefined ? '' : JSON.stringify(n.body, null, 2);
      const check = () => {
        let ok = true;
        if (ta.value.trim()) { try { JSON.parse(ta.value); } catch (e) { ok = false; } }
        ta.classList.toggle('bad', !ok);
        return ok;
      };
      ta.addEventListener('input', () => { if (check()) mutate(() => { if (ta.value.trim()) n.body = JSON.parse(ta.value); else delete n.body; }, { key: n.id + '.rbody' }); });
      check();
      wrap.append(F('JSON body', ta, '"{{field}}" on its own keeps the answer\'s type (a number stays a number, a list stays a list); other text has its placeholders filled in.'), slotChips(ta));
    }
    wrap.append(kvRows(n, 'map', { title: 'Put into fields', keyPh: 'field', valPh: '$.data.name',
      hint: 'Field ← JSON path in the answer: $.rate, $.items[0].id, or $ for the whole answer. The fields update bound form items.',
      addLabel: '+ Field', newKey: 'field', newVal: '$.', keepEmpty: true }));
    wrap.append(F('HTTP status into field (optional)', bound(() => n.statusSlot, (v) => setOrDelete(n, 'statusSlot', v.trim()), { mono: true, key: n.id + '.rstat', placeholder: 'http_status' })));
    wrap.append(kvRows(n, 'headers', { title: 'Extra headers (optional)', keyPh: 'X-Header', valPh: '{{field}}', addLabel: '+ Header', newKey: 'X-Header', newVal: '',
      hint: 'No secrets here: Authorization, Cookie and keys belong to the endpoint (its Web Credential or EXTRA_HEADERS).' }));
    wrap.append(h('h4', { class: 'sub', text: 'Chat messages' }));
    wrap.append(F('After the call (optional)', bound(() => n.message, (v) => setOrDelete(n, 'message', v), { key: n.id + '.rmsg', placeholder: 'Today\'s rate is {{rate}}.' })));
    wrap.append(F('On 404 (optional)', bound(() => n.notFoundMessage, (v) => setOrDelete(n, 'notFoundMessage', v), { key: n.id + '.rnf', placeholder: 'I couldn\'t find that.' })));
    wrap.append(F('If the call fails', bound(() => n.errorMessage, (v) => setOrDelete(n, 'errorMessage', v), { key: n.id + '.rerr', placeholder: 'Sorry, I couldn\'t get that information right now.' })));
    wrap.append(h('div', { class: 'card' }, h('div', { class: 'hint', style: 'margin:0', text:
      'When the user edits an earlier answer, a GET runs again (quietly) with the new values; other methods are never repeated. In Test, nothing is called: the mock answer is used.' }),
      h('button', { class: 'lnk', text: 'Edit the test mock →', onclick: () => setTab('test') })));
    return wrap;
  }

  // ---- workflow
  function workflowEditor(n) {
    const wrap = h('div');
    wrap.append(h('div', { class: 'grid2' },
      F('Workflow static ID', bound(() => n.workflow, (v) => setOrDelete(n, 'workflow', v.trim()), { mono: true, key: n.id + '.wf', placeholder: 'LEAVE_APPROVAL', panel: true }),
        'Shared Components > Workflows > the workflow\'s Static ID.'),
      F('Application ID (optional)', bound(() => n.applicationId, (v) => setOrDelete(n, 'applicationId', v.trim() ? (Number(v) || v.trim()) : ''), { mono: true, key: n.id + '.wfapp', placeholder: 'this application' }),
        'Leave empty for the application the chat runs in.')));
    wrap.append(kvRows(n, 'parameters', { title: 'Parameters', keyPh: 'P_STATIC_ID', valPh: '{{field}}', addLabel: '+ Parameter', newKey: 'P_PARAM', newVal: '',
      hint: 'Parameter static ID ← value. {{placeholders}} are filled in from the answers. Dates (YYYY-MM-DD) are passed with that format mask; numbers and text as they are. Every required workflow parameter must be here.' }));
    const dk = bound(() => n.detailKey, (v) => setOrDelete(n, 'detailKey', v), { mono: true, key: n.id + '.wfdk', placeholder: '{{request_id}}' });
    wrap.append(F('Detail primary key (optional)', dk, 'The row the workflow is about (its Additional Data: the workflow reads that row by this key).'), slotChips(dk));
    wrap.append(F('Workflow ID into field (optional)', bound(() => n.resultSlot, (v) => setOrDelete(n, 'resultSlot', v.trim()), { mono: true, key: n.id + '.wfres', placeholder: 'workflow_id' }),
      'The new workflow\'s ID, e.g. for a message, a Submit or a link to the Workflow Console.'));
    wrap.append(h('h4', { class: 'sub', text: 'Chat messages' }));
    wrap.append(F('After starting (optional)', bound(() => n.message, (v) => setOrDelete(n, 'message', v), { key: n.id + '.wfmsg', placeholder: 'Your request is on its way for approval (reference {{workflow_id}}).' })));
    wrap.append(F('If it can\'t start', bound(() => n.errorMessage, (v) => setOrDelete(n, 'errorMessage', v), { key: n.id + '.wferr', placeholder: 'Sorry, I couldn\'t start that request right now.' }),
      'An error raised with raise_application_error (-20000 to -20999) is shown instead, as written.'));
    wrap.append(h('div', { class: 'card' }, h('div', { class: 'hint', style: 'margin:0', text:
      'The workflow starts as the signed-in APEX user, in the same database transaction as the chat turn. It is not started again when the user edits an earlier answer and the flow replays. In Test, nothing starts: the mock is used.' }),
      h('button', { class: 'lnk', text: 'Edit the test mock →', onclick: () => setTab('test') })));
    return wrap;
  }

  // ---- agent
  const AGENT_KINDS = [['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['email', 'Email'], ['yesno', 'Yes / no'], ['choice', 'Choice'],
                       ['file', 'File (the user uploads it)']];
  function aiCat() { return S.ai || { providers: [], tools: [], skills: [] }; }
  function agentSlots() {
    const out = [];
    S.flow.nodes.forEach((n) => { if (n.type === 'agent') (n.outputs || []).forEach((o) => { if (o && o.name && out.indexOf(o.name) < 0) out.push(o.name); }); });
    return out;
  }
  function idList(label, all, chosen, onToggle, hint) {
    const box = h('div', { class: 'card' }, h('div', { class: 'card-h', text: label }));
    const ids = all.map((x) => x.id);
    chosen.forEach((id) => { if (ids.indexOf(id) < 0) all = all.concat([{ id, description: BACKEND ? '(not in the database registry)' : '(mocked in Test)', missing: true }]); });
    if (!all.length) box.append(h('p', { class: 'hint', text: hint }));
    all.forEach((x) => box.append(checkbox(x.id + (x.description ? ' — ' + x.description : '') + (x.write ? ' (writes; asks the user to confirm)' : ''),
      chosen.indexOf(x.id) >= 0, (c) => onToggle(x.id, c))));
    const add = h('input', { class: 'in mono', placeholder: 'add by id, then Enter' });
    add.addEventListener('keydown', (e) => { if (e.key === 'Enter' && add.value.trim()) { e.preventDefault(); onToggle(add.value.trim(), true); } });
    box.append(add);
    return box;
  }
  function agentEditor(n) {
    const wrap = h('div');
    const cat = aiCat();
    const provOpts = [['', 'provider…']].concat(cat.providers.map((p) => [p.id, p.id + (p.model ? ' (' + p.model + ')' : '')]));
    if (n.provider && !cat.providers.some((p) => p.id === n.provider)) provOpts.push([n.provider, n.provider + (BACKEND ? ' (not in FC_AI_PROVIDERS)' : '')]);
    wrap.append(F('Model provider', sel(provOpts, n.provider || '', (v) => mutate(() => setOrDelete(n, 'provider', v), { panel: true }), { mono: true }),
      'Registered in FC_AI_PROVIDERS (base URL, model, API key credential, wallet). The flow stores only this id.'));
    const goal = bound(() => n.goal, (v) => setOrDelete(n, 'goal', v), { key: n.id + '.goal', multiline: true, rows: 4,
      placeholder: 'Help {{app_user}} apply for leave: check their balance, collect the dates and leave type.' });
    wrap.append(F('Task (goal)', goal), slotChips(goal));
    const ins = bound(() => n.instructions, (v) => setOrDelete(n, 'instructions', v), { key: n.id + '.instr', multiline: true, rows: 3,
      placeholder: 'Optional rules: tone, what to check first, what never to do.' });
    wrap.append(F('Instructions (optional)', ins));
    wrap.append(F('Opening message (optional)', bound(() => n.intro, (v) => setOrDelete(n, 'intro', v), { key: n.id + '.intro', placeholder: 'Let me help you with that.' })));

    // outputs
    wrap.append(h('h4', { class: 'sub', text: 'Fields the agent fills' }));
    wrap.append(h('p', { class: 'hint', text: 'The agent ends by calling finish with these. Each is checked like an answer and saved as a field, so a Summary and Submit can follow (the agent gathers, the flow commits).' }));
    const outs = n.outputs = n.outputs || [];
    outs.forEach((o, i) => {
      const kp = n.id + '.out' + i;
      const card = h('div', { class: 'card' });
      card.append(h('div', { class: 'card-h' }, h('span', { class: 'grow mono', text: o.name || 'field ' + (i + 1) }),
        h('button', { class: 'x', text: '×', title: 'Remove', onclick: () => mutate(() => outs.splice(i, 1), { panel: true }) })));
      const nameIn = h('input', { class: 'in mono', value: o.name || '', placeholder: 'leave_type' });
      nameIn.addEventListener('change', () => mutate(() => { o.name = nameIn.value.trim(); }, { panel: true }));
      card.append(h('div', { class: 'grid2' }, F('Field', nameIn),
        F('Label', bound(() => o.label, (v) => setOrDelete(o, 'label', v), { key: kp + '.l', placeholder: 'Leave type' }))));
      card.append(h('div', { class: 'grid2' },
        F('Type', sel(AGENT_KINDS, o.kind || 'text', (v) => mutate(() => {
          o.kind = v;
          if (v !== 'choice') delete o.options;
          if (v !== 'number') { delete o.min; delete o.max; }
          if (v !== 'file') { delete o.accept; delete o.maxSizeKb; }
        }, { panel: true }))),
        h('div', null,
          checkbox('Required', o.required !== false, (c) => mutate(() => { if (c) delete o.required; else o.required = false; })),
          checkbox('Personal data (PII)', !!o.pii, (c) => mutate(() => { if (c) o.pii = true; else delete o.pii; })),
          checkbox('Hide on screen', !!o.redact, (c) => mutate(() => { if (c) o.redact = 'full'; else { delete o.redact; delete o.allowReveal; } })))));
      if (o.kind === 'file') {
        card.append(F('Allowed types (optional)', bound(() => o.accept, (v) => setOrDelete(o, 'accept', v), { key: kp + '.acc', placeholder: '.pdf,.jpg' }),
          'Only the user\'s upload fills this field: the agent asks for it with ask_user and cannot set it itself.'));
      }
      if (o.kind === 'choice') {
        card.append(F('Options', bound(() => (o.options || []).map((x) => (typeof x === 'object' ? x.value : x)).join(', '),
          (v) => { o.options = v.split(',').map((x) => x.trim()).filter(Boolean); }, { key: kp + '.o', placeholder: 'annual, sick, unpaid', onChange: true }),
          'Comma separated. The agent must pick one of these.'));
      }
      if (o.kind === 'number') {
        card.append(h('div', { class: 'grid2' },
          F('Minimum', bound(() => o.min, (v) => setOrDelete(o, 'min', v === '' ? '' : Number(v)), { key: kp + '.min', type: 'number' })),
          F('Maximum', bound(() => o.max, (v) => setOrDelete(o, 'max', v === '' ? '' : Number(v)), { key: kp + '.max', type: 'number' }))));
      }
      card.append(F('Hint for the model (optional)', bound(() => o.description, (v) => setOrDelete(o, 'description', v), { key: kp + '.d', placeholder: 'First day of leave' })));
      wrap.append(card);
    });
    wrap.append(h('button', { class: 'lnk', text: '+ Add field', onclick: () => mutate(() => {
      outs.push({ name: uniqueSlot('field'), label: 'New field', kind: 'text' });
    }, { panel: true }) }));

    // inputs
    const known = knownSlots().filter((k) => k !== BUILTIN_USER && agentSlots().indexOf(k) < 0);
    const inputs = n.inputs || [];
    const inBox = h('div', { class: 'card' }, h('div', { class: 'card-h', text: 'Values the agent can see' }));
    if (!known.length) inBox.append(h('p', { class: 'hint', text: 'No answers or context values yet. {{app_user}} and today\'s date are always shared.' }));
    known.forEach((k) => inBox.append(checkbox(k, inputs.indexOf(k) >= 0, (c) => mutate(() => {
      const cur = (n.inputs || []).filter((x) => x !== k);
      if (c) cur.push(k);
      if (cur.length) n.inputs = cur; else delete n.inputs;
    }))));
    inBox.append(checkbox('Send PII values to the model (otherwise it sees placeholders like [PII_1], and FlowChat puts the real value back when the agent uses one)', !!n.sendPii,
      (c) => mutate(() => { if (c) n.sendPii = true; else delete n.sendPii; })));
    wrap.append(inBox);

    // tools and skills
    const toggle = (key) => (id, c) => mutate(() => {
      const cur = (n[key] || []).filter((x) => x !== id);
      if (c) cur.push(id);
      if (cur.length) n[key] = cur; else delete n[key];
    }, { panel: true });
    wrap.append(idList('Tools it may use', cat.tools.slice(), n.tools || [], toggle('tools'),
      BACKEND ? 'No tools in FC_AI_TOOLS yet.' : 'Tools come from FC_AI_TOOLS when the designer runs inside APEX. Add ids here to test them with mocks.'));
    wrap.append(idList('Skills it may load', cat.skills.map((x) => ({ id: x.id, description: x.description || x.name })), n.skills || [], toggle('skills'),
      BACKEND ? 'No skills in FC_AI_SKILLS yet.' : 'Skills come from FC_AI_SKILLS when the designer runs inside APEX.'));
    wrap.append(h('p', { class: 'hint', text: 'Built in: ask_user (a question rendered and checked by FlowChat), finish, give_up, and handoff/load_skill when exits/skills are set.' }));

    // connections
    wrap.append(h('h4', { class: 'sub', text: 'Connections' }));
    wrap.append(F('When finished, go to', targetSelect(n, 'next'), 'Usually a Summary, then Submit.'));
    const exits = n.exits = n.exits || [];
    exits.forEach((e, i) => {
      const card = h('div', { class: 'card' });
      card.append(h('div', { class: 'card-h' }, h('span', { class: 'grow', text: 'Exit ' + (i + 1) }),
        h('button', { class: 'x', text: '×', title: 'Remove', onclick: () => mutate(() => exits.splice(i, 1), { panel: true }) })));
      const nm = h('input', { class: 'in mono', value: e.name || '', placeholder: 'payslip' });
      nm.addEventListener('change', () => mutate(() => { e.name = nm.value.trim(); }, { panel: true }));
      card.append(h('div', { class: 'grid2' }, F('Name', nm),
        F('When to use it', bound(() => e.description, (v) => setOrDelete(e, 'description', v), { key: n.id + '.x' + i, placeholder: 'payslip questions' }))));
      card.append(F('Go to', targetSelect(n, 'exit:' + i)));
      wrap.append(card);
    });
    wrap.append(h('button', { class: 'lnk', text: '+ Add exit (hand off to another step)', onclick: () => mutate(() => {
      exits.push({ name: 'exit_' + (exits.length + 1) });
    }, { panel: true }) }));
    wrap.append(F('On error, go to', targetSelect(n, 'onError'), 'Used when the model fails, gives up or hits a limit. Without it the conversation ends as failed.'));
    wrap.append(F('Error message', bound(() => n.errorMessage, (v) => setOrDelete(n, 'errorMessage', v), { key: n.id + '.err', placeholder: "Sorry, I couldn't complete this." })));

    // limits
    const lim = n.limits || {};
    const limIn = (key, ph) => bound(() => lim[key], (v) => { n.limits = n.limits || {}; setOrDelete(n.limits, key, v === '' ? '' : Number(v)); if (!Object.keys(n.limits).length) delete n.limits; },
      { key: n.id + '.lim' + key, type: 'number', placeholder: ph });
    wrap.append(h('h4', { class: 'sub', text: 'Limits' }));
    wrap.append(h('div', { class: 'grid2' }, F('Model calls in total', limIn('maxSteps', '20')), F('Questions to the user', limIn('maxQuestions', '10'))));
    wrap.append(F('Model calls per turn', limIn('maxCallsPerTurn', '4'), 'Then the user sees a Continue button, so one request never runs too long.'));
    return wrap;
  }

  function menuEditor(n) {
    const wrap = h('div');
    const list = n.options = n.options || [];
    const pr = bound(() => n.prompt, (v) => setOrDelete(n, 'prompt', v), { key: n.id + '.mp', placeholder: 'What would you like to do?', multiline: true });
    wrap.append(F('Question', pr), slotChips(pr));
    wrap.append(noteEditor(n, n.id));
    wrap.append(h('p', { class: 'hint', text: 'The options show as buttons (pills); the user can also type an option\'s label or number. ' +
      'Each option goes to its own step. A menu shows again every time the flow reaches it, so later steps can loop back to it.' }));
    const slots = knownSlots().filter((s) => s !== BUILTIN_USER).concat([BUILTIN_USER]);
    list.forEach((o, i) => {
      const kp = n.id + '.o' + i;
      const card = h('div', { class: 'card' });
      card.append(h('div', { class: 'card-h' },
        h('span', { class: 'grow', text: 'Option ' + (i + 1) }),
        h('button', { class: 'x', text: '↑', title: 'Move up', disabled: i === 0, onclick: () => mutate(() => { list.splice(i - 1, 0, list.splice(i, 1)[0]); }, { panel: true }) }),
        h('button', { class: 'x', text: '×', title: 'Remove', onclick: () => mutate(() => list.splice(i, 1), { panel: true }) })));
      card.append(h('div', { class: 'grid2' },
        F('Button text', bound(() => o.label, (v) => setOrDelete(o, 'label', v), { key: kp + '.l', placeholder: 'Apply for leave' })),
        F('Value', bound(() => (o.value === undefined ? '' : String(o.value)), (v) => { o.value = v.trim(); }, { key: kp + '.v', placeholder: 'leave' }),
          'Stored in the field (if any) and used in conditions.')));
      card.append(F('Then go to', targetSelect(n, 'option:' + i)));
      const w = o.when && !o.when.all && !o.when.any && !o.when.not ? o.when : null;
      if (o.when && !w) {
        card.append(h('p', { class: 'hint', text: 'Shown only when: ' + condText(o.when) + ' (edit it in the JSON tab).' }));
      } else {
        const on = !!w;
        card.append(checkbox('Show only when…', on, (c) => mutate(() => { if (c) o.when = { slot: '', op: '=', value: '' }; else delete o.when; }, { panel: true })));
        if (on) {
          const slotOpts = [['', 'field…']].concat(slots.map((x) => [x, x]));
          if (w.slot && slots.indexOf(w.slot) < 0) slotOpts.push([w.slot, w.slot + ' (unknown)']);
          const valIn = h('input', { class: 'in', placeholder: w.op === 'in' ? 'A, B, C' : 'value' });
          valIn.value = Array.isArray(w.value) ? w.value.join(', ') : (w.value === undefined ? '' : w.value);
          valIn.hidden = w.op === 'empty' || w.op === 'notEmpty';
          valIn.addEventListener('change', () => mutate(() => {
            w.value = w.op === 'in' ? valIn.value.split(',').map((x) => x.trim()).filter(Boolean) : valIn.value;
          }));
          card.append(h('div', { class: 'rowx' },
            sel(slotOpts, w.slot || '', (v) => mutate(() => { w.slot = v; }), { mono: true }),
            sel(OPS, w.op || '=', (v) => mutate(() => { w.op = v; if (v === 'empty' || v === 'notEmpty') delete w.value; }, { panel: true })),
            valIn));
        }
      }
      wrap.append(card);
    });
    wrap.append(h('button', { class: 'lnk', text: '+ Add option', onclick: () => mutate(() => {
      let k = list.length + 1;
      while (list.some((o) => String(o.value) === 'option_' + k)) k++;
      list.push({ value: 'option_' + k, label: 'Option ' + k });
    }, { panel: true }) }));
    wrap.append(h('h4', { class: 'sub', text: 'Remember the choice (optional)' }));
    const slotIn = h('input', { class: 'in mono', value: n.slot || '', placeholder: 'e.g. topic' });
    slotIn.addEventListener('change', () => mutate(() => setOrDelete(n, 'slot', slotIn.value.trim() || null), { panel: true }));
    wrap.append(h('div', { class: 'grid2' },
      F('Field', slotIn, 'Saves the chosen value, e.g. for {{topic}}, conditions and the summary.'),
      F('Label', bound(() => n.label, (v) => setOrDelete(n, 'label', v), { key: n.id + '.ml', placeholder: 'Topic' }))));
    return wrap;
  }

  function setEditor(n) {
    const wrap = h('div');
    const list = n.assign = n.assign || [];
    wrap.append(h('p', { class: 'hint', text: 'Runs in order without asking anything, so a value can use the ones above it. ' +
      'Runs again when the flow is replayed after an Edit: tick "Only if empty" for defaults the user may change later.' }));
    const sources = knownSlots().filter((x) => x !== BUILTIN_USER).concat([BUILTIN_USER]);
    list.forEach((a, i) => {
      const kp = n.id + '.a' + i;
      const mode = a.clear ? 'clear' : 'from' in a ? 'from' : 'template' in a ? 'template' : 'value';
      const card = h('div', { class: 'card' });
      const slotIn = h('input', { class: 'in mono', value: a.slot || '', placeholder: 'field_name' });
      slotIn.addEventListener('change', () => mutate(() => { a.slot = slotIn.value.trim(); }, { panel: true }));
      card.append(h('div', { class: 'card-h' },
        h('span', { class: 'grow', text: 'Value ' + (i + 1) }),
        h('button', { class: 'x', text: '↑', title: 'Move up', disabled: i === 0, onclick: () => mutate(() => { list.splice(i - 1, 0, list.splice(i, 1)[0]); }, { panel: true }) }),
        h('button', { class: 'x', text: '×', title: 'Remove', onclick: () => mutate(() => list.splice(i, 1), { panel: true }) })));
      card.append(h('div', { class: 'grid2' },
        F('Field', slotIn),
        F('Set it to', sel([['value', 'A fixed value'], ['template', 'Text with placeholders'], ['from', 'A copy of another value'], ['clear', 'Empty (clear it)']],
          mode, (v) => mutate(() => {
            delete a.value; delete a.template; delete a.from; delete a.clear;
            if (v === 'value') a.value = ''; else if (v === 'template') a.template = ''; else if (v === 'from') a.from = ''; else a.clear = true;
          }, { panel: true })))));
      if (mode === 'value') {
        card.append(F('Value', bound(() => (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)), (v) => {
          const t = v.trim();
          a.value = /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t === 'true' ? true : t === 'false' ? false : v;
        }, { key: kp + '.v', placeholder: 'NEW' }), 'Numbers and true/false are stored as such; anything else as text.'));
      } else if (mode === 'template') {
        const ta = bound(() => a.template, (v) => { a.template = v; }, { key: kp + '.t', placeholder: 'Request from {{app_user}} for {{context.dept}}' });
        card.append(F('Text', ta), slotChips(ta));
      } else if (mode === 'from') {
        const opts = [['', '— choose a value —']].concat(sources.map((x) => [x, x]));
        if (a.from && sources.indexOf(a.from) < 0) opts.push([a.from, a.from + ' (not set by this flow)']);
        card.append(F('Copy of', sel(opts, a.from || '', (v) => mutate(() => { a.from = v; }, { panel: true }), { mono: true }),
          'An answer, a record field (alias.field), a context value (context.name) or app_user.'));
      }
      if (mode !== 'clear') card.append(checkbox('Only if empty (keep a value that is already there)', a.onlyIfEmpty, (c) => mutate(() => setOrDelete(a, 'onlyIfEmpty', c || null))));
      wrap.append(card);
    });
    wrap.append(h('button', { class: 'lnk', text: '+ Add value', onclick: () => mutate(() => { list.push({ slot: '', value: '', onlyIfEmpty: true }); }, { panel: true }) }));
    return wrap;
  }

  function repeatEditor(n) {
    const wrap = h('div');
    const slotIn = h('input', { class: 'in mono', value: n.slot || '' });
    slotIn.addEventListener('change', () => {
      const v = slotIn.value.trim();
      if (v === n.slot) return;
      if (!/^[a-z][a-z0-9_]{0,99}$/.test(v)) { toast('List names: lowercase letters, digits and _, starting with a letter.'); slotIn.value = n.slot || ''; return; }
      const old = n.slot;
      mutate(() => { if (old) renameSlot(old, v); n.slot = v; }, { panel: true });
    });
    wrap.append(h('div', { class: 'grid2' },
      F('List (slot)', slotIn, 'Holds an array of items: [{field: value}, …]. {{' + (n.slot || 'list') + '.count}} is the number of items.'),
      F('Label', bound(() => n.label, (v) => setOrDelete(n, 'label', v), { key: n.id + '.label', placeholder: 'Items' }))));
    const pr = bound(() => n.prompt, (v) => setOrDelete(n, 'prompt', v), { multiline: true, rows: 2, key: n.id + '.prompt', placeholder: '(optional) e.g. Now the expenses, one at a time.' });
    wrap.append(F('Intro', pr), slotChips(pr));
    wrap.append(h('div', { class: 'grid2' },
      F('One item is called', bound(() => n.itemLabel, (v) => setOrDelete(n, 'itemLabel', v), { key: n.id + '.il', placeholder: 'item' })),
      F('Item title', bound(() => n.itemTitle, (v) => setOrDelete(n, 'itemTitle', v), { key: n.id + '.it', placeholder: '{{description}} ({{amount}})' }),
        'Shown in the list and the summary. Uses the item\'s fields.'),
      F('Minimum items', bound(() => n.min, (v) => setOrDelete(n, 'min', numOrNull(v)), { type: 'number', key: n.id + '.min', placeholder: '1' })),
      F('Maximum items', bound(() => n.max, (v) => setOrDelete(n, 'max', numOrNull(v)), { type: 'number', key: n.id + '.max', placeholder: '20' }))));
    wrap.append(checkbox('Let the user change an item in the list (Edit)', n.allowEdit !== false,
      (c) => mutate(() => { if (c) delete n.allowEdit; else n.allowEdit = false; })),
      h('p', { class: 'hint', text: 'Edit opens the item\'s fields with their values; the user changes any of them and taps Save. ' +
        'Rows loaded by a lookup keep any extra keys (e.g. a row id), so your Submit connector can update those rows and insert the new ones.' }));

    wrap.append(h('h4', { class: 'sub', text: 'Questions for each item' }),
      h('p', { class: 'hint', text: 'Asked in order for every item. In a question, {{n}} is the item number and earlier fields of the same item can be used, e.g. {{description}}.' }));
    const flds = n.fields || [];
    flds.forEach((fd, i) => {
      const kp = n.id + '.rf' + i;
      const det = h('details', { class: 'card' });
      det.open = openFieldCards.has(kp);
      det.addEventListener('toggle', () => { if (det.open) openFieldCards.add(kp); else openFieldCards.delete(kp); });
      det.append(h('summary', { class: 'card-h', style: 'cursor:pointer' },
        h('span', { class: 'grow mono', text: fd.field || '(no field)' }),
        h('span', { class: 'chip', text: (fd.input && fd.input.kind) || 'text' }),
        h('button', { class: 'x', text: '↑', title: 'Move up', disabled: i === 0, onclick: (e) => { e.preventDefault(); mutate(() => { flds.splice(i - 1, 0, flds.splice(i, 1)[0]); }, { panel: true }); } }),
        h('button', { class: 'x', text: '×', title: 'Remove', onclick: (e) => { e.preventDefault(); mutate(() => flds.splice(i, 1), { panel: true }); } })));
      det.append(h('div', { class: 'grid2' },
        F('Field', bound(() => fd.field, (v) => { fd.field = v.trim(); }, { mono: true, key: kp + '.fn', onChange: true, panel: true })),
        F('Label', bound(() => fd.label, (v) => setOrDelete(fd, 'label', v), { key: kp + '.lb' }))));
      det.append(F('Question', bound(() => fd.prompt, (v) => setOrDelete(fd, 'prompt', v), { key: kp + '.pq', placeholder: (fd.label || 'Field') + ' for {{item}} {{n}}?' })));
      if (n.allowEdit !== false) det.append(F('Question when changing it (optional)', bound(() => fd.editPrompt, (v) => setOrDelete(fd, 'editPrompt', v),
        { key: kp + '.ep', placeholder: (fd.label || 'Field') + ' is currently …. What should it be?' })));
      det.append(noteEditor(fd, kp), answerEditor(fd, kp), validatorsEditor(fd, kp));
      wrap.append(det);
    });
    wrap.append(h('button', { class: 'lnk', text: '+ Add question', onclick: () => mutate(() => {
      n.fields = flds;
      let k = 1; while (flds.some((x) => x.field === 'field_' + k)) k++;
      flds.push({ field: 'field_' + k, label: 'Field ' + k, input: { kind: 'text' } });
      openFieldCards.add(n.id + '.rf' + (flds.length - 1));
    }, { panel: true }) }));

    const pp = () => (n.prompts = n.prompts || {});
    const msg = (key, label, ph) => F(label, bound(() => (n.prompts || {})[key], (v) => { setOrDelete(pp(), key, v); if (!Object.keys(n.prompts).length) delete n.prompts; },
      { key: n.id + '.p.' + key, placeholder: ph }));
    wrap.append(h('details', { class: 'adv' }, h('summary', { text: 'Advanced: buttons & messages' }),
      h('div', { class: 'grid2' },
        F('Add button', bound(() => n.addLabel, (v) => setOrDelete(n, 'addLabel', v), { key: n.id + '.al', placeholder: 'Add another' })),
        F('Done button', bound(() => n.doneLabel, (v) => setOrDelete(n, 'doneLabel', v), { key: n.id + '.dl', placeholder: 'Done' })),
        F('Edit button', bound(() => n.editLabel, (v) => setOrDelete(n, 'editLabel', v), { key: n.id + '.el', placeholder: 'Edit' })),
        F('Save button (when changing an item)', bound(() => n.saveLabel, (v) => setOrDelete(n, 'saveLabel', v), { key: n.id + '.sl', placeholder: 'Save' }))),
      msg('added', 'After adding an item', 'Added {{title}}.'),
      msg('menu', 'Between items', 'Add another {{item}}, or tap Done.'),
      msg('tooFew', 'Too few items', 'Please add at least {{min}}.'),
      msg('full', 'Maximum reached', "That's the most I can take ({{max}}). Tap Done to continue."),
      msg('editing', 'When Edit is tapped', 'Changing {{title}}. Pick a field to change, then tap {{save}}.'),
      msg('updated', 'After saving a changed item', 'Updated {{title}}.'),
      msg('unchanged', 'Saved with no change', 'No changes to {{title}}.'),
      checkbox('Skip if the list already has items (e.g. from a lookup)', n.skipIfFilled, (c) => mutate(() => setOrDelete(n, 'skipIfFilled', c || null)))));
    wrap.append(bindingEditor(n.slot));
    return wrap;
  }

  function bulkEditor(n) {
    const wrap = h('div');
    const ids = Object.keys(catalog());
    const srcOpts = [['', '— choose a data source —']].concat(ids.map((s) => [s, s]));
    if (n.source && ids.indexOf(n.source) < 0) srcOpts.push([n.source, n.source + ' (not in catalog)']);
    const src = sourceDef(n.source);
    wrap.append(h('div', { class: 'grid2' },
      F('Data source', sel(srcOpts, n.source || '', (v) => mutate(() => setOrDelete(n, 'source', v), { panel: true }), { mono: true })),
      F('Maximum records', bound(() => n.maxRows, (v) => setOrDelete(n, 'maxRows', numOrNull(v)), { type: 'number', key: n.id + '.mr', placeholder: '50' }),
        'More matches than this go to "too many". Up to 500.')));

    wrap.append(h('h4', { class: 'sub', text: 'Which records' }));
    wrap.append(F(null, sel([['criteria', 'Records matching search criteria'], ['mine', "The signed-in user's records (row filter)"]],
      n.byRowFilter ? 'mine' : 'criteria', (v) => mutate(() => {
        if (v === 'mine') { n.byRowFilter = true; delete n.criteria; } else { delete n.byRowFilter; n.criteria = n.criteria || []; }
      }, { panel: true }))));
    if (!n.byRowFilter) {
      const crit = n.criteria || [];
      const fOpts = [['', 'field…']].concat((src ? src.fields.filter((x) => x.searchable) : []).map((x) => [x.field, x.field]));
      const sOpts = [['', 'value…']].concat(critValues(n).map((x) => [x, x]));
      crit.forEach((c, i) => {
        wrap.append(h('div', { class: 'rowx' },
          sel(fOpts.concat(c.field && !fOpts.some((o) => o[0] === c.field) ? [[c.field, c.field]] : []), c.field || '', (v) => mutate(() => { c.field = v; }), { mono: true }),
          sel([['eq', '='], ['starts', 'starts'], ['contains', 'contains'], ['gte', '≥'], ['lte', '≤']], c.op || 'eq', (v) => mutate(() => { c.op = v; })),
          sel(sOpts.concat(c.slot && !sOpts.some((o) => o[0] === c.slot) ? [[c.slot, c.slot]] : []), c.slot || '', (v) => mutate(() => { c.slot = v; }), { mono: true }),
          h('button', { class: 'x', text: '×', title: 'Remove', onclick: () => mutate(() => crit.splice(i, 1), { panel: true }) })));
      });
      wrap.append(h('button', { class: 'lnk', text: '+ Add criterion', onclick: () => mutate(() => { n.criteria = crit; crit.push({ field: '', op: 'eq', slot: '' }); }, { panel: true }) }));
    }

    wrap.append(h('h4', { class: 'sub', text: 'Set' }),
      h('p', { class: 'hint', text: 'The new value of each field, the same for every record: a fixed value, or an earlier answer.' }));
    n.set = n.set || {};
    const upd = (src ? src.fields.filter((x) => x.updatable) : []).map((x) => x.field);
    Object.keys(n.set).forEach((k) => {
      const v = n.set[k] && typeof n.set[k] === 'object' ? n.set[k] : { value: n.set[k] };
      const fromSlot = 'slot' in v;
      wrap.append(h('div', { class: 'rowx' },
        h('span', { class: 'mono grow', text: k }),
        sel([['value', 'fixed value'], ['slot', 'from answer']], fromSlot ? 'slot' : 'value', (m) => mutate(() => {
          n.set[k] = m === 'slot' ? { slot: '', label: v.label } : { value: '', label: v.label };
          if (!n.set[k].label) delete n.set[k].label;
        }, { panel: true })),
        fromSlot
          ? sel([['', 'answer…']].concat(knownSlots().map((x) => [x, x])), v.slot || '', (s) => mutate(() => { v.slot = s; n.set[k] = v; }), { mono: true })
          : bound(() => v.value, (s) => { v.value = s; n.set[k] = v; }, { key: n.id + '.sv.' + k, placeholder: 'new value' }),
        h('button', { class: 'x', text: '×', title: 'Remove', onclick: () => mutate(() => { delete n.set[k]; }, { panel: true }) })));
    });
    const left = upd.filter((x) => !(x in n.set));
    if (left.length) {
      wrap.append(F('Add a field to set', sel([['', '+ field…']].concat(left.map((x) => [x, x])), '', (v) => {
        if (v) mutate(() => { n.set[v] = { value: '', label: humanize(v) }; }, { panel: true });
      }, { mono: true })));
    } else if (!src) {
      wrap.append(h('p', { class: 'hint', text: 'Choose a data source to pick its updatable fields.' }));
    }

    const card = n.card = n.card || {};
    wrap.append(h('h4', { class: 'sub', text: 'Confirmation' }),
      h('div', { class: 'grid2' },
        F('Record title', bound(() => card.title, (v) => setOrDelete(card, 'title', v), { key: n.id + '.ct', placeholder: '{{reference}}' }), 'Shown for the first 10 records.'),
        F('Record subtitle', bound(() => card.subtitle, (v) => setOrDelete(card, 'subtitle', v), { key: n.id + '.cs', placeholder: '{{status}}' })),
        F('Confirm button', bound(() => n.confirmLabel, (v) => setOrDelete(n, 'confirmLabel', v), { key: n.id + '.cl', placeholder: 'Update {{count}}' })),
        F('Cancel button', bound(() => n.cancelLabel, (v) => setOrDelete(n, 'cancelLabel', v), { key: n.id + '.xl', placeholder: 'Cancel' }))));
    const pp = () => (n.prompts = n.prompts || {});
    const msg = (key, label, ph) => F(label, bound(() => (n.prompts || {})[key], (v) => { setOrDelete(pp(), key, v); if (!Object.keys(n.prompts).length) delete n.prompts; },
      { multiline: true, rows: 2, key: n.id + '.p.' + key, placeholder: ph }));
    wrap.append(msg('confirm', 'Question', 'This will set {{changes}} on {{count}} {{records}}. Do you want to go ahead?'),
      msg('done', 'After updating', 'Done. I updated {{updated}} of {{count}} records.'),
      msg('none', 'Nothing matches', "I couldn't find any matching records."),
      h('div', { class: 'card' }, h('div', { class: 'hint', style: 'margin:0' },
        'Nothing changes until the user confirms. Each record is then read again and updated with its own version through the data source, ',
        'so the updatable fields and the row filter apply to every row. The record keys never reach the browser, and the result is written to FC_EVENTS.')));
    return wrap;
  }

  function verifyEditor(n) {
    const asks = askSlots();
    const slotOpts = [['', '— choose an answer —']].concat(asks.map((s) => [s, s]));
    if (n.slot && asks.indexOf(n.slot) < 0) slotOpts.push([n.slot, n.slot + ' (not asked)']);
    const pr = () => (n.prompts = n.prompts || {});
    const prompt = (key, label, ph, hint) => F(label, bound(() => (n.prompts || {})[key], (v) => { setOrDelete(pr(), key, v); if (!Object.keys(n.prompts).length) delete n.prompts; },
      { multiline: true, rows: 2, key: n.id + '.p.' + key, placeholder: ph }), hint);
    return h('div', null,
      h('div', { class: 'grid2' },
        F('Send the code to', sel(slotOpts, n.slot || '', (v) => mutate(() => setOrDelete(n, 'slot', v), { panel: true }), { mono: true }),
          'An earlier answer, usually the email or phone.'),
        F('Channel', sel([['email', 'Email'], ['sms', 'SMS']], n.channel || 'email', (v) => mutate(() => { n.channel = v; })),
          'Passed to the connector.')),
      F('Connector id', connectorInput(() => n.connector, (v) => setOrDelete(n, 'connector', v.trim()), n.id + '.conn'),
        'Delivers the code. Receives {"channel", "to", "code", "ttlMinutes"} and returns {"ok": true} or {"ok": false, "message": "…"}.'),
      h('div', { class: 'grid2' },
        F('Code length', bound(() => n.codeLength, (v) => setOrDelete(n, 'codeLength', numOrNull(v)), { type: 'number', key: n.id + '.len', placeholder: '6' })),
        F('Expires after (minutes)', bound(() => n.ttlMinutes, (v) => setOrDelete(n, 'ttlMinutes', numOrNull(v)), { type: 'number', key: n.id + '.ttl', placeholder: '10' })),
        F('Wrong codes allowed', bound(() => n.maxAttempts, (v) => setOrDelete(n, 'maxAttempts', numOrNull(v)), { type: 'number', key: n.id + '.att', placeholder: '3' })),
        F('New codes allowed', bound(() => n.maxResends, (v) => setOrDelete(n, 'maxResends', numOrNull(v)), { type: 'number', key: n.id + '.rs', placeholder: '2' }))),
      h('h4', { class: 'sub', text: 'Messages' }),
      prompt('sent', 'After sending', "I've sent a {{codeLength}}-digit code to {{" + (n.slot || 'email') + "}}. Please enter it here.",
        'Placeholders: {{codeLength}}, {{ttlMinutes}} and any answer.'),
      prompt('wrong', 'Wrong code', "That code isn't right. You have {{remaining}} more {{tries}}."),
      prompt('success', 'When verified', '(none)'),
      prompt('locked', 'Too many wrong codes', "That's too many wrong codes, so I can't continue."),
      h('div', { class: 'card' }, h('div', { class: 'hint', style: 'margin:0' },
        'Only a salted hash of the code is stored, and it is never shown in the chat or written to FC_EVENTS. ',
        'Once verified, the value is passed to data sources (bind ', h('code', { text: ':FC_VERIFIED' }),
        ' in a row filter), and changing the answer afterwards needs a new code. In the Test tab the code is shown in a pop-up message.')));
  }

  function saveEditor(n) {
    return h('div', null,
      F('Record', recordSelect(n, 'record')),
      F('Message after saving', bound(() => n.savedText, (v) => setOrDelete(n, 'savedText', v), { key: n.id + '.st', placeholder: '(none)' })),
      F('Conflict message', bound(() => n.conflictText, (v) => setOrDelete(n, 'conflictText', v), { multiline: true, rows: 2, key: n.id + '.cft',
        placeholder: 'Someone else changed this record after you opened it…' })),
      h('div', { class: 'card' }, h('div', { class: 'hint', style: 'margin:0' },
        'Re-validates every changed field, then updates only those columns, guarded by the record version. ',
        'Fields not marked updatable in the data source are refused by the server whatever the flow says. ',
        'Each save is written to FC_EVENTS with before/after values.')));
  }

  function edgePanel() {
    const n = byId(S.sel.from);
    const p = ports(n).find((x) => x.key === S.sel.port);
    const t = getPort(n, S.sel.port);
    return h('div', null,
      h('div', { class: 'ptitle', text: 'Connection' }),
      h('p', { class: 'pdesc' }, h('b', { class: 'mono', text: n.id }), ' → ', h('b', { class: 'mono', text: t }), ' when ', h('i', { text: p ? p.label : S.sel.port })),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', text: 'Select source', onclick: () => select({ kind: 'node', id: n.id }) }),
        h('button', { class: 'btn', text: 'Select target', onclick: () => select({ kind: 'node', id: t }) }),
        h('button', { class: 'btn danger', text: 'Delete connection', onclick: deleteSelection })));
  }

  function flowSettings() {
    const f = S.flow;
    const idIn = h('input', { class: 'in mono', value: f.flowId || '' });
    idIn.addEventListener('change', () => {
      const v = idIn.value.trim();
      if (!/^[a-z0-9_]{1,100}$/.test(v)) { toast('Flow id: lowercase letters, digits and _.'); idIn.value = f.flowId || ''; return; }
      mutate(() => { f.flowId = v; });
    });
    const wrap = h('div', null,
      h('div', { class: 'ptitle', text: 'Flow settings' }),
      h('p', { class: 'pdesc', text: 'Select a node on the canvas to edit it. Drag from a node\'s bottom dots to connect steps.' }),
      h('div', { class: 'grid2' }, F('Flow id', idIn), F('Version', h('input', { class: 'in', value: f.version || 1, disabled: true }), 'Set when published')),
      F('Name', bound(() => f.name, (v) => setOrDelete(f, 'name', v), { key: 'flow.name' })),
      F('Start node', sel([['', '—']].concat(f.nodes.map((n) => [n.id, n.id + '  (' + TYPES[n.type].label + ')'])), f.start, (v) => mutate(() => { f.start = v; }), { mono: true })));

    wrap.append(h('h4', { class: 'sub', text: 'Context variables' }),
      h('p', { class: 'hint' }, 'Values the page passes in, e.g. ', h('code', { text: '<flow-chat context="dept:P10_DEPT,emp_id:P10_EMP_ID">' }),
        '. Each one fills the field of the same name and can be used as ', h('code', { text: '{{dept}}' }), ' or ', h('code', { text: '{{context.dept}}' }),
        ' in messages, conditions, searches and Set values. They come from the browser, so never use them to decide what a user may see.'));
    const ctxTbl = h('table', { class: 'cov' }, h('tr', null, h('th', { text: 'Name' }), h('th', { text: 'Test value' }), h('th')));
    contextNames().forEach((name, i) => {
      const k = 'ctx:' + name;
      const tv = h('input', { class: 'in', value: S.mocks[k] !== undefined ? S.mocks[k] : '', placeholder: '(Test tab only)' });
      tv.addEventListener('change', () => { if (tv.value === '') delete S.mocks[k]; else S.mocks[k] = tv.value; save(); S.testStale = true; updateTestNote(); });
      ctxTbl.append(h('tr', null, h('td', { class: 'mono', text: name }), h('td', null, tv),
        h('td', null, h('button', { class: 'x', text: '×', title: 'Remove', onclick: () => mutate(() => {
          f.context.splice(i, 1); if (!f.context.length) delete f.context;
        }, { panel: true }) }))));
    });
    const newCtx = h('input', { class: 'in mono', placeholder: 'new_name' });
    const addCtx = () => {
      const v = newCtx.value.trim();
      if (!/^[a-z][a-z0-9_]{0,99}$/.test(v)) { toast('Names: lowercase letters, digits and _, starting with a letter.'); return; }
      if (v === BUILTIN_USER) { toast('"' + BUILTIN_USER + '" is set by the server.'); return; }
      if (contextNames().indexOf(v) >= 0) { toast('"' + v + '" is already declared.'); return; }
      mutate(() => { f.context = (f.context || []).concat([v]); }, { panel: true });
    };
    newCtx.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCtx(); } });
    ctxTbl.append(h('tr', null, h('td', null, newCtx), h('td', null, h('button', { class: 'lnk', text: '+ Add', onclick: addCtx })), h('td')));
    wrap.append(ctxTbl);

    wrap.append(h('h4', { class: 'sub', text: 'Logging' }),
      checkbox('Debug logging: write every step, branch, connector call and search to FC_EVENTS (direction DBG)', f.debug,
        (c) => mutate(() => setOrDelete(f, 'debug', c || null))),
      F('PII answers', bound(() => (f.piiSlots || []).join(', '), (v) => {
        const list = v.split(',').map((x) => x.trim()).filter(Boolean);
        if (list.length) f.piiSlots = list; else delete f.piiSlots;
      }, { mono: true, key: 'flow.pii', placeholder: 'e.g. ssn, salary', onChange: true }),
        'Answers set by lookups or page context that logs must redact. For asked questions, use "In logs" on the question instead.'),
      F('Resume message', bound(() => f.resumeText, (v) => setOrDelete(f, 'resumeText', v), { key: 'flow.resume',
        placeholder: "Welcome back. Let's carry on where we left off." }),
        'Shown when <flow-chat resume> picks the conversation up again after a page reload.'));

    wrap.append(h('h4', { class: 'sub', text: 'Form bindings' }),
      h('p', { class: 'hint', text: 'Where each captured value is mirrored on the host page. Asked fields can also be bound from their Ask node.' }));
    const tbl = h('table', { class: 'cov' }, h('tr', null, h('th', { text: 'Field' }), h('th', { text: 'APEX item' }), h('th', { text: 'DOM selector' }), h('th')));
    const all = knownSlots();
    all.forEach((s) => {
      const b = f.bindings[s] || {};
      const upd = (k, v) => { const cur = f.bindings[s] = f.bindings[s] || {}; setOrDelete(cur, k, v); if (!Object.keys(cur).length) delete f.bindings[s]; };
      tbl.append(h('tr', null,
        h('td', { class: 'mono', text: s }),
        h('td', null, bound(() => b.apex, (v) => upd('apex', v.trim().toUpperCase()), { mono: true, key: 'bind.apex.' + s, onChange: true })),
        h('td', null, bound(() => b.dom, (v) => upd('dom', v.trim()), { mono: true, key: 'bind.dom.' + s })),
        h('td', null, askSlots().indexOf(s) < 0 ? h('button', { class: 'x', text: '×', title: 'Remove binding', onclick: () => mutate(() => delete f.bindings[s], { panel: true }) }) : null)));
    });
    wrap.append(tbl);
    const newIn = h('input', { class: 'in mono', placeholder: 'field set by a connector, e.g. reference' });
    wrap.append(h('div', { class: 'rowx', style: 'margin-top:8px' }, newIn, h('button', { class: 'btn', text: 'Add', onclick: () => {
      const v = newIn.value.trim();
      if (!/^[a-z][a-z0-9_]{0,99}$/.test(v)) { toast('Field names: lowercase letters, digits and _.'); return; }
      if (all.indexOf(v) >= 0) { toast('That field already exists.'); return; }
      if (v === BUILTIN_USER) { toast('{{' + BUILTIN_USER + '}} is built in: it is always the signed-in user, so it needs no field.'); return; }
      mutate(() => { f.bindings[v] = { dom: '#' + v }; }, { panel: true });
    } })));
    const nodesN = f.nodes.length, asks = askSlots().length;
    wrap.append(h('p', { class: 'hint', style: 'margin-top:16px', text: nodesN + ' nodes · ' + asks + ' questions · ' + Object.keys(connectorUses()).length + ' connectors' }));
    return wrap;
  }

  // ======================================================================== checklist tab
  function renderCheck() {
    const body = $('tab-check');
    if (S.tab !== 'check') return;
    body.textContent = '';
    const an = analyze();
    body.append(h('div', { class: 'ptitle', text: 'Problems' }));
    if (!an.list.length) body.append(h('div', { class: 'allgood', text: 'No problems found. The flow is ready to test and publish.' }));
    an.list.forEach((p) => body.append(h('div', {
      class: 'prob ' + p.level, title: p.nodeId ? 'Select ' + p.nodeId : '',
      onclick: () => { if (p.nodeId) { select({ kind: 'node', id: p.nodeId }); centerOn(p.nodeId); } }
    }, h('span', { text: p.msg }), p.nodeId ? h('span', { class: 'where', text: p.nodeId }) : null)));

    const cv = an.coverage;
    body.append(h('h4', { class: 'sub', text: 'Field checklist' }),
      h('p', { class: 'hint', text: 'Is each field asked on every path to ' + cv.goal + '? (' + cv.paths + ' path' + (cv.paths === 1 ? '' : 's') + ' analysed)' }));
    const tbl = h('table', { class: 'cov' }, h('tr', null, h('th', { text: 'Field' }), h('th', { text: 'Asked in' }), h('th', { text: 'Coverage' }), h('th', { text: 'Bound to' })));
    const counts = repeatNodes().map((n) => n.slot + '.count');
    const setBy = setSlots(), ctxNames = contextNames(), menuBy = menuSlots();
    knownSlots().filter((s) => counts.indexOf(s) < 0).forEach((s) => {
      const askers = S.flow.nodes.filter((n) => (n.type === 'ask' || n.type === 'repeat') && n.slot === s).map((n) => n.id);
      const b = S.flow.bindings[s] || {};
      const c = cv.cov[s];
      const label = askers.length ? (c === 'always' ? 'every path' : c === 'sometimes' ? 'some paths' : 'unreachable')
        : /^context\./.test(s) ? 'page context'
        : menuBy.indexOf(s) >= 0 ? 'menu choice'
        : setBy.indexOf(s) >= 0 ? 'Set values'
        : ctxNames.indexOf(s) >= 0 ? 'page context'
        : (s.indexOf('.') > 0 ? 'from record' : 'set by connector');
      tbl.append(h('tr', null,
        h('td', { class: 'mono' }, s, b.required ? h('span', { title: 'Required on form', text: ' *' }) : null),
        h('td', { class: 'mono', text: askers.join(', ') || '—' }),
        h('td', null, h('span', { class: 'pill ' + (askers.length ? c : 'never'), text: label })),
        h('td', { class: 'mono', text: [b.apex, b.dom].filter(Boolean).join(' · ') || '—' })));
    });
    body.append(tbl);
  }

  function centerOn(id) {
    const n = byId(id), r = canvas.getBoundingClientRect();
    S.view.x = r.width / 2 - (n.ui.x + nodeWidth(n) / 2) * S.view.z;
    S.view.y = r.height / 3 - n.ui.y * S.view.z;
    applyView();
  }

  // ======================================================================== test tab
  let testEngine = null;
  const ROLE_PRESETS = {
    validator: [['Accept', { valid: true }], ['Reject', { valid: false, message: 'Rejected by the test mock.' }]],
    lookup: [['Not found', { found: false }], ['Found', { found: true, slots: {}, message: 'I found a matching record.' }]],
    submit: [['Success', { ok: true, slots: { reference: 'TEST-0001' } }], ['Failure', { ok: false, message: 'Test failure from the mock.' }]],
    sender: [['Sent', { ok: true }], ['Sending fails', { ok: false, message: "Sorry, I couldn't send the code." }]],
    mailer: [['Sent', { ok: true }], ['Sending fails', { ok: false, message: "Sorry, I couldn't send the email." }]],
    poster: [['Posted', { ok: true }], ['Posting fails', { ok: false, message: "Sorry, I couldn't post to Teams." }]]
  };
  // Agent test doubles: the Test tab never calls a real model. Each agent replays a script of steps,
  // {"tool": name, "args": {...}} or {"reply": "text"}; its tools return the JSON mocks below.
  const agentNodes = () => S.flow.nodes.filter((n) => n.type === 'agent');
  function agentToolIds() {
    const out = [];
    agentNodes().forEach((n) => (n.tools || []).forEach((t) => { if (out.indexOf(t) < 0) out.push(t); }));
    return out;
  }
  function defaultScript(n) {
    const steps = (n.outputs || []).slice(0, 3).map((o) => ({ tool: 'ask_user', args: { question: (o.label || o.name) + '?', field: o.name } }));
    steps.push({ tool: 'finish', args: { fields: {}, message: 'All set (test script).' } });
    return JSON.stringify(steps, null, 2);
  }
  const scriptFor = (n) => (S.mocks['agent:' + n.id] !== undefined ? S.mocks['agent:' + n.id] : defaultScript(n));
  const toolReg = (id) => (aiCat().tools || []).find((t) => t.id === id) || {};
  const toolMockFor = (id) => (S.mocks['tool:' + id] !== undefined ? S.mocks['tool:' + id]
    : JSON.stringify(toolReg(id).type === 'search' ? { rows: [{ id: 1, name: 'Example record' }, { id: 2, name: 'Another record' }] }
      : toolReg(id).type === 'rest' ? { status: 200, data: {} } : { ok: true }, null, 2));
  function testAi() {
    const providers = {}, tools = {}, skills = {}, cursor = {};
    agentNodes().forEach((n) => {
      if (!n.provider) return;
      providers[n.provider] = (req) => {
        const node = agentNodes().find((x) => x.id === req.nodeId);
        let steps;
        try { steps = JSON.parse(scriptFor(node)); } catch (e) { throw new Error('The test script for agent "' + req.nodeId + '" is not valid JSON.'); }
        if (req.messages.length <= 2) cursor[req.nodeId] = 0;               // the agent started afresh
        const st = steps[cursor[req.nodeId] = (cursor[req.nodeId] || 0)];
        cursor[req.nodeId]++;
        if (!st) return { content: null, tool_calls: [{ id: 'end', type: 'function', function: { name: 'give_up', arguments: '{"reason":"the test script ended"}' } }] };
        if (st.tool) return { content: st.say || null, tool_calls: [{ id: 'c' + cursor[req.nodeId], type: 'function', function: { name: st.tool, arguments: JSON.stringify(st.args || {}) } }] };
        return { content: String(st.reply || '') };
      };
    });
    agentToolIds().forEach((id) => {
      const reg = toolReg(id);
      // a search tool (or any tool not in the registry) can feed pick_record: its mock returns {"rows": [...]}
      tools[id] = { description: reg.description || id, type: 'connector', target: 'tool:' + id,
                    write: reg.id ? !!reg.write : S.mocks['toolw:' + id] === '1',
                    pick: reg.id ? reg.type === 'search' : true, title: reg.titleTemplate, subtitle: reg.subtitleTemplate };
    });
    agentNodes().forEach((n) => (n.skills || []).forEach((id) => {
      const reg = (aiCat().skills || []).find((x) => x.id === id) || {};
      skills[id] = { name: reg.name || id, description: reg.description || id, content: '(In the database this is the FC_AI_SKILLS text.)' };
    }));
    return { providers, tools, skills };
  }

  // REST call test doubles: Test never calls the API; each REST node answers with its mock.
  const restNodes = () => S.flow.nodes.filter((n) => n.type === 'rest');
  function defaultRestMock(n) {
    const body = {};
    Object.keys(n.map || {}).forEach((k) => {
      const parts = String(n.map[k] || '$').replace(/^\$\.?/, '').split('.').filter(Boolean);
      if (!parts.length || /\[/.test(n.map[k])) return;
      let cur = body;
      parts.forEach((p, i) => { if (i === parts.length - 1) cur[p] = 'test ' + k; else cur = cur[p] = (cur[p] && typeof cur[p] === 'object') ? cur[p] : {}; });
    });
    return JSON.stringify({ status: 200, body }, null, 2);
  }
  const restMockFor = (n) => (S.mocks['rest:' + n.id] !== undefined ? S.mocks['rest:' + n.id] : defaultRestMock(n));
  function testRest(req) {
    const n = restNodes().find((x) => x.id === req.nodeId);
    let r;
    try { r = JSON.parse(restMockFor(n)); } catch (e) { throw new Error('The test mock for REST call "' + req.nodeId + '" is not valid JSON.'); }
    if (r && r.error) throw new Error(String(r.error));
    toast('Test REST call (not sent): ' + req.method + ' ' + req.endpoint + req.path + (req.body !== undefined ? ' with ' + JSON.stringify(req.body).slice(0, 120) : '') +
      ' → ' + (r.status || 200), 6000);
    return { status: r.status || 200, body: r.body === undefined ? null : r.body };
  }

  // Workflow test doubles: Test never starts a workflow; each Workflow node answers with its mock.
  const workflowNodes = () => S.flow.nodes.filter((n) => n.type === 'workflow');
  const workflowMockFor = (n) => (S.mocks['wf:' + n.id] !== undefined ? S.mocks['wf:' + n.id] : JSON.stringify({ workflowId: 1001 }, null, 2));
  function testWorkflow(req) {
    const n = workflowNodes().find((x) => x.id === req.nodeId);
    let r;
    try { r = JSON.parse(workflowMockFor(n)); } catch (e) { throw new Error('The test mock for workflow "' + req.nodeId + '" is not valid JSON.'); }
    if (r && r.error) { const e = new Error(String(r.error)); e.userMessage = r.userMessage || null; throw e; }
    toast('Test workflow (not started): ' + req.workflow + ' with ' + (req.parameters.map((p) => p.name + '=' + (p.value === null ? '' : p.value)).join(', ') || 'no parameters') +
      (req.detailKey ? ', detail ' + req.detailKey : '') + ' → ' + r.workflowId, 7000);
    return r;
  }

  const mockFor = (id, role) => (S.mocks[id] !== undefined ? S.mocks[id] : JSON.stringify(ROLE_PRESETS[role][0][1], null, 2));

  let testSources = {};
  let testDebug = [];
  function renderMocks() {
    const box = $('mocks');
    box.textContent = '';
    const uses = connectorUses();
    const ids = Object.keys(uses);
    const srcs = sourceUses();
    const lvs = Object.keys(lovUses());
    const agents = agentNodes(), tids = agentToolIds(), rests = restNodes(), wfs = workflowNodes();
    if (!ids.length && !srcs.length && !lvs.length && !agents.length && !rests.length && !wfs.length) { box.append(h('p', { class: 'hint', text: 'This flow calls no connectors, data sources or lookup lists.' })); return; }
    const jsonArea = (get, key, rows, isArr) => {
      const ta = h('textarea', { class: 'in mono', rows, spellcheck: 'false' });
      ta.value = get();
      const check = () => { let ok = true; try { const v = JSON.parse(ta.value); ok = !isArr || Array.isArray(v); } catch (e) { ok = false; } ta.classList.toggle('bad', !ok); };
      ta.addEventListener('input', () => { S.mocks[key] = ta.value; check(); save(); });
      check();
      return ta;
    };
    wfs.forEach((n) => {
      const setWf = (v) => { if (v === null) delete S.mocks['wf:' + n.id]; else S.mocks['wf:' + n.id] = JSON.stringify(v, null, 2); save(); renderMocks(); };
      box.append(h('div', { class: 'card mock' },
        h('div', { class: 'card-h' }, h('span', { class: 'mono grow', text: n.id }), h('span', { class: 'chip', text: 'workflow ' + (n.workflow || '?') })),
        h('p', { class: 'hint', text: 'Test answers with this instead of starting the workflow: {"workflowId": 1001}, or {"error": "...", "userMessage": "..."} for a failure.' }),
        h('div', { class: 'rowx' },
          h('button', { class: 'btn', text: 'Starts', onclick: () => setWf(null) }),
          h('button', { class: 'btn', text: 'Fails', onclick: () => setWf({ error: 'ORA-01403: no data found' }) }),
          h('button', { class: 'btn', text: 'Raises a message', onclick: () => setWf({ error: 'ORA-20001: You already have a pending request.', userMessage: 'You already have a pending request.' }) })),
        jsonArea(() => workflowMockFor(n), 'wf:' + n.id, 4, false)));
    });
    rests.forEach((n) => {
      box.append(h('div', { class: 'card mock' },
        h('div', { class: 'card-h' }, h('span', { class: 'mono grow', text: n.id }), h('span', { class: 'chip', text: 'REST ' + (n.method || 'GET') + ' ' + (n.endpoint || '?') })),
        h('p', { class: 'hint', text: 'Test answers with this instead of calling the API: {"status": 200, "body": {...}}. Try 404, 500, or {"error": "timeout"}.' }),
        h('div', { class: 'rowx' },
          h('button', { class: 'btn', text: '200', onclick: () => { delete S.mocks['rest:' + n.id]; save(); renderMocks(); } }),
          h('button', { class: 'btn', text: '404', onclick: () => { S.mocks['rest:' + n.id] = JSON.stringify({ status: 404, body: { message: 'Not found' } }, null, 2); save(); renderMocks(); } }),
          h('button', { class: 'btn', text: '500', onclick: () => { S.mocks['rest:' + n.id] = JSON.stringify({ status: 500, body: { message: 'Server error' } }, null, 2); save(); renderMocks(); } }),
          h('button', { class: 'btn', text: 'Timeout', onclick: () => { S.mocks['rest:' + n.id] = JSON.stringify({ error: 'no answer within 20 seconds' }, null, 2); save(); renderMocks(); } })),
        jsonArea(() => restMockFor(n), 'rest:' + n.id, 6, false)));
    });
    agents.forEach((n) => {
      box.append(h('div', { class: 'card mock' },
        h('div', { class: 'card-h' }, h('span', { class: 'mono grow', text: n.id }), h('span', { class: 'chip', text: 'agent script' })),
        h('p', { class: 'hint', text: 'Test replays these steps instead of calling ' + (n.provider || 'the model') +
          ': {"tool": "ask_user" | "pick_record" | "set_field" | "finish" | "handoff" | "give_up" | "load_skill" | a tool id, "args": {...}} or {"reply": "text"}. In APEX the real model runs.' }),
        h('div', { class: 'rowx' }, h('button', { class: 'btn', text: 'Reset to default', onclick: () => { delete S.mocks['agent:' + n.id]; save(); renderMocks(); } })),
        jsonArea(() => scriptFor(n), 'agent:' + n.id, 8, true)));
    });
    tids.forEach((id) => {
      const reg = (aiCat().tools || []).find((t) => t.id === id);
      box.append(h('div', { class: 'card mock' },
        h('div', { class: 'card-h' }, h('span', { class: 'mono grow', text: id }), h('span', { class: 'chip', text: toolReg(id).type === 'rest' ? 'REST tool ' + (toolReg(id).method || 'GET') + ' ' + toolReg(id).target : 'agent tool' })),
        reg ? h('p', { class: 'hint', text: reg.write ? 'Writes data (FC_AI_TOOLS): the user confirms before it runs.' : 'Read only (FC_AI_TOOLS).' })
            : checkbox('Writes data (the user confirms before it runs)', S.mocks['toolw:' + id] === '1',
                       (c) => { if (c) S.mocks['toolw:' + id] = '1'; else delete S.mocks['toolw:' + id]; save(); }),
        jsonArea(() => toolMockFor(id), 'tool:' + id, 3, false)));
    });
    lvs.forEach((id) => {
      const card = h('div', { class: 'card mock' },
        h('div', { class: 'card-h' }, h('span', { class: 'mono grow', text: id }), h('span', { class: 'chip', text: 'lookup list' })));
      if (lovLive(id)) {
        card.append(h('p', { class: 'hint', text: 'Options come from FC_LOVS in the database (read only).' }));
      } else {
        if (BACKEND) card.append(h('p', { class: 'hint warn', text: !S.dbLovs
          ? 'The designer could not read FC_LOVS' + (lovError ? ' (' + lovError + ')' : '') + '. Check that FC_DESIGNER compiled. Until then the test uses the options below only if you edit them.'
          : 'Not in FC_LOVS (or not enabled). The test stops with an error unless you edit the options below.' }));
        card.append(h('button', { class: 'lnk', text: '↻ Reload from FC_LOVS', onclick: () => reloadLovs({ toast: true }) }));
        const ta = h('textarea', { class: 'in', rows: 5, spellcheck: 'false' });
        ta.value = lovMockText(id);
        const check = () => {
          let okay = true;
          try { okay = Array.isArray(JSON.parse(ta.value)); } catch (e) { okay = false; }
          ta.classList.toggle('bad', !okay);
        };
        ta.addEventListener('input', () => { S.mocks[lovMockKey(id)] = ta.value; check(); save(); });
        check();
        card.append(h('p', { class: 'hint', text: 'Test options: [{"value", "label"}]. A field named like a parameter (e.g. "country") limits a row to that value. Restart the test to apply changes.' }), ta);
      }
      box.append(card);
    });
    ids.forEach((id) => {
      const role = uses[id];
      const ta = h('textarea', { class: 'in', rows: 4, spellcheck: 'false' });
      ta.value = mockFor(id, role);
      const validate = () => { try { JSON.parse(ta.value); ta.classList.remove('bad'); } catch (e) { ta.classList.add('bad'); } };
      ta.addEventListener('input', () => { S.mocks[id] = ta.value; validate(); save(); });
      validate();
      box.append(h('div', { class: 'card mock' },
        h('div', { class: 'card-h' }, h('span', { class: 'mono grow', text: id }), h('span', { class: 'chip', text: role })),
        h('div', { class: 'rowx' }, ROLE_PRESETS[role].map(([label, val]) => h('button', {
          class: 'btn', text: label, onclick: () => { ta.value = JSON.stringify(val, null, 2); ta.dispatchEvent(new Event('input')); }
        }))),
        ta));
    });
    srcs.forEach((id) => {
      const src = sourceDef(id);
      const card = h('div', { class: 'card mock' },
        h('div', { class: 'card-h' }, h('span', { class: 'mono grow', text: id }), h('span', { class: 'chip', text: 'data source' })));
      if (!src) {
        card.append(h('p', { class: 'hint', text: 'Not in the catalog, so the test can\'t simulate it. Add it in the Data tab.' }));
      } else {
        const live = testSources[id];
        card.append(h('p', { class: 'hint', text: (live ? live.rows.length : (src.sampleRows || []).length) +
          ' sample row(s), reset on every test restart. Edit them in the Data tab.' }));
        const pre = h('pre', { class: 'state', 'data-src': id });
        pre.textContent = rowsText(id);
        card.append(h('div', { class: 'rowx' },
          h('button', { class: 'btn', text: 'Simulate another user editing the loaded record', onclick: () => bumpLoaded(id) }),
          h('button', { class: 'lnk', text: 'Edit rows →', onclick: () => { S.dataSel = id; setTab('data'); } })), pre);
      }
      box.append(card);
    });
  }

  function rowsText(id) {
    const live = testSources[id];
    const rows = live ? live.rows : (sourceDef(id) || {}).sampleRows || [];
    return rows.map((r) => JSON.stringify(r)).join('\n') || '(no rows)';
  }

  // Bump the version of the record the test conversation has loaded, like a concurrent save.
  function bumpLoaded(id) {
    const st = testEngine && testEngine.getState($('simChat').sessionId);
    const live = testSources[id];
    const rec = st && Object.values(st.records || {}).find((r) => r.source === id);
    if (!live || !rec) { toast('Load a record in the test chat first.'); return; }
    const row = live.rows.find((r) => String(r._key) === String(rec.key));
    if (!row) { toast('The loaded record is not in the sample rows.'); return; }
    if ('_version' in row) {
      row._version = Number(row._version || 1) + 1;   // a concurrent save: same data, newer version
    } else {
      // no version column: conflicts are detected on the original values of the changed fields
      const changed = Object.keys(recordChanges(rec));
      if (!changed.length) { toast('Change a field in the test chat first; without a version column only changed fields are checked.'); return; }
      const k = changed[0];
      row[k] = typeof row[k] === 'number' ? row[k] + 1 : String(row[k] == null ? '' : row[k]) + '*';
    }
    refreshTestPanels();
    toast('Another "user" saved ' + rec.key + '. Saving now will hit a conflict.');
  }
  function recordChanges(rec) {
    const out = {};
    Object.keys(rec.current || {}).forEach((k) => { if (String(rec.current[k]) !== String(rec.original[k])) out[k] = rec.current[k]; });
    return out;
  }

  function refreshTestPanels() {
    const st = testEngine && testEngine.getState($('simChat').sessionId);
    const view = st ? { answers: st.slots } : {};
    if (st && Object.keys(st.records || {}).length) {
      view.records = {};
      Object.keys(st.records).forEach((a) => {
        const r = st.records[a];
        view.records[a] = { key: r.key, version: r.version, changed: recordChanges(r), current: r.current };
      });
    }
    if (testDebug.length) {
      view.debug = testDebug.slice(-40).map((e) => {
        const { sessionId, flowId, version, at, ...rest } = e;
        return at.slice(11, 19) + ' ' + JSON.stringify(rest);
      });
    }
    $('simState').textContent = JSON.stringify(view, null, 2);
    ROOT.querySelectorAll('pre[data-src]').forEach((pre) => { pre.textContent = rowsText(pre.dataset.src); });
  }

  function buildTestSources() {
    testSources = {};
    sourceUses().forEach((id) => {
      const src = sourceDef(id);
      if (!src) return;
      const fields = {};
      (src.fields || []).forEach((f) => { fields[f.field] = { searchable: !!f.searchable, updatable: !!f.updatable, mask: f.mask || null }; });
      const rows = clone(src.sampleRows || []).map((r, i) => {
        const row = Object.assign({ _key: i + 1 }, r);
        if (src.versionColumn && row._version == null) row._version = 1;
        return row;
      });
      testSources[id] = FlowChatEngine.createMemorySource({ rows, key: '_key', versionField: src.versionColumn ? '_version' : null, fields,
        // The row filter is SQL and can't run here: the sample rows stand in for the rows it would return.
        rowFilter: String(src.rowFilter || '').trim() || src.sourceType === 'PLSQL' ? () => true : null });
    });
    return testSources;
  }

  // Database mode with the list registered: real options from FC_LOVS. Otherwise the test rows below.
  const lovMockKey = (id) => 'lov:' + id;
  function lovMockText(id) {
    const k = lovMockKey(id);
    if (S.mocks[k] !== undefined) return S.mocks[k];
    const rows = DEFAULT_LOV_ROWS[id] || [{ value: 'A', label: 'Option A' }, { value: 'B', label: 'Option B' }];
    return '[\n' + rows.map((r) => '  ' + JSON.stringify(r)).join(',\n') + '\n]';
  }
  function lovLive(id) { return !!(BACKEND && dbLov(id)); }
  function buildTestLovs() {
    const out = {};
    Object.keys(lovUses()).forEach((id) => {
      out[id] = async (req) => {
        if (BACKEND && !dbLov(id)) await reloadLovs({ quiet: true });   // added to FC_LOVS since the designer loaded?
        if (lovLive(id)) return BACKEND.call('lovOptions', { id, params: req.params });
        if (BACKEND && S.mocks[lovMockKey(id)] === undefined) {
          // Don't pretend: a list the database can't serve would fail the same way at runtime.
          if (!S.dbLovs) throw new Error('The designer could not read FC_LOVS' + (lovError ? ' (' + lovError + ')' : '') +
            '. Check that the FC_DESIGNER package compiled, or set test options for "' + id + '" in the Test tab.');
          throw new Error('Lookup list "' + id + '" is not in FC_LOVS, or is not enabled. Ids are case-sensitive; the database has: ' +
            (S.dbLovs.map((l) => l.id).join(', ') || 'none') + '.');
        }
        let rows;
        try { rows = JSON.parse(lovMockText(id)); } catch (e) { throw new Error('The test options for "' + id + '" are not valid JSON.'); }
        if (!Array.isArray(rows)) throw new Error('The test options for "' + id + '" must be a JSON array.');
        // A row field named like a parameter filters by it (e.g. "country" for :COUNTRY).
        return rows.filter((r) => Object.keys(req.params || {}).every((p) => !(p in r) || String(r[p]) === String(req.params[p])));
      };
    });
    return out;
  }

  function runTest() {
    const flow = clone(S.flow);
    const uses = connectorUses();
    const connectors = {};
    Object.keys(uses).forEach((id) => {
      connectors[id] = (p) => {
        const txt = mockFor(id, uses[id]);
        let res;
        try { res = JSON.parse(txt); } catch (e) { throw new Error('The test mock for "' + id + '" is not valid JSON.'); }
        // Verify: nothing is really sent in a test, so show the code to whoever is testing.
        if (uses[id] === 'sender' && res.ok !== false) toast('Test code for ' + p.to + ': ' + p.code, 12000);
        if (uses[id] === 'mailer' && res.ok !== false) showTestEmail(p);
        if (uses[id] === 'poster' && res.ok !== false) showTestPost(p);
        return res;
      };
    });
    agentToolIds().forEach((id) => {
      connectors['tool:' + id] = () => {
        try { return JSON.parse(toolMockFor(id)); } catch (e) { throw new Error('The test mock for tool "' + id + '" is not valid JSON.'); }
      };
    });
    const ai = testAi();
    // {{app_user}}: the designer's own APEX user when it runs inside APEX, else a stand-in.
    const appUser = (window.apex && apex.env && apex.env.APP_USER) || 'TEST_USER';
    testDebug = [];
    testEngine = FlowChatEngine.createEngine({ flows: [flow], connectors, dataSources: buildTestSources(), lovs: buildTestLovs(), appUser,
      sendEmail: (m) => { showTestEmail(m); return { ok: true }; }, postToTeams: (m) => { showTestPost(m); return { ok: true }; }, rest: testRest, startWorkflow: testWorkflow,
      aiProviders: ai.providers, aiTools: ai.tools, aiSkills: ai.skills,
      onDebug: flow.debug ? (e) => { testDebug.push(e); } : null });
    const chat = $('simChat');
    chat.setAttribute('flow', flow.flowId || 'draft');
    const testContext = {};
    contextNames().forEach((name) => { if (S.mocks['ctx:' + name] !== undefined) testContext[name] = S.mocks['ctx:' + name]; });
    chat.configure({ transport: new FlowChat.LocalTransport(testEngine), adapter: new FlowChat.NoneAdapter(), context: testContext });
    chat.start();
    S.testStale = false;
    updateTestNote();
    renderMocks();
    $('simState').textContent = '{}';
  }

  // Nothing is sent in a test: show the email that would go out.
  function showTestEmail(m) {
    const list = (a) => (a || []).join(', ');
    toast('Test email (not sent) to ' + list(m.to) + ': ' + m.subject, 8000);
    const d = modal('Test email (not sent)', { width: '520px' });
    const row = (k, v) => (v ? h('div', null, h('b', { text: k + ': ' }), v) : null);
    d.body.append(...[row('From', m.from || '(connector default)'), row('To', list(m.to)), row('Cc', list(m.cc)), row('Bcc', list(m.bcc)),
      row('Reply-to', m.replyTo), row('Subject', m.subject),
      row('Attachments', (m.attachments || []).map((a) => a.name).join(', ')),
      h('pre', { class: 'mono', style: 'white-space:pre-wrap;margin-top:8px', text: m.body || '' })].filter(Boolean));
    d.foot.append(h('button', { class: 'btn', text: 'Close', onclick: d.close }));
  }

  // Nothing is posted in a test: show the card that would go to the channel.
  function showTestPost(m) {
    toast('Test Teams post (not sent) to ' + m.channel + ': ' + (m.title || ''), 8000);
    const d = modal('Teams post (not sent)', { width: '520px' });
    const row = (k, v) => (v ? h('div', null, h('b', { text: k + ': ' }), v) : null);
    d.body.append(...[row('Channel', m.channel), row('Title', m.title), row('Colour', m.style !== 'default' ? m.style : ''),
      m.text ? h('pre', { class: 'mono', style: 'white-space:pre-wrap;margin:8px 0', text: m.text }) : null]
      .concat((m.facts || []).map((f) => row(f.title, f.value)), [row('Button', m.link ? (m.linkLabel || 'Open') + ' → ' + m.link : '')]).filter(Boolean));
    d.foot.append(h('button', { class: 'btn', text: 'Close', onclick: d.close }));
  }

  function updateTestNote() {
    const note = $('testNote');
    if (!testEngine) return;
    note.className = 'test-note' + (S.testStale ? ' stale' : '');
    note.textContent = S.testStale ? 'The draft changed since this test started. Restart to test the latest version.' : 'Testing the current draft.';
  }

  // ======================================================================== json tab
  function renderJson() { $('jsonText').value = JSON.stringify(S.flow, null, 2); }

  // ======================================================================== tabs / misc
  function setTab(tab) {
    S.tab = tab;
    ROOT.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    ['props', 'check', 'test', 'data', 'json'].forEach((t) => { $('tab-' + t).hidden = t !== tab; });
    if (tab === 'check') renderCheck();
    if (tab === 'json') renderJson();
    if (tab === 'data') renderData();
    if (tab === 'test') { renderMocks(); if (!testEngine) runTest(); }
  }

  // ======================================================================== database integration
  function clockTime() { const t = new Date(); return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'); }

  function renderDbStatus() {
    const el = $('dbStatus');
    if (!el || !BACKEND) return;
    el.hidden = false;
    const d = S.db;
    const label = (st) => (st === 'PUBLISHED' ? 'Published' : st === 'RETIRED' ? 'Retired' : 'Draft');
    let text, cls;
    if (!d.flowId) { text = 'Not in database'; cls = 'local'; }
    else if (d.dirty) { text = 'Unsaved changes (' + label(d.status).toLowerCase() + ' v' + d.version + ')'; cls = 'dirty'; }
    else { text = label(d.status) + ' v' + d.version + (d.savedAt ? ' · saved ' + d.savedAt : ''); cls = d.status === 'PUBLISHED' ? 'pub' : 'saved'; }
    if (d.flowId && S.flow && d.flowId !== S.flow.flowId) { text += ' · id changed'; cls = 'dirty'; }
    el.textContent = text;
    el.className = 'db-status ' + cls;
    el.title = d.flowId ? 'Database: ' + d.flowId + ' version ' + d.version + ' (' + d.status + ')' : 'This flow has not been saved to the database yet.';
  }

  async function saveToDb(publish, force) {
    if (publish) {
      const errs = analyze().list.filter((p) => p.level === 'error').length;
      if (errs) { toast('Fix the ' + errs + ' error(s) in the Checklist before publishing.', 4000); setTab('check'); return; }
    }
    const sameFlow = S.db.flowId && S.db.flowId === S.flow.flowId;
    const btns = [$('btnSaveDb'), $('btnPublishDb')];
    btns.forEach((b) => { b.disabled = true; });
    let retry = false;
    try {
      const res = await BACKEND.call(publish ? 'publish' : 'saveDraft',
        { definition: S.flow, baseVersion: sameFlow ? S.db.version : null, force: !!force });
      S.flow.version = res.version;
      S.db = { flowId: res.flowId, version: res.version, status: res.status, dirty: false, savedAt: clockTime() };
      save();
      renderDbStatus();
      toast(publish ? 'Published version ' + res.version + '. New conversations use it now.' : 'Draft saved as version ' + res.version + '.', 3500);
    } catch (e) {
      if (e.code === 'conflict' || e.code === 'exists') {
        retry = window.confirm(e.message + '\n\nSave your copy anyway? It becomes the newest version' +
          (e.code === 'conflict' ? ' (a newer draft by someone else would be replaced).' : '.'));
      } else {
        toast((publish ? 'Publish' : 'Save') + ' failed: ' + e.message, 8000);
      }
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
    if (retry) await saveToDb(publish, true);
  }

  async function openDialog() {
    const m = modal('Open a flow', { width: 'min(660px, 94vw)' });
    const filter = h('input', { class: 'in', placeholder: 'Filter by name or id…' });
    const list = h('div', { class: 'flow-list' }, h('p', { class: 'hint', text: 'Loading flows from the database…' }));
    m.body.append(filter, list);
    m.foot.append(
      h('button', { class: 'btn', text: 'Open a file instead…', onclick: () => { m.close(); $('fileInput').click(); } }),
      h('button', { class: 'btn', text: 'Cancel', onclick: m.close }));
    let flows;
    try { flows = await BACKEND.call('listFlows'); }
    catch (e) { list.textContent = ''; list.append(h('div', { class: 'prob error', text: 'Could not load flows: ' + e.message })); return; }
    const draw = () => {
      list.textContent = '';
      const q = filter.value.trim().toLowerCase();
      const shown = flows.filter((f) => !q || (f.flowId + ' ' + (f.name || '')).toLowerCase().indexOf(q) >= 0);
      if (!shown.length) list.append(h('p', { class: 'hint', text: flows.length ? 'No flow matches.' : 'No flows in the database yet. Design one and click Save draft.' }));
      shown.forEach((f) => {
        const vs = f.versions || [];
        const live = vs.find((v) => v.status === 'PUBLISHED');
        const latest = vs[0];
        const vsel = sel(vs.map((v) => [String(v.version), 'v' + v.version + ' · ' + String(v.status).toLowerCase() + ' · ' + (v.createdBy || '') + ' ' + (v.createdAt || '')]),
          latest ? String(latest.version) : '', () => {});
        vsel.style.maxWidth = '230px';
        const current = S.db.flowId === f.flowId;
        list.append(h('div', { class: 'flow-row' + (current ? ' current' : '') },
          h('div', { class: 'grow' },
            h('b', { text: f.name || f.flowId }), current ? h('span', { class: 'hint', text: '  (open now)' }) : null,
            h('div', { class: 'hint mono', text: f.flowId }),
            h('div', { class: 'badges' },
              live ? h('span', { class: 'pill always', text: 'live v' + live.version }) : h('span', { class: 'pill never', text: 'not published' }),
              latest && latest.status === 'DRAFT' ? h('span', { class: 'pill sometimes', text: 'draft v' + latest.version }) : null)),
          vsel,
          h('button', { class: 'btn primary', text: 'Open', onclick: () => openFromDb(f.flowId, Number(vsel.value), m) })));
      });
    };
    filter.addEventListener('input', draw);
    draw();
    filter.focus();
  }

  async function openFromDb(flowId, version, m) {
    if (S.db.dirty && !window.confirm('The current flow has unsaved changes. Open "' + flowId + '" anyway? (Undo brings the current flow back.)')) return;
    try {
      const r = await BACKEND.call('loadFlow', { flowId, version });
      if (m) m.close();
      testEngine = null;
      replaceFlow(checkShape(r.definition), 'Opened ' + flowId + ' v' + r.version + ' (' + String(r.status).toLowerCase() + ')',
        { flowId, version: r.version, status: r.status });
    } catch (e) { toast('Could not open: ' + e.message, 6000); }
  }

  // ---- data sources & connectors from the database
  function sourceSig(src) {
    return JSON.stringify({
      o: String(src.objectName || '').toUpperCase(), k: String(src.keyColumn || '').toUpperCase(),
      v: String(src.versionColumn || '').toUpperCase(), r: src.rowFilter || '',
      f: (src.fields || []).map((f) => [f.field, String(f.column || f.field).toUpperCase(), f.type || 'VARCHAR2',
        !!f.searchable, String(f.ops || 'eq').replace(/\s/g, ''), !!f.updatable, f.mask || ''])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    });
  }
  // 'saved' | 'modified' | 'local' (not in the database) | null (no back end)
  function dbSourceState(id) {
    if (!BACKEND || !S.dbCatalog) return null;
    if (!(id in S.dbCatalog)) return 'local';
    return catalog()[id] && S.dbCatalog[id] === sourceSig(catalog()[id]) ? 'saved' : 'modified';
  }

  async function loadDbMeta(opts) {
    if (!BACKEND) return;
    opts = opts || {};
    try {
      const res = await Promise.all([BACKEND.call('listSources'), BACKEND.call('listConnectors')]);
      const sources = res[0] || {}, cat = catalog(), prev = S.dbCatalog || {};
      S.dbCatalog = {};
      Object.keys(sources).forEach((id) => {
        const dbDef = sources[id], local = cat[id];
        S.dbCatalog[id] = sourceSig(dbDef);
        // Keep unsaved local edits (they show as "modified"); otherwise the database definition wins.
        const localEdited = local && !opts.overwrite && prev[id] !== undefined && sourceSig(local) !== prev[id];
        if (!localEdited) cat[id] = Object.assign(clone(dbDef), { sampleRows: (local && local.sampleRows) || [] });
      });
      S.dbConnectors = res[1] || [];
      // Older FC_DESIGNER packages have no listAi: then agent providers and tools aren't checked.
      try { S.ai = (await BACKEND.call('listAi')) || null; } catch (e) { S.ai = null; }
      // Older FC_DESIGNER packages have no listRest: then REST endpoints aren't checked.
      try { S.rest = (await BACKEND.call('listRest')) || null; } catch (e) { S.rest = null; }
      // Older FC_DESIGNER packages have no listLovs: then lookup lists simply aren't checked.
      try { S.dbLovs = (await BACKEND.call('listLovs')) || []; lovError = null; } catch (e) { S.dbLovs = null; lovError = e.message; }
      lovReloadAt = Date.now();
      save();
      renderCanvas();
      renderCheck();
      if (S.tab === 'data') renderData();
      if (opts.toast) toast('Reloaded ' + Object.keys(sources).length + ' data source(s) from the database.');
    } catch (e) {
      toast('Could not load data sources from the database: ' + e.message, 7000);
    }
  }

  async function saveSourceToDb(id) {
    const src = catalog()[id];
    if (!src.objectName || !src.keyColumn) { toast('Set the table and key column first.'); return; }
    try {
      const def = { objectName: src.objectName, keyColumn: src.keyColumn, versionColumn: src.versionColumn || null,
                    rowFilter: src.rowFilter || null, fields: src.fields || [] };
      const r = await BACKEND.call('saveSource', { id, def });
      S.dbCatalog = S.dbCatalog || {};
      S.dbCatalog[id] = sourceSig(src);
      save(); renderCheck(); renderData();
      if (r && r.warnings && r.warnings.length) toast('Saved "' + id + '" with warnings: ' + r.warnings.join(' '), 9000);
      else toast('Saved "' + id + '" to the database.');
    } catch (e) { toast('Could not save "' + id + '": ' + e.message, 7000); }
  }

  async function revertSource(id) {
    try {
      const sources = await BACKEND.call('listSources');
      if (!sources[id]) { toast('"' + id + '" is not in the database.'); return; }
      const cat = catalog();
      cat[id] = Object.assign(clone(sources[id]), { sampleRows: (cat[id] && cat[id].sampleRows) || [] });
      S.dbCatalog[id] = sourceSig(sources[id]);
      catalogChanged(true);
      toast('Reverted "' + id + '" to the database version.');
    } catch (e) { toast('Could not revert: ' + e.message, 6000); }
  }

  async function loadRowsFromDb(id) {
    try {
      const rows = await BACKEND.call('sampleRows', { id, limit: 20 });
      const src = catalog()[id];
      src.sampleRows = (rows || []).map((r) => Object.assign({ _key: r.key }, src.versionColumn ? { _version: r.version } : {}, r.values));
      catalogChanged(true);
      toast('Loaded ' + src.sampleRows.length + ' row(s) from the database for testing.');
    } catch (e) { toast('Could not load rows: ' + e.message, 6000); }
  }

  async function deleteSourceEverywhere(id) {
    const inDb = dbSourceState(id) && dbSourceState(id) !== 'local';
    const used = sourceUses().indexOf(id) >= 0;
    const msg = inDb ? 'Delete data source "' + id + '" from the DATABASE and the catalog? Published flows that use it are protected; drafts would break.'
                     : 'Delete "' + id + '" from the catalog?' + (used ? ' This flow uses it.' : '');
    if (!window.confirm(msg)) return;
    if (inDb) {
      try { await BACKEND.call('deleteSource', { id }); delete S.dbCatalog[id]; }
      catch (e) { toast('Not deleted: ' + e.message, 8000); return; }
    }
    delete catalog()[id];
    S.dataSel = null;
    catalogChanged(true);
  }

  function mapColumnType(dt) {
    const t = String(dt || '').toUpperCase();
    if (/^(NUMBER|FLOAT|INTEGER|BINARY_FLOAT|BINARY_DOUBLE)/.test(t)) return 'NUMBER';
    if (/^(DATE|TIMESTAMP)/.test(t)) return 'DATE';
    if (/^(VARCHAR2|NVARCHAR2|CHAR|NCHAR)/.test(t)) return 'VARCHAR2';
    return null;   // CLOB, BLOB, RAW, XMLTYPE ... are not supported by FC_DATA
  }

  async function createFromTable() {
    const m = modal('Create a data source from a table', { width: 'min(620px, 94vw)' });
    const q = h('input', { class: 'in', placeholder: 'Search tables and views…' });
    const list = h('div', { class: 'flow-list' });
    const detail = h('div');
    m.body.append(q, list, detail);
    m.foot.append(h('button', { class: 'btn', text: 'Cancel', onclick: m.close }));
    let timer;
    const search = async () => {
      list.textContent = '';
      list.append(h('p', { class: 'hint', text: 'Searching…' }));
      try {
        const tables = await BACKEND.call('listTables', { q: q.value.trim() });
        list.textContent = '';
        if (!tables.length) list.append(h('p', { class: 'hint', text: 'No tables or views match.' }));
        tables.forEach((t) => list.append(h('button', { class: 'flow-row pick-row', onclick: () => describe(t.name) },
          h('span', { class: 'grow mono', text: t.name }), h('span', { class: 'chip', text: t.type.toLowerCase() }))));
      } catch (e) { list.textContent = ''; list.append(h('div', { class: 'prob error', text: e.message })); }
    };
    const describe = async (name) => {
      detail.textContent = '';
      detail.append(h('p', { class: 'hint', text: 'Reading ' + name + '…' }));
      let t;
      try { t = await BACKEND.call('describeTable', { name }); }
      catch (e) { detail.textContent = ''; detail.append(h('div', { class: 'prob error', text: e.message })); return; }
      list.textContent = '';
      const cols = t.columns || [];
      const verGuess = cols.find((c) => /^(VERSION|ROW_VERSION|OBJECT_VERSION_NUMBER|REC_VERSION)$/.test(c.column) && mapColumnType(c.dataType) === 'NUMBER');
      const key = (t.pk && t.pk[0]) || (cols[0] && cols[0].column);
      let id = name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, '');
      while (catalog()[id]) id += '_2';
      const idIn = h('input', { class: 'in mono', value: id });
      const keySel = sel(cols.map((c) => [c.column, c.column]), key, () => {});
      const verSel = sel([['', '(none)']].concat(cols.filter((c) => mapColumnType(c.dataType) === 'NUMBER').map((c) => [c.column, c.column])), verGuess ? verGuess.column : '', () => {});
      const picks = cols.map((c) => {
        const type = mapColumnType(c.dataType);
        const cb = h('input', { type: 'checkbox', checked: !!type, disabled: !type });
        return { c, type, cb };
      });
      const syncVersion = () => picks.forEach((p) => {
        const isVer = p.c.column === verSel.value;
        if (isVer) p.cb.checked = false;
        p.cb.disabled = !p.type || isVer;
        p.cb.title = isVer ? 'Used as the version column' : '';
      });
      verSel.addEventListener('change', syncVersion);
      syncVersion();
      detail.textContent = '';
      detail.append(
        h('h4', { class: 'sub', text: name + (t.pk && t.pk.length ? '  ·  primary key ' + t.pk.join(', ') : '  ·  no primary key') }),
        h('div', { class: 'grid2' }, F('Data source id', idIn), F('Key column', keySel)),
        F('Version column', verSel, verGuess ? 'Guessed from the column name.' : 'Optional NUMBER column. Without it, conflicts are detected by comparing the original values.'),
        h('h4', { class: 'sub', text: 'Columns to expose as fields' }),
        h('div', { class: 'cols' }, picks.map((p) => h('label', { class: 'check', title: p.type ? '' : 'Type ' + p.c.dataType + ' is not supported' },
          p.cb, h('span', { class: 'mono', text: p.c.column }), h('span', { class: 'hint', text: ' ' + (p.type || p.c.dataType + ' (unsupported)') })))),
        h('p', { class: 'hint', text: 'Fields start as not searchable and not updatable. Choose those next in the Data tab, then Save to database.' }));
      const create = h('button', { class: 'btn primary', text: 'Create', onclick: () => {
        const sid = idIn.value.trim();
        if (!/^[a-z][a-z0-9_]{0,99}$/.test(sid)) { toast('Id: lowercase letters, digits and _, starting with a letter.'); return; }
        if (catalog()[sid]) { toast('"' + sid + '" already exists in the catalog.'); return; }
        const ver = verSel.value;
        catalog()[sid] = {
          objectName: name, keyColumn: keySel.value, versionColumn: ver, rowFilter: '',
          fields: picks.filter((p) => p.cb.checked && p.c.column !== ver).map((p) => ({
            field: p.c.column.toLowerCase(), column: p.c.column, type: p.type, searchable: false, ops: 'eq', updatable: false })),
          sampleRows: []
        };
        S.dataSel = sid;
        m.close();
        setTab('data');
        catalogChanged(true);
        toast('Created "' + sid + '". Mark searchable / updatable fields, then Save to database.', 5000);
      } });
      m.foot.textContent = '';
      m.foot.append(h('button', { class: 'btn', text: 'Back', onclick: () => { detail.textContent = ''; m.foot.textContent = ''; m.foot.append(h('button', { class: 'btn', text: 'Cancel', onclick: m.close })); search(); } }),
        create);
    };
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
    search();
    q.focus();
  }

  // ======================================================================== data tab (catalog)
  // The designer's copy of the server registry (FC_DATA_SOURCES / FC_DATA_SOURCE_FIELDS). Catalog edits
  // are saved with the draft but are not part of the flow, so they aren't in undo history.
  function catalogChanged(rerender) {
    save();
    if (!rerender) refreshDataState();
    renderCanvas();
    renderCheck();
    S.testStale = true;
    updateTestNote();
    if (rerender) renderData();
  }

  // Keep the Data tab's database pill and Save button current without re-rendering (keeps input focus).
  function refreshDataState() {
    if (S.tab !== 'data' || !S.dataSel) return;
    const st = dbSourceState(S.dataSel);
    const pill = $('srcState'), btn = $('btnSaveSource');
    const info = { saved: ['always', 'Saved in the database'], modified: ['sometimes', 'Changed here, not saved to the database'],
                   local: ['never', 'Only in this designer, not in the database'] }[st];
    if (pill && info) { pill.className = 'pill ' + info[0]; pill.textContent = info[1]; }
    if (btn) btn.disabled = st === 'saved';
  }

  function registrationSql(id, src) {
    const q = (v) => (v === null || v === undefined || v === '' ? 'null' : "'" + String(v).replace(/'/g, "''") + "'");
    const lines = [
      '-- Registers data source "' + id + '" (generated by FlowChat Designer ' + new Date().toISOString().slice(0, 10) + ')',
      'set define off',
      'delete from fc_data_sources where source_id = ' + q(id) + ';   -- fields cascade',
      'insert into fc_data_sources (source_id, source_type, object_name, key_column, version_column, row_filter)',
      '  values (' + [q(id), "'TABLE'", q(src.objectName), q(src.keyColumn), q(src.versionColumn), q(src.rowFilter)].join(', ') + ');'
    ];
    (src.fields || []).forEach((f) => {
      lines.push('insert into fc_data_source_fields (source_id, field, column_name, data_type, searchable, search_ops, updatable, mask)');
      lines.push('  values (' + [q(id), q(f.field), q(String(f.column || f.field).toUpperCase()), q(f.type || 'VARCHAR2'),
        q(f.searchable ? 'Y' : 'N'), q(f.ops || 'eq'), q(f.updatable ? 'Y' : 'N'), q(f.mask)].join(', ') + ');');
    });
    lines.push('commit;', '');
    return lines.join('\n');
  }

  function renderData() {
    const body = $('tab-data');
    if (S.tab !== 'data') return;
    body.textContent = '';
    const cat = catalog();
    const ids = Object.keys(cat);
    if (!S.dataSel || !cat[S.dataSel]) S.dataSel = ids[0] || null;
    const used = sourceUses();

    body.append(h('div', { class: 'ptitle', text: 'Data sources' }),
      h('p', { class: 'pdesc', text: 'The designer\'s copy of the server registry (FC_DATA_SOURCES). It drives the pickers and checks for Find record and Change fields, and its sample rows are used by the Test tab. "Registration SQL" creates the same definition on the server.' }));

    const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    fileIn.addEventListener('change', () => {
      const file = fileIn.files[0];
      if (!file) return;
      file.text().then((txt) => {
        const imp = JSON.parse(txt);
        if (!imp || typeof imp !== 'object' || Array.isArray(imp)) throw new Error('expected an object of data sources');
        Object.keys(imp).forEach((k) => { if (!imp[k] || !Array.isArray(imp[k].fields)) throw new Error('"' + k + '" has no fields array'); });
        Object.assign(cat, imp);
        S.dataSel = Object.keys(imp)[0] || S.dataSel;
        catalogChanged(true);
        toast('Imported ' + Object.keys(imp).length + ' data source(s)');
      }).catch((e) => toast('Could not import: ' + e.message));
    });
    body.append(fileIn, h('div', { class: 'rowx' },
      sel(ids.length ? ids.map((i) => [i, i + (used.indexOf(i) >= 0 ? '  (used in flow)' : '') + ({ local: '  · not in database', modified: '  · modified' }[dbSourceState(i)] || '')]) : [['', '(none)']],
        S.dataSel || '', (v) => { S.dataSel = v; renderData(); }, { mono: true }),
      h('button', { class: 'btn', text: '+ New', onclick: () => {
        const id = (window.prompt('Data source id (lowercase letters, digits, _):', 'my_source') || '').trim();
        if (!id) return;
        if (!/^[a-z][a-z0-9_]{0,99}$/.test(id)) { toast('Use lowercase letters, digits and _.'); return; }
        if (cat[id]) { toast('That id already exists.'); return; }
        cat[id] = { objectName: '', keyColumn: 'id', versionColumn: '', rowFilter: '',
                    fields: [{ field: 'id', column: 'ID', type: 'NUMBER', searchable: true, ops: 'eq', updatable: false }], sampleRows: [] };
        S.dataSel = id;
        catalogChanged(true);
      } })),
      h('div', { class: 'rowx', style: 'margin-top:4px' },
        h('button', { class: 'lnk', text: 'Import…', onclick: () => fileIn.click() }), h('span', { class: 'hint', text: '·' }),
        h('button', { class: 'lnk', text: 'Export catalog', onclick: () => download('flowchat-data-sources.json', JSON.stringify(cat, null, 2), 'application/json') }),
        BACKEND ? h('span', { class: 'hint', text: '·' }) : null,
        BACKEND ? h('button', { class: 'lnk', text: 'Create from table…', onclick: createFromTable }) : null,
        BACKEND ? h('span', { class: 'hint', text: '·' }) : null,
        BACKEND ? h('button', { class: 'lnk', text: 'Reload from database', onclick: () => loadDbMeta({ toast: true }) }) : null));

    if (!S.dataSel) { body.append(h('p', { class: 'hint', text: 'No data sources yet.' })); return; }
    const id = S.dataSel, src = cat[id];
    const set = (k) => (v) => { src[k] = v; catalogChanged(false); };
    const dbState = dbSourceState(id);
    if (dbState) {
      const info = { saved: ['always', 'Saved in the database'], modified: ['sometimes', 'Changed here, not saved to the database'],
                     local: ['never', 'Only in this designer, not in the database'] }[dbState];
      body.append(h('div', { class: 'rowx', style: 'margin-top:10px' }, h('span', { class: 'pill ' + info[0], text: info[1], id: 'fcd-srcState' }),
        dbState === 'modified' ? h('button', { class: 'lnk', text: 'Revert to database', onclick: () => revertSource(id) }) : null));
    }
    if (src.sourceType === 'PLSQL') {
      body.append(h('div', { class: 'card' }, h('div', { class: 'hint', style: 'margin:0',
        text: 'PL/SQL data source (' + [src.searchTarget, src.getTarget, src.updateTarget].filter(Boolean).join(', ') +
              '). Its functions are managed in the database; the fields below only drive the designer pickers and checks.' })));
    }
    const txt = (k, ph, mono) => {
      const el = h('input', { class: 'in' + (mono ? ' mono' : ''), placeholder: ph || '' });
      el.value = src[k] || '';
      el.addEventListener('change', () => set(k)(el.value.trim()));
      return el;
    };

    body.append(h('h4', { class: 'sub', text: 'Definition: ' + id }),
      F('Table or view', txt('objectName', 'schema.table', true)),
      h('div', { class: 'grid2' },
        F('Key column', txt('keyColumn', 'ID', true)),
        F('Version column', txt('versionColumn', '(optional)', true), 'NUMBER, incremented on update')),
      F('Row filter (trusted SQL)', (() => {
        const ta = h('textarea', { class: 'in mono', rows: 2, placeholder: "t.email = lower(:APP_USER)" });
        ta.value = src.rowFilter || '';
        ta.addEventListener('change', () => set('rowFilter')(ta.value.trim()));
        return ta;
      })(), 'Added to every search, load and update. :APP_USER is the signed-in APEX user. Not simulated in Test.'));

    body.append(h('h4', { class: 'sub', text: 'Fields' }));
    (src.fields || []).forEach((f, i) => {
      const fin = (k, ph, w) => {
        const el = h('input', { class: 'in mono', placeholder: ph, style: w ? 'max-width:' + w : null });
        el.value = f[k] || '';
        el.addEventListener('change', () => {
          const v = el.value.trim();
          if (k === 'field' && !/^[a-z][a-z0-9_]{0,99}$/.test(v)) { toast('Field names: lowercase letters, digits and _.'); el.value = f.field; return; }
          f[k] = k === 'column' ? v.toUpperCase() : v;
          catalogChanged(k === 'field');
        });
        return el;
      };
      const cb = (k, label) => {
        const box = h('input', { type: 'checkbox', checked: !!f[k] });
        box.addEventListener('change', () => { f[k] = box.checked; catalogChanged(false); });
        return h('label', { class: 'check', style: 'margin:0' }, box, label);
      };
      body.append(h('div', { class: 'card' },
        h('div', { class: 'rowx' },
          fin('field', 'field'), fin('column', 'COLUMN'),
          sel(FIELD_TYPES, f.type || 'VARCHAR2', (v) => { f.type = v; catalogChanged(false); }),
          h('button', { class: 'x', text: '×', title: 'Remove field', onclick: () => { src.fields.splice(i, 1); catalogChanged(true); } })),
        h('div', { class: 'rowx', style: 'flex-wrap:wrap;gap:10px' },
          cb('searchable', 'searchable'), fin('ops', 'eq,starts', '110px'), cb('updatable', 'updatable'),
          sel([['', 'no mask'], ['last4', 'mask: last 4']], f.mask || '', (v) => { if (v) f.mask = v; else delete f.mask; catalogChanged(false); }))));
    });
    body.append(h('button', { class: 'lnk', text: '+ Add field', onclick: () => {
      src.fields = src.fields || [];
      src.fields.push({ field: 'field_' + (src.fields.length + 1), column: 'FIELD_' + (src.fields.length + 1), type: 'VARCHAR2', searchable: false, ops: 'eq', updatable: false });
      catalogChanged(true);
    } }));

    body.append(h('h4', { class: 'sub', text: 'Sample rows (Test tab)' }));
    if (BACKEND && dbState && dbState !== 'local' && src.sourceType !== 'PLSQL') {
      body.append(h('button', { class: 'lnk', text: 'Load 20 rows from the database', onclick: () => loadRowsFromDb(id) }));
    }
    const rows = h('textarea', { class: 'in mono', rows: 8, spellcheck: 'false', style: 'font-size:11.5px' });
    rows.value = JSON.stringify(src.sampleRows || [], null, 1);
    rows.addEventListener('change', () => {
      try {
        const v = JSON.parse(rows.value);
        if (!Array.isArray(v)) throw new Error('expected an array');
        src.sampleRows = v; rows.classList.remove('bad'); catalogChanged(false);
      } catch (e) { rows.classList.add('bad'); toast('Sample rows: ' + e.message); }
    });
    body.append(rows, h('p', { class: 'hint', text: 'Objects keyed by field name. Optional "_key" (record key) and "_version". These are only for testing in the designer.' }));

    body.append(h('div', { class: 'actions' },
      BACKEND && src.sourceType !== 'PLSQL'
        ? h('button', { class: 'btn primary', id: 'fcd-btnSaveSource', text: 'Save to database', disabled: dbState === 'saved', onclick: () => saveSourceToDb(id) }) : null,
      h('button', { class: 'btn' + (BACKEND ? '' : ' primary'), text: 'Registration SQL', onclick: () => {
        if (!src.objectName || !src.keyColumn) { toast('Set the table and key column first.'); return; }
        download(id + '_data_source.sql', registrationSql(id, src), 'text/plain');
      } }),
      h('button', { class: 'btn danger', text: 'Delete source', onclick: () => deleteSourceEverywhere(id) })));
  }

  // Samples menu
  let sampleMenu = null;
  function toggleSamples() {
    if (sampleMenu) { sampleMenu.remove(); sampleMenu = null; return; }
    const btn = $('btnSample'), r = btn.getBoundingClientRect(), rr = ROOT.getBoundingClientRect();
    sampleMenu = h('div', { class: 'quick', style: 'left:' + (r.left - rr.left) + 'px;top:' + (r.bottom - rr.top + 4) + 'px;z-index:20' },
      h('div', { text: 'Load a sample flow' }),
      SAMPLES.map((s) => h('button', { onclick: () => { toggleSamples(); loadSample(s); } },
        h('span', null, h('b', { text: s.label }), h('br'), h('small', { class: 'hint', text: s.desc })))));
    ROOT.append(sampleMenu);
    setTimeout(() => document.addEventListener('pointerdown', function close(e) {
      if (sampleMenu && !sampleMenu.contains(e.target) && e.target !== btn) { sampleMenu.remove(); sampleMenu = null; }
      document.removeEventListener('pointerdown', close);
    }), 0);
  }
  // Loads a sample from FLOWS_BASE. In database mode, falls back to the copy that install.sql
  // published (flow id = file name without .json), so the JSON files don't have to be uploaded.
  async function loadSample(s) {
    const url = FLOWS_BASE + s.file;
    const flowId = s.file.replace(/\.json$/, '');
    let fileErr;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const f = await r.json();
      const cat = catalog();   // make sure the sample's data sources exist in the catalog
      (f.nodes || []).forEach((n) => { if (n.type === 'findRecord' && n.source && !cat[n.source] && DEFAULT_CATALOG[n.source]) cat[n.source] = clone(DEFAULT_CATALOG[n.source]); });
      testEngine = null;
      replaceFlow(checkShape(f), 'Loaded the ' + s.label + ' sample');
      return;
    } catch (e) { fileErr = e; }

    if (BACKEND) {
      try {
        const r = await BACKEND.call('loadFlow', { flowId });
        testEngine = null;
        replaceFlow(checkShape(r.definition), 'Opened the ' + s.label + ' sample from the database (v' + r.version + ')',
          { flowId, version: r.version, status: r.status });
        return;
      } catch (e) { /* not in the database either: report the file error below */ }
    }
    console.warn('[FlowChat Designer] sample not found at', new URL(url, location.href).href, fileErr);
    toast('Could not load the sample from ' + new URL(url, location.href).pathname + ' (' + fileErr.message + '). ' +
          'Upload ' + s.file + ' to Static Application Files, or set data-flows-base on the region.', 9000);
  }

  function renderTitle() {
    $('flowTitle').textContent = (S.flow.name || 'Untitled flow') + '  ·  ' + (S.flow.flowId || '?');
    if (STANDALONE) document.title = (S.flow.name || 'Flow') + ' · FlowChat Designer';
  }

  function renderAll() {
    renderCanvas();
    renderProps();
    renderCheck();
    renderTitle();
    if (S.tab === 'json') renderJson();
    if (S.tab === 'test') renderMocks();
    S.testStale = true;
    updateTestNote();
    updateUndoButtons();
  }

  // ======================================================================== publish
  function publishSql() {
    const def = clone(S.flow);
    const json = JSON.stringify(def, null, 2);
    if (json.indexOf("~'") >= 0) throw new Error("The flow text contains ~' which can't be quoted in SQL.");
    const chunks = json.match(/[\s\S]{1,4000}/g) || [];
    return '-- Generated by FlowChat Designer on ' + new Date().toISOString() + '\n' +
      '-- Publishes flow "' + def.flowId + '" as a new version. Run as the FlowChat schema.\n' +
      'set define off\n' +
      'declare\n  l_def     clob;\n  l_version number;\nbegin\n' +
      '  dbms_lob.createtemporary(l_def, true);\n' +
      chunks.map((c) => "  dbms_lob.append(l_def, q'~" + c + "~');").join('\n') + '\n' +
      '  l_version := fc_engine.publish_flow(l_def);\n' +
      "  dbms_output.put_line('Published " + def.flowId + " version ' || l_version);\n" +
      '  commit;\nend;\n/\n';
  }

  // ======================================================================== init
  function bindToolbar() {
    $('btnNew').onclick = () => {
      if (confirm('Start a new, empty flow? The current draft is replaced (Undo brings it back).')) replaceFlow(blankFlow(), 'New flow created');
    };
    $('btnOpen').onclick = () => (BACKEND ? openDialog() : $('fileInput').click());
    if (BACKEND) {
      // Database mode: Save draft / Publish replace the SQL download as the main actions.
      $('btnSaveDb').hidden = false;
      $('btnPublishDb').hidden = false;
      $('btnPublish').textContent = 'SQL';
      $('btnPublish').classList.remove('primary');
      $('btnPublish').title = 'Download a SQL script that publishes this flow (for another environment)';
      $('btnOpen').title = 'Open a flow from the database (or a file)';
      $('btnSaveDb').onclick = () => saveToDb(false);
      $('btnPublishDb').onclick = () => saveToDb(true);
    }
    $('fileInput').onchange = (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      file.text().then((txt) => replaceFlow(checkShape(JSON.parse(txt)), 'Opened ' + file.name))
        .catch((err) => toast('Could not open: ' + err.message));
    };
    $('btnSample').onclick = toggleSamples;
    $('btnUndo').onclick = undo;
    $('btnRedo').onclick = redo;
    $('btnLayout').onclick = () => { mutate(() => autoLayout()); fitView(); };
    $('btnExport').onclick = () => download((S.flow.flowId || 'flow') + '.json', JSON.stringify(S.flow, null, 2), 'application/json');
    $('btnPublish').onclick = () => {
      const errs = analyze().list.filter((p) => p.level === 'error').length;
      if (errs && !confirm('The flow has ' + errs + ' error(s). Download the publish script anyway?')) { setTab('check'); return; }
      try {
        download((S.flow.flowId || 'flow') + '_publish.sql', publishSql(), 'text/plain');
        toast('Run the downloaded script in SQLcl / SQL Workshop to publish');
      } catch (e) { toast(e.message); }
    };
    ROOT.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
    $('btnRunTest').onclick = runTest;
    $('simChat').addEventListener('fc-turn', refreshTestPanels);
    $('btnApplyJson').onclick = () => {
      try {
        const keep = S.db.flowId ? Object.assign({}, S.db) : null;   // stay linked to the same database flow
        replaceFlow(checkShape(JSON.parse($('jsonText').value)), 'JSON applied', keep);
        if (keep) markDirty();
      }
      catch (e) { toast('Not applied: ' + e.message); }
    };
    $('btnCopyJson').onclick = () => {
      navigator.clipboard.writeText($('jsonText').value).then(() => toast('Copied'), () => toast('Copy failed; select and copy manually'));
    };

    // Enter in a text box would trigger the host form's implicit submit (an APEX page reload).
    // Swallow it and commit the field instead.
    ROOT.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const t = e.target;
      if (t.tagName === 'INPUT' && t.type !== 'button' && t.type !== 'submit') {
        e.preventDefault();
        e.stopPropagation();
        t.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    // Shortcuts apply only while focus is in the designer (or nowhere), never in other APEX regions.
    document.addEventListener('keydown', (e) => {
      const a = document.activeElement;
      if (a && a !== document.body && !ROOT.contains(a)) return;
      const typing = a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable || a.shadowRoot);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's' && BACKEND) {   // Ctrl+S saves a draft, even while typing
        e.preventDefault();
        if (a && a.tagName === 'INPUT') a.dispatchEvent(new Event('change', { bubbles: true }));
        saveToDb(false);
        return;
      }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) { e.preventDefault(); deleteSelection(); }
      else if (e.key === 'Escape') { hideQuick(); if (S.sel) select(null); }
    });
  }

  function buildPalette() {
    const pal = $('palette');
    let group = null;
    Object.keys(TYPES).forEach((type) => {
      const t = TYPES[type];
      if ((t.group || 'conv') !== group) {
        group = t.group || 'conv';
        if (group === 'data') pal.append(h('h3', { text: 'Find & update data', style: 'margin-top:14px' }));
      }
      pal.append(h('button', {
        class: 'pal', draggable: true, style: '--c:' + t.color, title: 'Click to add, or drag onto the canvas',
        onclick: () => {
          const r = canvas.getBoundingClientRect();
          const p = worldPos(r.left + r.width / 2, r.top + r.height / 3);
          addNode(type, p.x + (Math.random() * 40 - 20), p.y);
        },
        ondragstart: (e) => { e.dataTransfer.setData('text/plain', 'fc-node:' + type); e.dataTransfer.effectAllowed = 'copy'; }
      }, h('span', { class: 'dot' }), h('span', null, h('b', { text: t.label }), h('small', { text: t.desc }))));
    });
    pal.append(h('div', { class: 'tips' },
      h('div', null, 'Drag a node\'s bottom dot onto another node to connect. Drop on empty space to add a connected step.'),
      h('div', { style: 'margin-top:6px' }, h('kbd', { text: 'Del' }), ' remove · ', h('kbd', { text: 'Ctrl+Z' }), ' undo · scroll to zoom · drag background to pan')));
  }

  async function init() {
    ROOT.classList.add('fcd');
    ROOT.innerHTML = TEMPLATE;
    canvas = $('canvas'); world = $('world'); nodesEl = $('nodes'); edgeLayer = $('edgeLayer');
    buildPalette();
    bindCanvas();
    bindToolbar();
    const saved = loadSaved();
    let restored = false;
    if (saved && saved.flow) {
      try {
        S.flow = checkShape(saved.flow); S.mocks = saved.mocks || {};
        S.catalog = saved.catalog || null;
        if (BACKEND && saved.db) S.db = saved.db;
        if (BACKEND && saved.dbCatalog) S.dbCatalog = saved.dbCatalog;   // last known database signatures
        restored = true;
      } catch (e) { S.flow = null; }
    }
    if (!S.flow) {
      try { S.flow = checkShape(await fetch(FLOWS_BASE + SAMPLES[0].file).then((r) => r.json())); }
      catch (e) { S.flow = blankFlow(); }
    }
    normalize();
    applyView();
    renderAll();
    fitView();
    if (restored) toast('Restored your last draft');
    if (BACKEND) {
      renderDbStatus();
      await loadDbMeta();
      // Coming back from SQL Workshop (or any other tab): pick up lists added to FC_LOVS meanwhile.
      window.addEventListener('focus', () => { if (S.dbLovs && Date.now() - lovReloadAt > 5000) reloadLovs(); });
      if (!restored) openDialog();
    } else if (window.apex && window.apex.server && ROOT.dataset.backend !== 'files') {
      // On an APEX page but database mode is off: say why Save draft / Publish are missing.
      console.info('[FlowChat Designer] ' + VERSION + ': database mode is off. Add data-backend="apex" to <div id="fcd-root">.');
      toast('Database mode is off: add data-backend="apex" to the designer region’s div to save and publish here.', 9000);
    }
    console.info('[FlowChat Designer] ' + VERSION + (BACKEND ? ', database mode (' + (ROOT.dataset.ajaxIdentifier ? 'region plugin' : 'process ' + (ROOT.dataset.process || 'FC_DESIGNER')) + ')' : ', file mode'));
    window.addEventListener('resize', () => drawEdges());
  }

  // Small debugging / automation handle.
  window.FlowChatDesigner = { version: VERSION, mode: BACKEND ? 'database' : 'file', get state() { return S; }, analyze, publishSql, select: (id) => select(id ? { kind: 'node', id } : null) };
  init();
  } // boot
})();
