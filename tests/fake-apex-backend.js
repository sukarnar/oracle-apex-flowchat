/*
 * Fake APEX back end for testing the designer without a database.
 * Emulates apex.server.process('FC_DESIGNER', {x01: action, p_clob_01: json}) with the same
 * protocol and rules as db/09_fc_designer.sql. The "database" is kept in localStorage.
 *
 *   FakeApex.reset()                     start again from the seed data
 *   FakeApex.otherDesignerSaves(flowId)  simulate a colleague saving a new version
 *   FakeApex.db                          inspect the current state
 */
(function () {
  'use strict';
  var KEY = 'fake-apex-designer-db';
  var LATENCY = 120;

  function now() { return new Date().toISOString().slice(0, 16).replace('T', ' '); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function fail(code, msg) { var e = new Error(msg); e.code = code; throw e; }

  var seedPromise = null;
  function load() { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } }
  function store(db) { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ } }

  function seed() {
    var base = (document.getElementById('fcd-root') || { dataset: {} }).dataset.flowsBase || '../flows/';
    return Promise.all(['loan_application.json', 'update_application.json', 'update_application_public.json'].map(function (f) {
      return fetch(base + f).then(function (r) { return r.json(); });
    })).then(function (defs) {
      var db = {
        flows: {},
        sources: {
          loan_apps: {
            sourceType: 'TABLE', objectName: 'FC_DEMO_LOAN_APPS', keyColumn: 'APP_ID', versionColumn: 'VERSION', rowFilter: null, enabled: true,
            fields: [
              { field: 'amount', column: 'AMOUNT', type: 'NUMBER', searchable: false, ops: 'eq', updatable: true },
              { field: 'contact_ok', column: 'CONTACT_OK', type: 'VARCHAR2', searchable: false, ops: 'eq', updatable: true },
              { field: 'email', column: 'EMAIL', type: 'VARCHAR2', searchable: true, ops: 'eq', updatable: false },
              { field: 'phone', column: 'PHONE', type: 'VARCHAR2', searchable: false, ops: 'eq', updatable: true, mask: 'last4' },
              { field: 'purpose', column: 'PURPOSE', type: 'VARCHAR2', searchable: false, ops: 'eq', updatable: false },
              { field: 'reference', column: 'REFERENCE', type: 'VARCHAR2', searchable: true, ops: 'eq', updatable: false },
              { field: 'start_date', column: 'START_DATE', type: 'DATE', searchable: false, ops: 'eq', updatable: true },
              { field: 'status', column: 'STATUS', type: 'VARCHAR2', searchable: false, ops: 'eq', updatable: false }
            ]
          }
        },
        connectors: [
          { id: 'check_affordability', type: 'PLSQL', description: 'Loan <= 5x annual income' },
          { id: 'check_email', type: 'PLSQL', description: 'Rejects disposable email domains' },
          { id: 'create_application', type: 'PLSQL', description: 'Inserts the loan application' },
          { id: 'lookup_customer', type: 'PLSQL', description: 'Prefills name for known customers' },
          { id: 'send_code', type: 'PLSQL', description: 'Verify step: delivers a one-time code (demo writes to FC_DEMO_OUTBOX)' }
        ],
        // 12_lov_demo.sql (FC_LOVS); options come from demo/demo-lovs.js
        lovs: [
          { id: 'branches', type: 'SQL', description: 'Demo: branches in one country (parameter: country)', params: ['country'],
            query: 'select branch_id, branch_name from fc_demo_branches where country_code = :COUNTRY order by branch_name' },
          { id: 'countries', type: 'SQL', description: 'Demo: countries that have a branch', params: [],
            query: 'select country_code, country_name from fc_demo_branches group by country_code, country_name order by 2' }
        ],
        tables: {
          FC_DEMO_LOAN_APPS: { type: 'TABLE', pk: ['APP_ID'], columns: [
            ['APP_ID', 'NUMBER', false], ['REFERENCE', 'VARCHAR2', true], ['SESSION_ID', 'VARCHAR2', true], ['CUSTOMER_ID', 'NUMBER', true],
            ['EMAIL', 'VARCHAR2', false], ['APPLICANT_NAME', 'VARCHAR2', false], ['AMOUNT', 'NUMBER', false], ['PURPOSE', 'VARCHAR2', false],
            ['ANNUAL_INCOME', 'NUMBER', true], ['START_DATE', 'DATE', false], ['CONTACT_OK', 'VARCHAR2', true], ['PHONE', 'VARCHAR2', true],
            ['CREATED_AT', 'TIMESTAMP(6) WITH TIME ZONE', false], ['STATUS', 'VARCHAR2', false], ['VERSION', 'NUMBER', false]] },
          FC_DEMO_CUSTOMERS: { type: 'TABLE', pk: ['CUSTOMER_ID'], columns: [
            ['CUSTOMER_ID', 'NUMBER', false], ['EMAIL', 'VARCHAR2', false], ['FULL_NAME', 'VARCHAR2', false]] },
          HR_EMPLOYEES: { type: 'TABLE', pk: ['EMPLOYEE_ID'], columns: [
            ['EMPLOYEE_ID', 'NUMBER', false], ['EMAIL', 'VARCHAR2', false], ['FIRST_NAME', 'VARCHAR2', true], ['LAST_NAME', 'VARCHAR2', false],
            ['PHONE_NUMBER', 'VARCHAR2', true], ['HIRE_DATE', 'DATE', false], ['SALARY', 'NUMBER', true], ['NOTES', 'CLOB', true],
            ['ROW_VERSION', 'NUMBER', false]] },
          HR_EMPLOYEES_V: { type: 'VIEW', pk: [], columns: [['EMPLOYEE_ID', 'NUMBER', false], ['EMAIL', 'VARCHAR2', false], ['DEPARTMENT', 'VARCHAR2', true]] }
        },
        rows: {
          loan_apps: [
            { key: '1041', version: '1', values: { reference: 'LN-01041', email: 'jane.doe@example.com', purpose: 'CAR', status: 'NEW', amount: 200000, phone: '+1 555 123 4567', start_date: '2026-12-31', contact_ok: 'Y' } },
            { key: '1050', version: '1', values: { reference: 'LN-01050', email: 'raj.kumar@example.com', purpose: 'EDU', status: 'NEW', amount: 50000, phone: '+44 20 7946 0000', start_date: '2027-01-15', contact_ok: 'Y' } }
          ]
        }
      };
      // 10_verify_demo.sql: same table, rows limited to the verified email
      db.sources.loan_apps_public = JSON.parse(JSON.stringify(db.sources.loan_apps));
      db.sources.loan_apps_public.rowFilter = 'upper(t.email) = upper(:FC_VERIFIED)';
      db.rows.loan_apps_public = [];   // sample_rows: nothing is verified in the designer
      defs.forEach(function (d) {
        d.version = 1;
        db.flows[d.flowId] = { name: d.name, versions: [{ version: 1, status: 'PUBLISHED', definition: d, createdBy: 'ADMIN', createdAt: '2026-11-01 09:00' }] };
      });
      store(db);
      return db;
    });
  }
  function ready() {
    if (!seedPromise) seedPromise = load() ? Promise.resolve(load()) : seed();
    return seedPromise;
  }

  var PORTS = ['next', 'else', 'onNotFound', 'onSuccess', 'onError', 'found', 'notFound', 'tooMany', 'cancelled',
               'done', 'noChanges', 'saved', 'conflict', 'forbidden', 'error', 'verified', 'failed'];
  var TYPES = ['message', 'ask', 'condition', 'lookup', 'summary', 'submit', 'end', 'verify', 'findRecord', 'changeFields', 'saveChanges'];
  function validationErrors(def) {
    var errs = [], ids = {};
    if (!/^[a-z0-9_]{1,100}$/.test(def.flowId || '')) errs.push('flowId must be lowercase letters, digits and _');
    if (!Array.isArray(def.nodes)) return 'nodes array missing';
    def.nodes.forEach(function (n, i) {
      if (!n.id) errs.push('node #' + (i + 1) + ' has no id');
      else if (ids[n.id]) errs.push('duplicate node id "' + n.id + '"');
      ids[n.id] = true;
      if (TYPES.indexOf(n.type) < 0) errs.push('node "' + n.id + '" has unknown type "' + n.type + '"');
    });
    if (!ids[def.start]) errs.push('start node is missing');
    def.nodes.forEach(function (n) {
      PORTS.forEach(function (p) { if (n[p] && !ids[n[p]]) errs.push(n.id + '.' + p + ' points to missing node "' + n[p] + '"'); });
      (n.branches || []).forEach(function (b, i) { if (b.next && !ids[b.next]) errs.push(n.id + '.branch' + (i + 1) + ' points to missing node "' + b.next + '"'); });
    });
    return errs.join('; ');
  }

  var handlers = {
    listFlows: function (db) {
      return Object.keys(db.flows).sort().map(function (id) {
        var f = db.flows[id];
        return { flowId: id, name: f.name, versions: f.versions.slice().sort(function (a, b) { return b.version - a.version; }).slice(0, 25)
          .map(function (v) { return { version: v.version, status: v.status, createdBy: v.createdBy, createdAt: v.createdAt }; }) };
      });
    },
    loadFlow: function (db, p) {
      var f = db.flows[p.flowId];
      if (!f) fail('error', 'Flow "' + p.flowId + '" was not found.');
      var version = p.version || Math.max.apply(null, f.versions.map(function (v) { return v.version; }));
      var v = f.versions.find(function (x) { return x.version === Number(version); });
      if (!v) fail('error', 'Flow "' + p.flowId + '" version ' + version + ' was not found.');
      return { definition: clone(v.definition), version: v.version, status: v.status };
    },
    saveDraft: function (db, p) { return saveVersion(db, p, false); },
    publish: function (db, p) { return saveVersion(db, p, true); },
    listSources: function (db) { return clone(db.sources); },
    saveSource: function (db, p) {
      if (!/^[a-z][a-z0-9_]{0,99}$/.test(p.id || '')) fail('invalid', 'data source id must be lowercase letters, digits and _.');
      var d = p.def || {}, warnings = [];
      if (db.sources[p.id] && db.sources[p.id].sourceType === 'PLSQL') fail('invalid', '"' + p.id + '" is a PL/SQL data source; change it in the database.');
      if (!d.objectName || !d.keyColumn) fail('invalid', 'table and key column are required.');
      var name = String(d.objectName).toUpperCase().split('.').pop(), t = db.tables[name];
      var hasCol = function (c) { return t.columns.some(function (x) { return x[0] === String(c).toUpperCase(); }); };
      if (!t) warnings.push('Table or view ' + name + ' was not found or is not visible.');
      else {
        if (!hasCol(d.keyColumn)) warnings.push('Key column ' + String(d.keyColumn).toUpperCase() + ' does not exist.');
        if (d.versionColumn && !hasCol(d.versionColumn)) warnings.push('Version column ' + String(d.versionColumn).toUpperCase() + ' does not exist.');
        (d.fields || []).forEach(function (f) {
          var col = String(f.column || f.field).toUpperCase();
          if (!hasCol(col)) warnings.push('Column ' + col + ' (field ' + f.field + ') does not exist.');
        });
      }
      db.sources[p.id] = { sourceType: 'TABLE', objectName: d.objectName, keyColumn: String(d.keyColumn).toUpperCase(),
        versionColumn: d.versionColumn ? String(d.versionColumn).toUpperCase() : null, rowFilter: d.rowFilter || null, enabled: true,
        fields: (d.fields || []).map(function (f) {
          var o = { field: f.field, column: String(f.column || f.field).toUpperCase(), type: f.type || 'VARCHAR2',
                    searchable: !!f.searchable, ops: f.ops || 'eq', updatable: !!f.updatable };
          if (f.mask) o.mask = f.mask;
          return o;
        }).sort(function (a, b) { return a.field < b.field ? -1 : 1; }) };
      return { id: p.id, warnings: warnings };
    },
    deleteSource: function (db, p) {
      var users = [];
      Object.keys(db.flows).forEach(function (id) {
        db.flows[id].versions.forEach(function (v) {
          if (v.status === 'PUBLISHED' && (v.definition.nodes || []).some(function (n) { return n.source === p.id; })) users.push(id + ' v' + v.version);
        });
      });
      if (users.length) fail('in_use', '"' + p.id + '" is used by published flow(s): ' + users.join(', ') + '.');
      delete db.sources[p.id];
      return null;
    },
    listTables: function (db, p) {
      var q = String(p.q || '').toUpperCase();
      return Object.keys(db.tables).filter(function (n) { return !q || n.indexOf(q) >= 0; }).sort()
        .map(function (n) { return { name: n, type: db.tables[n].type }; });
    },
    describeTable: function (db, p) {
      var t = db.tables[String(p.name || '').toUpperCase()];
      if (!t) fail('error', 'Table or view ' + p.name + ' was not found.');
      return { name: String(p.name).toUpperCase(), pk: t.pk.slice(),
               columns: t.columns.map(function (c) { return { column: c[0], dataType: c[1], nullable: c[2], length: 100 }; }) };
    },
    sampleRows: function (db, p) { return clone(db.rows[p.id] || []).slice(0, p.limit || 20); },
    listConnectors: function (db) { return clone(db.connectors); },
    listLovs: function (db) { return clone(db.lovs || []); },
    lovOptions: function (db, p) {
      var l = (db.lovs || []).find(function (x) { return x.id === p.id; });
      if (!l) fail('error', 'Unknown or disabled lookup list "' + p.id + '".');
      var fn = window.FlowChatDemoLovs && window.FlowChatDemoLovs[p.id];
      return fn ? fn({ lov: p.id, params: p.params || {} }) : [];
    }
  };

  function saveVersion(db, p, publish) {
    var def = p.definition;
    if (!def || typeof def !== 'object') fail('invalid', 'definition missing.');
    if (!/^[a-z0-9_]{1,100}$/.test(def.flowId || '')) fail('invalid', 'flowId must be lowercase letters, digits and _.');
    if (publish) { var errs = validationErrors(def); if (errs) fail('invalid', errs); }
    var f = db.flows[def.flowId];
    var latest = f ? Math.max.apply(null, f.versions.map(function (v) { return v.version; })) : null;
    var lv = f ? f.versions.find(function (v) { return v.version === latest; }) : null;
    if (f && !p.force) {
      if (p.baseVersion == null) fail('exists', 'A flow with id "' + def.flowId + '" already exists (latest version ' + latest + ').');
      if (Number(p.baseVersion) !== latest) fail('conflict', 'Someone else saved "' + def.flowId + '" meanwhile (now version ' + latest + ').');
    }
    if (!f) f = db.flows[def.flowId] = { name: def.name, versions: [] };
    if (def.name) f.name = def.name;
    var status = publish ? 'PUBLISHED' : 'DRAFT', version;
    def = clone(def);
    if (lv && lv.status === 'DRAFT') {
      version = latest; def.version = version;
      Object.assign(lv, { definition: def, status: status, createdBy: 'YOU', createdAt: now() });
    } else {
      version = (latest || 0) + 1; def.version = version;
      f.versions.push({ version: version, status: status, definition: def, createdBy: 'YOU', createdAt: now() });
    }
    if (publish) f.versions.forEach(function (v) { if (v.status === 'PUBLISHED' && v.version !== version) v.status = 'RETIRED'; });
    return { flowId: def.flowId, version: version, status: status };
  }

  function deferred() {
    var d = { _done: [], _fail: [] };
    d.done = function (fn) { d._done.push(fn); return d; };
    d.fail = function (fn) { d._fail.push(fn); return d; };
    return d;
  }

  window.apex = window.apex || {};
  window.apex.server = {
    process: function (name, data) {
      var d = deferred();
      ready().then(function (db) {
        setTimeout(function () {
          var out;
          try {
            if (name !== 'FC_DESIGNER') fail('error', 'Unknown process ' + name);
            var h = handlers[data.x01];
            if (!h) fail('error', 'Unknown designer action "' + data.x01 + '".');
            var res = h(db, data.p_clob_01 ? JSON.parse(data.p_clob_01) : {});
            store(db);
            out = { ok: true, data: res === undefined ? null : res };
          } catch (e) {
            out = { error: e.message, code: e.code || 'error' };
          }
          FakeApex.log.push({ action: data.x01, ok: !!out.ok, code: out.code });
          d._done.forEach(function (fn) { fn(JSON.stringify(out)); });
        }, LATENCY);
      });
      return d;
    }
  };

  window.FakeApex = {
    log: [],
    get db() { return load(); },
    reset: function () { localStorage.removeItem(KEY); seedPromise = null; return ready(); },
    // Like an INSERT into FC_LOVS from SQL Workshop while the designer is open.
    addLov: function (lov) {
      return ready().then(function (db) {
        db.lovs = (db.lovs || []).filter(function (l) { return l.id !== lov.id; }).concat([lov]);
        store(db);
      });
    },
    otherDesignerSaves: function (flowId) {
      return ready().then(function () {
        var db = load(), f = db.flows[flowId];
        var latest = f.versions.reduce(function (a, v) { return v.version > a.version ? v : a; });
        var def = clone(latest.definition);
        def.version = latest.version + 1;
        f.versions.push({ version: def.version, status: 'DRAFT', definition: def, createdBy: 'COLLEAGUE', createdAt: now() });
        store(db);
        seedPromise = Promise.resolve(db);
        return def.version;
      });
    }
  };
})();
