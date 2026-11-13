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
  const NODE_W = 230;
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
    { file: 'update_application.json', label: 'Update application', desc: 'Search & update: find, change, save' }
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
  const KINDS = [['text', 'Text'], ['email', 'Email'], ['number', 'Number'], ['date', 'Date'], ['choice', 'Choice (buttons)'], ['yesno', 'Yes / No']];
  const OPS = [['=', 'equals'], ['!=', 'not equal'], ['>', '>'], ['>=', '≥'], ['<', '<'], ['<=', '≤'], ['in', 'is one of'], ['empty', 'is empty'], ['notEmpty', 'is filled']];

  const TYPES = {
    message:   { label: 'Message',   color: '#64748b', desc: 'The assistant says something.',
                 make: (id) => ({ id, type: 'message', text: 'New message' }) },
    ask:       { label: 'Ask',       color: '#2563eb', desc: 'Ask a question and capture one form field.',
                 make: (id) => ({ id, type: 'ask', slot: 'field', label: 'New field', prompt: 'What is your …?', input: { kind: 'text' } }) },
    condition: { label: 'Condition', color: '#d97706', desc: 'Branch on captured answers.',
                 make: (id) => ({ id, type: 'condition', branches: [{ when: { slot: '', op: '=', value: '' } }] }) },
    lookup:    { label: 'Lookup',    color: '#0891b2', desc: 'Fetch data (e.g. a customer) and prefill fields.',
                 make: (id) => ({ id, type: 'lookup', connector: '' }) },
    summary:   { label: 'Summary',   color: '#7c3aed', desc: 'Show all answers with Edit buttons, then confirm.',
                 make: (id) => ({ id, type: 'summary', text: "Here's what I have. Please check:", confirmLabel: 'Confirm & submit' }) },
    submit:    { label: 'Submit',    color: '#16a34a', desc: 'Re-validate everything and save via a connector.',
                 make: (id) => ({ id, type: 'submit', connector: '' }) },
    end:       { label: 'End',       color: '#475569', desc: 'Finish the conversation.',
                 make: (id) => ({ id, type: 'end', text: 'All done!' }) },
    findRecord: { label: 'Find record', color: '#0d9488', group: 'data', desc: 'Search a data source; pick among matches; load one.',
                 make: (id) => ({ id, type: 'findRecord', source: '', as: 'rec', criteria: [], maxResults: 10,
                                  card: { title: '' }, prompts: { many: 'I found {{count}} matching records. Which one?' } }) },
    changeFields: { label: 'Change fields', color: '#db2777', group: 'data', desc: 'Let the user change fields of the loaded record.',
                 make: (id) => ({ id, type: 'changeFields', record: '', prompt: 'What would you like to change?', fields: [] }) },
    saveChanges: { label: 'Save changes', color: '#059669', group: 'data', desc: 'Save only changed fields, with conflict detection.',
                 make: (id) => ({ id, type: 'saveChanges', record: '' }) }
  };

  const PORT_TITLES = {
    next: 'Then go to', onNotFound: 'If nothing is found, go to', onSuccess: 'On success, go to',
    onError: 'On error, go to', 'else': 'Otherwise go to',
    found: 'When a record is loaded, go to', notFound: 'If nothing matches, go to',
    tooMany: 'If too many match, go to', cancelled: 'If the user picks "None of these", go to',
    done: 'When the user clicks Done, go to', noChanges: 'If nothing was changed, go to',
    saved: 'After saving, go to', conflict: 'On a conflict (record changed meanwhile), go to',
    forbidden: 'If not allowed, go to', error: 'On any other error, go to'
  };
  const PORT_HINTS = {
    tooMany: 'Optional. Defaults to the not-found path.', cancelled: 'Optional. Defaults to the not-found path.',
    noChanges: 'Optional. Defaults to the Done path.',
    conflict: 'Usually back to the review summary: the latest values are reloaded with the user\'s edits on top.',
    forbidden: 'Optional. Without it the conversation ends as failed.', error: 'Optional. Without it the conversation ends as failed.'
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
  const SEARCH_OPS = [['eq', 'equals'], ['starts', 'starts with'], ['contains', 'contains'], ['gte', '≥'], ['lte', '≤']];
  const FIELD_TYPES = ['VARCHAR2', 'NUMBER', 'DATE'];

  // ======================================================================== state
  const S = {
    flow: null, sel: null, view: { x: 60, y: 50, z: 1 }, mocks: {}, catalog: null, dataSel: null,
    // database state (APEX back end only)
    db: { flowId: null, version: null, status: null, dirty: false, savedAt: null },
    dbCatalog: null,      // source id -> signature of the definition last read from / saved to the database
    dbConnectors: null,   // [{id, type, description}] registered in FC_CONNECTORS
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
  // through one page-level Ajax Callback. Without data-backend the designer works on files only.
  const BACKEND = (function () {
    if (ROOT.dataset.backend !== 'apex') return null;
    const proc = ROOT.dataset.process || 'FC_DESIGNER';
    return {
      call(action, payload) {
        if (!window.apex || !apex.server) return Promise.reject(new Error('The APEX JavaScript API is not on this page.'));
        return new Promise((resolve, reject) => {
          apex.server.process(proc, { x01: action, p_clob_01: JSON.stringify(payload || {}) }, { dataType: 'text' })
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
      case 'message': case 'ask': return [{ key: 'next', label: 'next' }];
      case 'summary': return [{ key: 'next', label: 'confirm' }];
      case 'lookup': return [{ key: 'next', label: 'next' }, { key: 'onNotFound', label: 'not found', optional: true }];
      case 'submit': return [{ key: 'onSuccess', label: 'success' }, { key: 'onError', label: 'error', optional: true }];
      case 'findRecord': return [{ key: 'found', label: 'found' }, { key: 'notFound', label: 'not found' },
        { key: 'tooMany', label: 'too many', optional: true }, { key: 'cancelled', label: 'none of these', optional: true }];
      case 'changeFields': return [{ key: 'done', label: 'done' }, { key: 'noChanges', label: 'no changes', optional: true }];
      case 'saveChanges': return [{ key: 'saved', label: 'saved' }, { key: 'conflict', label: 'conflict', optional: true },
        { key: 'forbidden', label: 'forbidden', optional: true }, { key: 'error', label: 'error', optional: true }];
      case 'condition':
        return (n.branches || []).map((b, i) => ({ key: 'branch:' + i, label: condText(b.when) || 'branch ' + (i + 1) }))
          .concat([{ key: 'else', label: 'else' }]);
      default: return [];
    }
  }
  function getPort(n, key) {
    if (key.indexOf('branch:') === 0) { const b = (n.branches || [])[+key.slice(7)]; return b && b.next; }
    return n[key];
  }
  function setPort(n, key, target) {
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
  function knownSlots() {
    const s = askSlots();
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
    findNodes().forEach((n) => { if (n.source) out[n.source] = true; });
    return Object.keys(out);
  }
  function inputKindFor(type) { return type === 'NUMBER' ? 'number' : type === 'DATE' ? 'date' : 'text'; }
  function uniqueSlot(base) {
    const used = knownSlots();
    let i = 1;
    while (used.indexOf(base + '_' + i) >= 0) i++;
    return base + '_' + i;
  }
  function connectorUses() {
    const map = {};
    S.flow.nodes.forEach((n) => {
      if ((n.type === 'lookup' || n.type === 'submit') && n.connector) map[n.connector] = map[n.connector] || n.type;
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
      if (n.type === 'ask' && n.slot === oldSlot) n.slot = newSlot;
      ['text', 'prompt'].forEach((k) => { if (typeof n[k] === 'string') n[k] = n[k].replace(re, '{{' + newSlot + '}}'); });
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
      const s2 = n.type === 'ask' && n.slot ? slots.concat(n.slot) : slots;
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
    const als = aliases();
    const placeholders = (text, nodeId) => {
      String(text || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
        const dot = k.indexOf('.');
        // alias.field of a source missing from the catalog can't be checked; only flag unknown aliases then
        const unchecked = dot > 0 && als.indexOf(k.slice(0, dot)) >= 0 && !sourceDef(sourceForAlias(k.slice(0, dot)));
        if (slots.indexOf(k) < 0 && !unchecked) add('warning', '{{' + k + '}} is not a known field.', nodeId);
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
        case 'ask': {
          const spec = n.input || {};
          if (!n.slot) add('error', 'Ask has no field (slot) name.', n.id);
          else if (!/^[a-z][a-z0-9_]{0,99}$/.test(n.slot)) add('error', 'Field name "' + n.slot + '" must be lowercase letters, digits and _.', n.id);
          if (!n.prompt) add('error', 'Ask has no question text.', n.id);
          placeholders(n.prompt, n.id);
          if (spec.kind === 'choice' && !(spec.options || []).length) add('error', 'Choice question has no options.', n.id);
          if (spec.kind === 'number' && isFilled(spec.min) && isFilled(spec.max) && spec.min > spec.max) add('error', 'Minimum is greater than maximum.', n.id);
          checkValidators(n.validators, n.id);
          break;
        }
        case 'lookup': case 'submit':
          if (!n.connector) add('error', TYPES[n.type].label + ' has no connector.', n.id);
          break;
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
        case 'findRecord': {
          const src = sourceDef(n.source);
          const crit = n.criteria || [];
          if (!n.source) add('error', 'Find record has no data source.', n.id);
          else if (!src) add('warning', 'Data source "' + n.source + '" is not in the designer catalog, so its fields can\'t be checked. Add it in the Data tab.', n.id);
          if (!/^[a-z][a-z0-9_]{0,49}$/.test(n.as || '')) add('error', 'Record alias must use lowercase letters, digits and _.', n.id);
          else if (findNodes().filter((x) => x.as === n.as).length > 1) add('error', 'Another Find record already uses the alias "' + n.as + '".', n.id);
          if (!crit.length) add('error', 'Find record has no search criteria.', n.id);
          crit.forEach((c) => {
            if (!c.field || !c.slot) { add('error', 'A search criterion is incomplete.', n.id); return; }
            const sf = sourceField(n.source, c.field);
            if (src && (!sf || !sf.searchable)) add('error', 'Field "' + c.field + '" is not searchable in ' + n.source + '.', n.id);
            else if (sf && String(sf.ops || 'eq').split(',').map((s) => s.trim()).indexOf(c.op || 'eq') < 0) {
              add('error', '"' + c.field + '" does not allow the "' + (c.op || 'eq') + '" search.', n.id);
            }
            if (askSlots().indexOf(c.slot) < 0) add('warning', 'Criterion uses "' + c.slot + '", which is never asked.', n.id);
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
            if (spec.kind === 'choice' && !(spec.options || []).length) add('error', 'Choice field "' + fd.field + '" has no options.', n.id);
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

  function nodeWidth(n) { return Math.max(NODE_W, ports(n).length * 96); }

  function nodeSummary(n) {
    switch (n.type) {
      case 'ask': return n.prompt;
      case 'condition': return (n.branches || []).length ? null : 'No branches yet';
      case 'lookup': case 'submit': return n.connector ? 'Calls ' + n.connector : '';
      case 'findRecord': return n.source ? 'Search ' + n.source + (n.as ? ' → ' + n.as : '') : '';
      case 'changeFields': return n.record ? 'Edit ' + (n.fields || []).length + ' field(s) of ' + n.record : '';
      case 'saveChanges': return n.record ? 'Save changes to ' + n.record : '';
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
    const slots = knownSlots();
    if (!slots.length) return null;
    return h('div', { class: 'chips-ins', title: 'Insert a captured answer' },
      slots.map((s) => h('button', {
        type: 'button', text: '{{' + s + '}}',
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
                      summary: summaryEditor, findRecord: findEditor, changeFields: changeEditor, saveChanges: saveEditor };
    body.append(editors[n.type](n));
    if (n.type !== 'condition' && n.type !== 'end') {
      body.append(h('h4', { class: 'sub', text: 'Connections' }));
      ports(n).forEach((p) => body.append(F(n.type === 'summary' ? 'After confirm, go to' : PORT_TITLES[p.key], targetSelect(n, p.key),
        p.key === 'onNotFound' ? 'Optional. Used when the connector returns found: false.' :
        p.key === 'onError' ? 'Optional. Without it a failed submit ends the conversation.' : PORT_HINTS[p.key] || null)));
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

    wrap.append(answerEditor(n, n.id));

    wrap.append(validatorsEditor(n));
    wrap.append(bindingEditor(n.slot));

    const adv = h('details', { class: 'adv' }, h('summary', { text: 'Advanced: messages & behaviour' }),
      checkbox('Skip if already filled (e.g. by a lookup or page context)', n.skipIfFilled, (c) => mutate(() => setOrDelete(n, 'skipIfFilled', c || null))),
      F('Required message', bound(() => spec.requiredMessage, (v) => setIn('requiredMessage', v), { key: n.id + '.rm', placeholder: 'This one is required…' })),
      F('Unrecognised answer message', bound(() => spec.parseMessage, (v) => setIn('parseMessage', v), { key: n.id + '.pm' })),
      h('div', { class: 'grid2' },
        F('Too small / short message', bound(() => spec.minMessage, (v) => setIn('minMessage', v), { key: n.id + '.minm' })),
        F('Too large / long message', bound(() => spec.maxMessage, (v) => setIn('maxMessage', v), { key: n.id + '.maxm' }))));
    wrap.append(adv);
    return wrap;
  }

  // Answer type + constraints for anything with an .input spec (Ask nodes, Change-fields fields).
  function answerEditor(o, kp) {
    const spec = o.input || { kind: 'text' };
    const kind = spec.kind || 'text';
    const setIn = (k, v) => { o.input = o.input || { kind: 'text' }; setOrDelete(o.input, k, v); };
    const box = h('div');
    box.append(h('h4', { class: 'sub', text: 'Answer' }));
    box.append(h('div', { class: 'grid2' },
      F('Type', sel(KINDS, kind, (v) => mutate(() => {
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
      box.append(optionsEditor(o, kp));
    }
    return box;
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
    const slots = knownSlots();
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
      ['text', 'prompt', 'cardTitle', 'againPrompt'].forEach((k) => { n[k] = fixText(n[k]); });
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
    wrap.append(h('p', { class: 'hint' }, 'Loaded fields are available as ', h('code', { text: '{{' + (n.as || 'alias') + '.field}}' }),
      ' and in conditions. ', h('button', { class: 'lnk', text: 'Manage data sources →', onclick: () => setTab('data') })));

    // criteria
    wrap.append(h('h4', { class: 'sub', text: 'Search criteria' }));
    const crit = n.criteria || [];
    const searchable = src ? src.fields.filter((f) => f.searchable) : [];
    const asks = askSlots();
    if (src && !searchable.length) wrap.append(h('p', { class: 'hint', text: 'No field of ' + n.source + ' is searchable. Mark some in the Data tab.' }));
    crit.forEach((c, i) => {
      const fOpts = [['', 'field…']].concat((src ? searchable : []).map((f) => [f.field, f.field]));
      if (c.field && !fOpts.some((o) => o[0] === c.field)) fOpts.push([c.field, c.field + (src ? ' (not searchable)' : '')]);
      const sf = sourceField(n.source, c.field);
      const allowed = sf ? String(sf.ops || 'eq').split(',').map((s) => s.trim()) : SEARCH_OPS.map((o) => o[0]);
      const opOpts = SEARCH_OPS.filter((o) => allowed.indexOf(o[0]) >= 0 || o[0] === (c.op || 'eq'));
      const slotOpts = [['', 'answer…']].concat(asks.map((s) => [s, s]));
      if (c.slot && asks.indexOf(c.slot) < 0) slotOpts.push([c.slot, c.slot + ' (not asked)']);
      wrap.append(h('div', { class: 'card' },
        h('div', { class: 'rowx' },
          sel(fOpts, c.field || '', (v) => mutate(() => { c.field = v; }, { panel: true }), { mono: true }),
          sel(opOpts, c.op || 'eq', (v) => mutate(() => { if (v === 'eq') delete c.op; else c.op = v; })),
          sel(slotOpts, c.slot || '', (v) => mutate(() => { c.slot = v; }), { mono: true }),
          h('button', { class: 'x', text: '×', title: 'Remove', onclick: () => mutate(() => crit.splice(i, 1), { panel: true }) })),
        checkbox('Optional: skip it when the answer is empty', c.optional, (ch) => mutate(() => setOrDelete(c, 'optional', ch || null)))));
    });
    wrap.append(h('button', { class: 'lnk', text: '+ Add criterion', onclick: () => mutate(() => {
      n.criteria = crit;
      const used = crit.map((c) => c.field);
      const nextField = searchable.find((f) => used.indexOf(f.field) < 0) || searchable[0];
      crit.push({ field: nextField ? nextField.field : '', op: 'eq', slot: asks.find((s) => nextField && s === nextField.field) || asks[0] || '' });
    }, { panel: true }) }));
    wrap.append(h('div', { class: 'grid2', style: 'margin-top:10px' },
      F('Max results', bound(() => n.maxResults, (v) => setOrDelete(n, 'maxResults', numOrNull(v)), { type: 'number', key: n.id + '.maxr', placeholder: '10' }),
        'More matches go to "too many".'),
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
      det.append(answerEditor(fd, kp), validatorsEditor(fd, kp), h('h4', { class: 'sub', text: 'Lock' }), editableWhenEditor(fd, kp));
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
    knownSlots().forEach((s) => {
      const askers = S.flow.nodes.filter((n) => n.type === 'ask' && n.slot === s).map((n) => n.id);
      const b = S.flow.bindings[s] || {};
      const c = cv.cov[s];
      const label = askers.length ? (c === 'always' ? 'every path' : c === 'sometimes' ? 'some paths' : 'unreachable')
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
    submit: [['Success', { ok: true, slots: { reference: 'TEST-0001' } }], ['Failure', { ok: false, message: 'Test failure from the mock.' }]]
  };
  const mockFor = (id, role) => (S.mocks[id] !== undefined ? S.mocks[id] : JSON.stringify(ROLE_PRESETS[role][0][1], null, 2));

  let testSources = {};
  function renderMocks() {
    const box = $('mocks');
    box.textContent = '';
    const uses = connectorUses();
    const ids = Object.keys(uses);
    const srcs = sourceUses();
    if (!ids.length && !srcs.length) { box.append(h('p', { class: 'hint', text: 'This flow calls no connectors or data sources.' })); return; }
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
      testSources[id] = FlowChatEngine.createMemorySource({ rows, key: '_key', versionField: src.versionColumn ? '_version' : null, fields });
    });
    return testSources;
  }

  function runTest() {
    const flow = clone(S.flow);
    const uses = connectorUses();
    const connectors = {};
    Object.keys(uses).forEach((id) => {
      connectors[id] = () => {
        const txt = mockFor(id, uses[id]);
        try { return JSON.parse(txt); } catch (e) { throw new Error('The test mock for "' + id + '" is not valid JSON.'); }
      };
    });
    testEngine = FlowChatEngine.createEngine({ flows: [flow], connectors, dataSources: buildTestSources() });
    const chat = $('simChat');
    chat.setAttribute('flow', flow.flowId || 'draft');
    chat.configure({ transport: new FlowChat.LocalTransport(testEngine), adapter: new FlowChat.NoneAdapter() });
    chat.start();
    S.testStale = false;
    updateTestNote();
    renderMocks();
    $('simState').textContent = '{}';
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
  function loadSample(s) {
    fetch(FLOWS_BASE + s.file).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((f) => {
        // make sure the sample's data sources exist in the catalog
        const cat = catalog();
        (f.nodes || []).forEach((n) => { if (n.type === 'findRecord' && n.source && !cat[n.source] && DEFAULT_CATALOG[n.source]) cat[n.source] = clone(DEFAULT_CATALOG[n.source]); });
        testEngine = null;
        replaceFlow(checkShape(f), 'Loaded the ' + s.label + ' sample');
      })
      .catch((err) => toast('Could not load the sample: ' + err.message));
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
      if (!restored) openDialog();
    }
    window.addEventListener('resize', () => drawEdges());
  }

  // Small debugging / automation handle.
  window.FlowChatDesigner = { get state() { return S; }, analyze, publishSql, select: (id) => select(id ? { kind: 'node', id } : null) };
  init();
  } // boot
})();
