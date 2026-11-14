/*!
 * FlowChat reference engine (JavaScript).
 *
 * Runs a flow definition and produces "turns" using exactly the same protocol and
 * semantics as the Oracle engine in db/03_fc_engine.pkb. Use it for:
 *   - the in-browser demo / flow-designer simulator (LocalTransport),
 *   - a Node.js backend for non-Oracle hosts,
 *   - unit-testing flows.
 *
 * In production for APEX, the PL/SQL engine is authoritative; this file is optional there.
 *
 * Data sources (search / update flows): pass options.dataSources = { id: source } where a source has
 *   search({criteria:[{field,op,value}], limit, context}) -> [{key, values}]
 *   get({key, context})                                   -> {values, version} | null
 *   update({key, version, original, changes, context})    -> {status: ok|conflict|forbidden|notfound, version?, message?}
 *   fields: { name: {updatable, searchable, mask} }       (optional metadata; enforced by the source)
 * createMemorySource() builds one over an in-memory array (demo, tests, designer mocks).
 * Every data source request also carries `verified`: the identity proved by the most recent
 * Verify step (for example the email address a one-time code was sent to), or null.
 *
 * Verify step (one-time code): the engine generates the code, keeps only a salted SHA-256 hash,
 * and calls the node's connector with {channel, to, code, ttlMinutes} to deliver it.
 *
 * Lookup lists (choice answers whose options come from the server): an input spec with
 *   "optionsFrom": "<list id>", "optionsParams": { "<param>": "<slot or alias.field>" }
 * takes its options from options.lovs = { id: fn(req) }, where
 *   req = { lov, params: {param: value}, context, verified, sessionId, flowId }
 *   fn returns (or resolves to) [{value, label}]   (at most 500 are used)
 * Lists are fetched again on every turn (never cached across turns), so they are always current.
 * A list whose parameters aren't all answered yet has no options.
 *
 * Signed-in user: options.appUser (a string, or fn({sessionId, flowId}) -> string) is available to
 * prompts and conditions as the built-in {{app_user}}. Set it from your server's authentication,
 * never from the browser. A slot or context value named app_user never overrides it.
 */
(function (global) {
  'use strict';

  var MAX_STEPS = 200;
  var REQUIRED_MSG = 'This one is required. Please provide a value.';
  var AWAIT = { await: true };   // sentinel: a node stopped to wait for user input
  var MAX_OPTIONS = 500;

  function pad(n) { return String(n).padStart(2, '0'); }
  function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function isFilled(v) { return !(v === undefined || v === null || v === ''); }
  function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
  function same(a, b) { return String(isFilled(a) ? a : '') === String(isFilled(b) ? b : ''); }

  function randomId() {
    var b = new Uint8Array(16);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(b, function (x) { return x.toString(16).padStart(2, '0'); }).join('').toUpperCase();
  }

  function cryptoObj() { return (typeof globalThis !== 'undefined' && globalThis.crypto) || null; }
  function randomCode(len) {
    var c = cryptoObj(), out = '';
    var b = new Uint32Array(len);
    if (c && c.getRandomValues) c.getRandomValues(b);
    else for (var i = 0; i < len; i++) b[i] = Math.floor(Math.random() * 4294967296);
    for (var j = 0; j < len; j++) out += String(b[j] % 10);
    return out;
  }
  // Salted SHA-256 (hex). The plain code is never stored in the session.
  async function hashCode(salt, code) {
    var text = String(salt) + ':' + String(code), c = cryptoObj();
    if (c && c.subtle) {
      var buf = await c.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.prototype.map.call(new Uint8Array(buf), function (x) { return x.toString(16).padStart(2, '0'); }).join('');
    }
    if (typeof require === 'function') return require('crypto').createHash('sha256').update(text).digest('hex');
    throw new Error('No SHA-256 implementation available for the Verify step.');
  }

  function formatNumber(n) {
    return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function resolveDate(s) {
    if (!s) return null;
    var t = String(s).toLowerCase();
    var d = new Date();
    if (t === 'today') return isoDate(d);
    if (t === 'tomorrow') { d.setDate(d.getDate() + 1); return isoDate(d); }
    return String(s);
  }

  function validDate(y, m, d) {
    var dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? isoDate(dt) : null;
  }

  // {{slot}} and {{record.field}} placeholders.
  function interpolate(text, values) {
    return String(text == null ? '' : text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, function (_, k) {
      return isFilled(values[k]) ? String(values[k]) : '';
    });
  }

  function displayFor(spec, v) {
    if (!isFilled(v)) return '';
    spec = spec || {};
    switch (spec.kind) {
      case 'number': return (spec.prefix || '') + formatNumber(v);
      case 'yesno': return v === 'Y' ? 'Yes' : v === 'N' ? 'No' : String(v);
      case 'choice': {
        var o = (spec.options || []).find(function (x) { return String(x.value) === String(v); });
        return o ? (o.label || o.value) : String(v);
      }
      default: return String(v);
    }
  }

  // ---------------------------------------------------------------- parsing
  function parseValue(spec, raw) {
    spec = spec || {};
    var s = raw === undefined || raw === null ? '' : String(raw).trim();
    if (s === '') return { value: null };
    var t = s.toLowerCase(), m, v, o;

    switch (spec.kind) {
      case 'number': {
        var n = t.replace(/[\s,$€£₹]/g, ''), mult = 1;
        if (/^-?\d+(\.\d+)?k$/.test(n)) { mult = 1e3; n = n.slice(0, -1); }
        else if (/^-?\d+(\.\d+)?m$/.test(n)) { mult = 1e6; n = n.slice(0, -1); }
        if (!/^-?\d+(\.\d+)?$/.test(n)) return { error: spec.parseMessage || 'I need a number here, for example 25000 or 25k.' };
        return { value: Math.round(parseFloat(n) * mult * 100) / 100 };
      }
      case 'email':
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { error: spec.parseMessage || "That doesn't look like a valid email address." };
        return { value: t };
      case 'date':
        if (t === 'today' || t === 'tomorrow') return { value: resolveDate(t) };
        m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        v = m ? validDate(+m[1], +m[2], +m[3]) : null;
        if (!m) {
          m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/); // DD/MM/YYYY
          v = m ? validDate(+m[3], +m[2], +m[1]) : null;
        }
        if (!v) return { error: spec.parseMessage || 'Please give a date like 2026-12-31 (or "today" / "tomorrow").' };
        return { value: v };
      case 'choice': {
        var opts = spec.options || [];
        o = opts.find(function (x) {
          return String(x.value).toLowerCase() === t || String(x.label || x.value).toLowerCase() === t;
        });
        if (!o && /^\d+$/.test(t)) o = opts[parseInt(t, 10) - 1];
        if (!o) return { error: spec.parseMessage || 'Please pick one of: ' + opts.map(function (x) { return x.label || x.value; }).join(', ') + '.' };
        return { value: String(o.value) };
      }
      case 'yesno':
        if (['y', 'yes', 'true', 'yeah', 'yep', 'sure', 'ok'].indexOf(t) >= 0) return { value: 'Y' };
        if (['n', 'no', 'false', 'nope'].indexOf(t) >= 0) return { value: 'N' };
        return { error: spec.parseMessage || 'Please answer yes or no.' };
      default:
        return { value: s };
    }
  }

  // ---------------------------------------------------------------- conditions
  function asNumber(v) {
    if (typeof v === 'number') return v;
    return typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? parseFloat(v) : null;
  }

  function evalCond(c, values) {
    if (!c) return true;
    if (c.all) return c.all.every(function (x) { return evalCond(x, values); });
    if (c.any) return c.any.some(function (x) { return evalCond(x, values); });
    if (c.not) return !evalCond(c.not, values);
    var v = values[c.slot];
    if (c.op === 'empty') return !isFilled(v);
    if (c.op === 'notEmpty') return isFilled(v);
    if (!isFilled(v)) return false;
    if (c.op === 'in') return (c.value || []).map(String).indexOf(String(v)) >= 0;
    var a = asNumber(v), b = asNumber(c.value);
    if (a === null || b === null) { a = String(v); b = String(c.value); }
    switch (c.op) {
      case '=': return a === b;
      case '!=': return a !== b;
      case '>': return a > b;
      case '>=': return a >= b;
      case '<': return a < b;
      case '<=': return a <= b;
      default: throw new Error('Unknown operator "' + c.op + '"');
    }
  }

  function pickBranch(node, values) {
    var branches = node.branches || [];
    for (var i = 0; i < branches.length; i++) if (evalCond(branches[i].when, values)) return branches[i].next;
    return node['else'];
  }

  // ---------------------------------------------------------------- in-memory data source
  function createMemorySource(def) {
    var rows = def.rows || [];
    var keyField = def.key || 'id';
    var ver = def.versionField || null;
    var fields = def.fields || {};
    var names = Object.keys(fields);

    function visible(row, req) { return !def.rowFilter || def.rowFilter(row, (req && req.context) || {}, (req && req.verified) || null); }
    function values(row, masked) {
      var out = {};
      names.forEach(function (f) {
        var v = row[f];
        if (masked && fields[f].mask === 'last4' && isFilled(v)) v = '•••• ' + String(v).slice(-4);
        out[f] = v === undefined ? null : v;
      });
      return out;
    }
    function match(row, c) {
      if (!fields[c.field] || fields[c.field].searchable === false) throw new Error('Field "' + c.field + '" is not searchable.');
      var fv = row[c.field];
      if (!isFilled(fv)) return false;
      var a = String(fv).toLowerCase(), b = String(c.value).toLowerCase();
      switch (c.op || 'eq') {
        case 'eq': return a === b;
        case 'starts': return a.indexOf(b) === 0;
        case 'contains': return a.indexOf(b) >= 0;
        case 'gte': return (asNumber(fv) !== null ? asNumber(fv) >= asNumber(c.value) : a >= b);
        case 'lte': return (asNumber(fv) !== null ? asNumber(fv) <= asNumber(c.value) : a <= b);
        default: throw new Error('Unknown search operator "' + c.op + '"');
      }
    }
    function find(key, req) { return rows.find(function (r) { return String(r[keyField]) === String(key) && visible(r, req); }); }

    return {
      fields: fields,
      rows: rows,
      search: function (req) {
        // Same rule as FC_DATA: no criteria is only allowed when a row filter limits the rows.
        if (!(req.criteria || []).length && !def.rowFilter) throw new Error('A search with no criteria needs a row filter on the data source.');
        return rows.filter(function (r) { return visible(r, req) && req.criteria.every(function (c) { return match(r, c); }); })
          .slice(0, req.limit || 50)
          .map(function (r) { return { key: r[keyField], values: values(r, true) }; });
      },
      get: function (req) {
        var r = find(req.key, req);
        return r ? { values: values(r, false), version: ver ? r[ver] : null } : null;
      },
      update: function (req) {
        var r = find(req.key, req);
        if (!r) return { status: 'notfound' };
        var ch = req.changes || {};
        for (var f in ch) {
          if (!fields[f] || !fields[f].updatable) return { status: 'forbidden', message: 'The field "' + f + '" cannot be changed.' };
        }
        if (ver) {
          if (String(r[ver]) !== String(req.version)) return { status: 'conflict' };
        } else {
          for (var o in (req.original || {})) if (!same(r[o], req.original[o])) return { status: 'conflict' };
        }
        Object.keys(ch).forEach(function (k) { r[k] = ch[k]; });
        if (ver) r[ver] = Number(r[ver]) + 1;
        return { status: 'ok', version: ver ? r[ver] : null };
      }
    };
  }

  // ---------------------------------------------------------------- engine
  function createEngine(options) {
    options = options || {};
    var flows = {};
    var compiled = {};
    var connectors = Object.assign({}, options.connectors);
    var dataSources = Object.assign({}, options.dataSources);
    var lovs = Object.assign({}, options.lovs);
    var sessions = new Map();

    function registerFlow(def) { flows[def.flowId] = clone(def); delete compiled[def.flowId]; }
    function registerConnector(name, fn) { connectors[name] = fn; }
    function registerDataSource(name, src) { dataSources[name] = src; }
    function registerLov(name, fn) { lovs[name] = fn; }
    (options.flows || []).forEach(registerFlow);

    function compile(flowId) {
      if (compiled[flowId]) return compiled[flowId];
      var flow = flows[flowId];
      if (!flow) throw new Error('Unknown flow "' + flowId + '"');
      var nodes = {}, slotNodes = {}, changeNodes = {}, findNodes = {};
      flow.nodes.forEach(function (n) {
        nodes[n.id] = n;
        if (n.type === 'ask' && !slotNodes[n.slot]) slotNodes[n.slot] = n;
        if (n.type === 'changeFields' && !changeNodes[n.record]) changeNodes[n.record] = n;
        if (n.type === 'findRecord' && !findNodes[n.as]) findNodes[n.as] = n;
      });
      return (compiled[flowId] = { flow: flow, nodes: nodes, slotNodes: slotNodes, changeNodes: changeNodes, findNodes: findNodes });
    }

    function makeCtx(sid, st) {
      var c = compile(st.flowId);
      st.records = st.records || {};
      st.results = st.results || {};
      return { sid: sid, st: st, flow: c.flow, nodes: c.nodes, slotNodes: c.slotNodes, changeNodes: c.changeNodes,
               findNodes: c.findNodes, out: [], updates: [], replay: false, forceAsk: null, lovCache: {} };
    }

    // ---- lookup lists
    function lovParams(ctx, spec) {
      var map = spec.optionsParams || {}, v = view(ctx), out = {}, ok = true;
      Object.keys(map).forEach(function (k) {
        var val = v[map[k]];
        if (!isFilled(val)) ok = false;
        out[k] = isFilled(val) ? val : null;
      });
      return ok ? out : null;
    }
    function lovKey(spec, params) { return spec.optionsFrom + '|' + JSON.stringify(params); }
    async function loadLov(ctx, spec) {
      var params = lovParams(ctx, spec);
      if (!params) return;
      var key = lovKey(spec, params);
      if (ctx.lovCache[key]) return;
      var fn = lovs[spec.optionsFrom];
      if (!fn) throw new Error('Unknown lookup list "' + spec.optionsFrom + '"');
      var res = await Promise.resolve(fn({ lov: spec.optionsFrom, params: params, context: clone(ctx.st.context),
                                           verified: verifiedValue(ctx), sessionId: ctx.sid, flowId: ctx.flow.flowId }));
      var list = Array.isArray(res) ? res : (res && res.options) || [];
      ctx.lovCache[key] = list.slice(0, MAX_OPTIONS).filter(function (o) { return o && isFilled(o.value); })
        .map(function (o) { return { value: String(o.value), label: isFilled(o.label) ? String(o.label) : String(o.value) }; });
    }
    // Fetch every lookup list this turn may show or check (once per list and parameters).
    async function ensureOptions(ctx) {
      var nodes = ctx.flow.nodes;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.type === 'ask' && n.input && n.input.optionsFrom) await loadLov(ctx, n.input);
        if (n.type === 'changeFields' && ctx.st.records[n.record]) {
          for (var j = 0; j < (n.fields || []).length; j++) {
            var f = n.fields[j];
            if (f.input && f.input.optionsFrom) await loadLov(ctx, f.input);
          }
        }
      }
    }
    async function stillOffered(ctx, node) {
      await ensureOptions(ctx);
      var v = String(ctx.st.slots[node.slot]);
      return eff(ctx, node.input).options.some(function (o) { return o.value === v; });
    }
    // The spec as the user sees it: a lookup list's options filled in (none until its parameters are answered).
    function eff(ctx, spec) {
      if (!spec || !spec.optionsFrom) return spec;
      var out = clone(spec), params = lovParams(ctx, spec);
      out.options = (params && ctx.lovCache[lovKey(spec, params)]) || [];
      return out;
    }

    function say(ctx, type, text) { if (text) ctx.out.push({ type: type, text: text }); }
    function touch(ctx, slot) { if (ctx.updates.indexOf(slot) < 0) ctx.updates.push(slot); }

    // Slots plus "alias.field" for every loaded record: what placeholders and conditions see.
    // Plus the built-in app_user (the signed-in user), which no slot or context value can override.
    function view(ctx) {
      var v = Object.assign({}, ctx.st.slots);
      var recs = ctx.st.records;
      Object.keys(recs).forEach(function (a) {
        var cur = recs[a].current || {};
        Object.keys(cur).forEach(function (f) { v[a + '.' + f] = cur[f]; });
      });
      v.app_user = appUserOf(ctx);
      return v;
    }
    function appUserOf(ctx) {
      var u = typeof options.appUser === 'function'
        ? options.appUser({ sessionId: ctx.sid, flowId: ctx.flow.flowId }) : options.appUser;
      return isFilled(u) ? String(u) : null;
    }

    function seedContext(ctx) {
      var ctxIn = ctx.st.context || {};
      Object.keys(ctxIn).forEach(function (k) {
        if (isFilled(ctxIn[k]) && (ctx.slotNodes[k] || (ctx.flow.bindings || {})[k])) ctx.st.slots[k] = ctxIn[k];
      });
    }

    function mergeSlots(ctx, slots) {
      if (!slots) return;
      Object.keys(slots).forEach(function (k) { ctx.st.slots[k] = slots[k]; touch(ctx, k); });
    }

    function callConnector(ctx, name, extra) {
      var fn = connectors[name];
      if (!fn) return Promise.reject(new Error('Unknown connector "' + name + '"'));
      var payload = Object.assign({ sessionId: ctx.sid, flowId: ctx.flow.flowId,
                                    slots: clone(ctx.st.slots), context: clone(ctx.st.context) }, extra);
      return Promise.resolve(fn(payload)).then(function (r) { return r || {}; });
    }

    function source(name) {
      var s = dataSources[name];
      if (!s) throw new Error('Unknown data source "' + name + '"');
      return s;
    }
    function dsContext(ctx) { return { sessionId: ctx.sid, flowId: ctx.flow.flowId, context: clone(ctx.st.context) }; }
    function verifiedValue(ctx) { return isFilled(ctx.st.verifiedLast) ? ctx.st.verifiedLast : null; }
    function isVerified(ctx, slot) {
      var v = view(ctx)[slot];
      return isFilled(v) && (ctx.st.verified || {})[slot] === String(v);
    }

    // Input spec for a slot or "alias.field" (used for display formatting).
    function specFor(ctx, name) {
      var dot = name.indexOf('.');
      if (dot > 0) {
        var cn = ctx.changeNodes[name.slice(0, dot)];
        var f = cn && fieldDef(cn, name.slice(dot + 1));
        return f ? eff(ctx, f.input) : null;
      }
      var n = ctx.slotNodes[name];
      return n ? eff(ctx, n.input) : null;
    }
    function displayValue(ctx, name) { return displayFor(specFor(ctx, name), view(ctx)[name]); }

    function fieldDef(changeNode, field) {
      return (changeNode.fields || []).find(function (f) { return f.field === field; }) || null;
    }
    function fieldLabel(f) { return f.label || f.field; }
    function fieldEditable(ctx, changeNode, f) {
      var rec = ctx.st.records[changeNode.record];
      var meta = rec && dataSources[rec.source] && dataSources[rec.source].fields;
      if (meta && meta[f.field] && meta[f.field].updatable === false) return false;
      return evalCond(f.editableWhen, view(ctx));
    }
    function recordChanges(rec) {
      var ch = {};
      Object.keys(rec.current).forEach(function (f) { if (!same(rec.current[f], rec.original[f])) ch[f] = rec.current[f]; });
      return ch;
    }

    async function validate(ctx, node, value) {
      var spec = eff(ctx, node.input) || {};
      if (!isFilled(value)) return spec.required === false ? null : (spec.requiredMessage || REQUIRED_MSG);
      if (spec.kind === 'choice') {
        // Also catches an answer that a lookup list no longer offers (e.g. an earlier answer it depends on changed).
        if (!(spec.options || []).some(function (o) { return String(o.value) === String(value); })) {
          return spec.staleMessage || 'Please choose one of the options shown.';
        }
      } else if (spec.kind === 'number') {
        if (spec.min != null && value < spec.min) return spec.minMessage || 'Please enter at least ' + (spec.prefix || '') + formatNumber(spec.min) + '.';
        if (spec.max != null && value > spec.max) return spec.maxMessage || 'The maximum is ' + (spec.prefix || '') + formatNumber(spec.max) + '.';
      } else if (spec.kind === 'date') {
        var lo = resolveDate(spec.minDate), hi = resolveDate(spec.maxDate);
        if (lo && value < lo) return spec.minMessage || 'Please choose a date on or after ' + lo + '.';
        if (hi && value > hi) return spec.maxMessage || 'Please choose a date on or before ' + hi + '.';
      } else {
        var len = String(value).length;
        if (spec.minLength != null && len < spec.minLength) return spec.minMessage || 'Please enter at least ' + spec.minLength + ' characters.';
        if (spec.maxLength != null && len > spec.maxLength) return spec.maxMessage || 'Please use at most ' + spec.maxLength + ' characters.';
      }
      var vals = node.validators || [];
      for (var i = 0; i < vals.length; i++) {
        var v = vals[i];
        if (v.type === 'regex') {
          if (!new RegExp(v.pattern).test(String(value))) return v.message || "That value isn't in the expected format.";
        } else if (v.type === 'server') {
          var r = await callConnector(ctx, v.connector, { nodeId: node.id, slot: node.slot, value: value });
          if (r.valid === false) return r.message || v.message || "That value wasn't accepted.";
        }
      }
      return null;
    }
    // A changeFields field validated like an Ask node.
    function fieldAsNode(changeNode, f) {
      return { id: changeNode.id, slot: changeNode.record + '.' + f.field, input: f.input || { kind: 'text' }, validators: f.validators };
    }

    // Re-check every answered question before submitting (defence in depth).
    async function revalidate(ctx) {
      var nodes = ctx.flow.nodes;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.type !== 'ask' || !isFilled(ctx.st.slots[n.slot])) continue;
        var err = await validate(ctx, n, ctx.st.slots[n.slot]);
        if (err) return { nodeId: n.id, error: err };
      }
      return null;
    }

    function summaryMessage(ctx, node) {
      if (node.mode === 'changes') return changesMessage(ctx, node);
      var slots = node.fields || ctx.flow.nodes
        .filter(function (n) { return n.type === 'ask' && isFilled(ctx.st.slots[n.slot]); })
        .map(function (n) { return n.slot; });
      var items = [];
      slots.forEach(function (s) {
        if (items.some(function (x) { return x.slot === s; })) return;
        var n = ctx.slotNodes[s];
        items.push({ slot: s, label: (n && n.label) || s, display: displayValue(ctx, s), editable: !!n });
      });
      return { type: 'summary', text: interpolate(node.text || "Here's what I have. Please check:", view(ctx)), items: items };
    }

    function changesMessage(ctx, node) {
      var rec = ctx.st.records[node.record];
      var cn = ctx.changeNodes[node.record];
      if (!rec) throw new Error('Summary "' + node.id + '" needs a loaded record "' + node.record + '".');
      var ch = recordChanges(rec);
      var items = Object.keys(ch).map(function (f) {
        var fd = cn && fieldDef(cn, f);
        var spec = fd ? eff(ctx, fd.input) : null;
        return { slot: node.record + '.' + f, label: fd ? fieldLabel(fd) : f,
                 before: displayFor(spec, rec.original[f]), after: displayFor(spec, rec.current[f]), editable: !!fd };
      });
      return { type: 'changes', text: interpolate(node.text || (items.length ? 'Please confirm these changes:' : "You haven't changed anything yet."), view(ctx)), items: items };
    }

    function recordCard(ctx, node) {
      var rec = ctx.st.records[node.record];
      return {
        type: 'record',
        text: interpolate(node.cardTitle || 'Current details', view(ctx)),
        items: (node.fields || []).map(function (f) {
          return { slot: node.record + '.' + f.field, label: fieldLabel(f), display: displayFor(eff(ctx, f.input), rec.current[f.field]) };
        })
      };
    }

    function progress(ctx) {
      var id = ctx.flow.start, done = 0, total = 0, steps = 0, v = view(ctx);
      while (id && steps++ < MAX_STEPS) {
        var n = ctx.nodes[id];
        if (!n) break;
        if (n.type === 'ask') { total++; if (isFilled(ctx.st.slots[n.slot])) done++; id = n.next; }
        else if (n.type === 'findRecord') { total++; if (ctx.st.records[n.as]) done++; id = n.found; }
        else if (n.type === 'changeFields') {
          total++;
          var rec = ctx.st.records[n.record];
          if (rec && Object.keys(recordChanges(rec)).length) done++;
          id = n.done;
        }
        else if (n.type === 'condition') id = pickBranch(n, v);
        else if (n.type === 'verify') id = n.verified;
        else if (n.type === 'message' || n.type === 'lookup') id = n.next;
        else break;
      }
      if (ctx.st.status === 'completed') done = total;
      return { done: done, total: total };
    }

    // ---- data nodes
    async function runFind(ctx, node) {
      var st = ctx.st, v = view(ctx), prompts = node.prompts || {};
      var criteria = [];
      if (node.requireVerified && !isVerified(ctx, node.requireVerified)) {
        // Never search for an identity that hasn't passed a Verify step (a flow design error).
        say(ctx, 'error', "I can't look that up until it has been verified.");
        return failed(ctx);
      }
      // byRowFilter: no criteria; the data source's row filter (e.g. owner = :APP_USER) picks the rows.
      if (!node.byRowFilter) (node.criteria || []).forEach(function (c) {
        var val = v[c.slot];
        if (isFilled(val)) criteria.push({ field: c.field, op: c.op || 'eq', value: val });
      });
      if (!node.byRowFilter && criteria.length < (node.minCriteria || 1)) {
        say(ctx, 'text', interpolate(prompts.none || "I couldn't find a matching record.", v));
        return node.notFound;
      }
      var max = node.maxResults || 10;
      var rows = (await Promise.resolve(source(node.source).search({ criteria: criteria, limit: max + 1, context: dsContext(ctx).context, verified: verifiedValue(ctx) }))) || [];
      if (!rows.length) {
        say(ctx, 'text', interpolate(prompts.none || "I couldn't find a matching record.", v));
        return node.notFound;
      }
      if (rows.length > max) {
        say(ctx, 'text', interpolate(prompts.tooMany || "That matches too many records. Let's narrow it down.", v));
        return node.tooMany || node.notFound;
      }
      if (rows.length === 1 && node.autoPick !== false) return loadRecord(ctx, node, rows[0].key);
      st.results[node.id] = rows.map(function (r, i) {
        var card = node.card || {};
        return { token: 'r' + (i + 1), key: r.key,
                 title: interpolate(card.title || String(r.key), r.values),
                 subtitle: card.subtitle ? interpolate(card.subtitle, r.values) : '' };
      });
      st.current = node.id;
      say(ctx, 'text', interpolate(prompts.many || 'I found {{count}} matching records. Which one?', Object.assign({}, v, { count: rows.length })));
      return AWAIT;
    }

    async function loadRecord(ctx, node, key) {
      var res = await Promise.resolve(source(node.source).get({ key: key, context: dsContext(ctx).context, verified: verifiedValue(ctx) }));
      delete ctx.st.results[node.id];
      if (!res || !res.values) {
        say(ctx, 'error', (node.prompts || {}).gone || 'That record is no longer available.');
        return node.notFound;
      }
      ctx.st.records[node.as] = { source: node.source, key: key, version: res.version === undefined ? null : res.version,
                                  original: clone(res.values), current: clone(res.values) };
      Object.keys(res.values).forEach(function (f) { touch(ctx, node.as + '.' + f); });
      say(ctx, 'text', interpolate((node.prompts || {}).found, view(ctx)));
      return node.found;
    }

    function promptField(ctx, cn, f) {
      var rec = ctx.st.records[cn.record];
      ctx.st.current = cn.id;
      ctx.st.editingField = f.field;
      var cur = displayFor(eff(ctx, f.input), rec.current[f.field]);
      say(ctx, 'text', interpolate(f.prompt || (fieldLabel(f) + (cur ? ' is currently ' + cur + '. What should it be?' : ' is empty. What should it be?')), view(ctx)));
    }

    async function runSave(ctx, node) {
      var st = ctx.st, rec = st.records[node.record];
      if (!rec) throw new Error('Save changes "' + node.id + '" needs a loaded record "' + node.record + '".');
      var cn = ctx.changeNodes[node.record];
      var changes = recordChanges(rec), fieldsChanged = Object.keys(changes);
      if (!fieldsChanged.length) { say(ctx, 'text', node.noChangesText || 'Nothing changed, so there was nothing to save.'); return node.noChanges || node.saved; }

      // Defence in depth: every changed field must be declared editable and must still validate.
      for (var i = 0; i < fieldsChanged.length; i++) {
        var fd = cn && fieldDef(cn, fieldsChanged[i]);
        if (!fd || !fieldEditable(ctx, cn, fd)) {
          say(ctx, 'error', 'The field "' + fieldsChanged[i] + '" cannot be changed here.');
          return node.forbidden || failed(ctx);
        }
        var err = await validate(ctx, fieldAsNode(cn, fd), changes[fieldsChanged[i]]);
        if (err) { say(ctx, 'error', err); promptField(ctx, cn, fd); return AWAIT; }
      }

      var src = source(rec.source), original = {};
      fieldsChanged.forEach(function (f) { original[f] = rec.original[f]; });
      var r = (await Promise.resolve(src.update({ key: rec.key, version: rec.version, original: original, changes: changes, context: dsContext(ctx).context, verified: verifiedValue(ctx) }))) || {};
      if (r.status === 'ok') {
        if (r.version !== undefined && r.version !== null) rec.version = r.version;
        rec.original = clone(rec.current);
        say(ctx, 'text', r.message || node.savedText);
        return node.saved;
      }
      if (r.status === 'conflict') {
        var fresh = await Promise.resolve(src.get({ key: rec.key, context: dsContext(ctx).context, verified: verifiedValue(ctx) }));
        if (!fresh || !fresh.values) { say(ctx, 'error', 'That record is no longer available.'); return node.error || failed(ctx); }
        rec.original = clone(fresh.values);
        rec.version = fresh.version === undefined ? null : fresh.version;
        rec.current = Object.assign(clone(fresh.values), changes);
        Object.keys(rec.current).forEach(function (f) { touch(ctx, node.record + '.' + f); });
        say(ctx, 'error', r.message || node.conflictText ||
          "Someone else changed this record after you opened it. I've loaded the latest version with your changes on top. Please check them again.");
        return node.conflict || node.error || failed(ctx);
      }
      if (r.status === 'forbidden') {
        say(ctx, 'error', r.message || "You're not allowed to change this record.");
        return node.forbidden || failed(ctx);
      }
      say(ctx, 'error', r.message || 'Sorry, the changes could not be saved.');
      return node.error || failed(ctx);
    }

    function failed(ctx) { ctx.st.status = 'failed'; ctx.st.current = null; return null; }

    // ---- verify (one-time code)
    function verifyOpts(node) {
      return { len: Math.min(Math.max(parseInt(node.codeLength, 10) || 6, 4), 10),
               ttl: Math.max(parseInt(node.ttlMinutes, 10) || 10, 1),
               attempts: Math.max(parseInt(node.maxAttempts, 10) || 3, 1),
               resends: Math.max(isFilled(node.maxResends) ? parseInt(node.maxResends, 10) || 0 : 2, 0) };
    }
    function verifyValues(ctx, node, extra) {
      var o = verifyOpts(node);
      return Object.assign({}, view(ctx), { codeLength: o.len, ttlMinutes: o.ttl }, extra);
    }
    // Generates, hashes and sends a code. Returns false when the connector reports a failure.
    async function sendCode(ctx, node) {
      var st = ctx.st, o = verifyOpts(node), target = String(view(ctx)[node.slot]);
      var prev = (st.verify || {})[node.id];
      var code = randomCode(o.len);
      st.verify = st.verify || {};
      st.verify[node.id] = { hash: await hashCode(ctx.sid + ':' + node.id, code), target: target,
                             expiresAt: Date.now() + o.ttl * 60000, attempts: 0,
                             sends: (prev && prev.target === target ? prev.sends : 0) + 1 };
      var r = await callConnector(ctx, node.connector, { nodeId: node.id, channel: node.channel || 'email',
                                                        to: target, code: code, ttlMinutes: o.ttl });
      if (r.ok === false) {
        delete st.verify[node.id];
        say(ctx, 'error', r.message || "Sorry, I couldn't send the code.");
        return false;
      }
      return true;
    }
    async function verifyFailed(ctx, node) {
      if (node.failed) await run(ctx, node.failed);
      else failed(ctx);
    }
    async function runVerify(ctx, node) {
      var st = ctx.st, target = view(ctx)[node.slot];
      if (!isFilled(target)) throw new Error('Verify "' + node.id + '" needs a value in "' + node.slot + '".');
      if (isVerified(ctx, node.slot)) { st.verifiedLast = String(target); return node.verified; }
      if (ctx.replay) st.editing = true;   // reached while replaying an edit: resume the replay once verified
      ctx.replay = false;
      if (!(await sendCode(ctx, node))) return node.failed || failed(ctx);
      st.current = node.id;
      say(ctx, 'text', interpolate((node.prompts || {}).sent || "I've sent a {{codeLength}}-digit code to {{" + node.slot + "}}. Please enter it here.", verifyValues(ctx, node)));
      return AWAIT;
    }
    async function handleVerify(ctx, node, payload, cmd) {
      var st = ctx.st, o = verifyOpts(node), pr = node.prompts || {};
      var pend = (st.verify || {})[node.id];
      if (cmd === 'resend' || !pend) {
        if (pend && pend.sends > o.resends) { say(ctx, 'error', pr.tooManySends || "I can't send any more codes. Please use the last one I sent."); return; }
        if (!(await sendCode(ctx, node))) { await verifyFailed(ctx, node); return; }
        say(ctx, 'text', interpolate(pr.resent || "I've sent a new code to {{" + node.slot + "}}.", verifyValues(ctx, node)));
        return;
      }
      var code = String(payload.value || '').replace(/\s+/g, '');
      if (!code) { say(ctx, 'error', 'Please enter the code.'); return; }
      if (Date.now() > pend.expiresAt) {
        if (pend.sends > o.resends) {
          delete st.verify[node.id];
          say(ctx, 'error', pr.locked || "That code has expired and I can't send another one.");
          await verifyFailed(ctx, node);
          return;
        }
        if (!(await sendCode(ctx, node))) { await verifyFailed(ctx, node); return; }
        say(ctx, 'error', interpolate(pr.expired || "That code has expired, so I've sent a new one to {{" + node.slot + "}}.", verifyValues(ctx, node)));
        return;
      }
      if ((await hashCode(ctx.sid + ':' + node.id, code)) !== pend.hash) {
        pend.attempts++;
        var left = o.attempts - pend.attempts;
        if (left <= 0) {
          delete st.verify[node.id];
          say(ctx, 'error', pr.locked || "That's too many wrong codes, so I can't continue.");
          await verifyFailed(ctx, node);
          return;
        }
        say(ctx, 'error', interpolate(pr.wrong || "That code isn't right. You have {{remaining}} more {{tries}}.",
          verifyValues(ctx, node, { remaining: left, tries: left === 1 ? 'try' : 'tries' })));
        return;
      }
      delete st.verify[node.id];
      st.verified = st.verified || {};
      st.verified[node.slot] = pend.target;
      st.verifiedLast = pend.target;
      st.history.push(node.id);
      say(ctx, 'text', interpolate(pr.success, view(ctx)));
      if (st.editing) { st.editing = false; ctx.replay = true; await run(ctx, ctx.flow.start); }
      else await run(ctx, node.verified);
    }

    async function run(ctx, startId) {
      var st = ctx.st, id = startId, steps = 0;
      while (id) {
        if (++steps > MAX_STEPS) throw new Error('Flow exceeded ' + MAX_STEPS + ' steps. Check it for a loop.');
        var node = ctx.nodes[id], r, nxt;
        if (!node) throw new Error('Flow references unknown node "' + id + '".');
        switch (node.type) {
          case 'message':
            if (!ctx.replay) say(ctx, 'text', interpolate(node.text, view(ctx)));
            id = node.next;
            break;
          case 'condition':
            id = pickBranch(node, view(ctx));
            break;
          case 'lookup':
            if (ctx.replay) { id = node.next; break; }
            r = await callConnector(ctx, node.connector, { nodeId: node.id });
            mergeSlots(ctx, r.slots);
            if (r.message) say(ctx, 'text', r.message);
            id = r.found === false && node.onNotFound ? node.onNotFound : node.next;
            break;
          case 'ask': {
            var stale = false;
            if ((ctx.replay || node.skipIfFilled) && isFilled(st.slots[node.slot]) && ctx.forceAsk !== id) {
              // A lookup answer the list no longer offers (an answer it depends on changed) is asked again.
              if (!(node.input && node.input.optionsFrom) || await stillOffered(ctx, node)) { id = node.next; break; }
              stale = true;
            }
            // A question reached while replaying an edit keeps the replay going after it's answered.
            if (ctx.replay) st.editing = true;
            ctx.replay = false; ctx.forceAsk = null;
            st.current = id;
            say(ctx, 'text', interpolate(node.prompt, view(ctx)));
            if (node.input && node.input.optionsFrom) {
              await ensureOptions(ctx);
              if (!eff(ctx, node.input).options.length) say(ctx, 'error', node.input.emptyMessage || "There's nothing to choose from here right now.");
              else if (stale) say(ctx, 'error', node.input.staleMessage || 'Your earlier answer is no longer one of the options. Please choose again.');
            }
            return;
          }
          case 'summary':
            await ensureOptions(ctx);
            ctx.replay = false;
            st.current = id;
            ctx.out.push(summaryMessage(ctx, node));
            return;
          case 'submit': {
            await ensureOptions(ctx);
            var bad = await revalidate(ctx);
            if (bad) { say(ctx, 'error', bad.error); st.editing = true; ctx.forceAsk = bad.nodeId; id = bad.nodeId; break; }
            r = await callConnector(ctx, node.connector, { nodeId: node.id });
            mergeSlots(ctx, r.slots);
            if (r.ok) { say(ctx, 'text', r.message); id = node.onSuccess || node.next; }
            else {
              say(ctx, 'error', r.message || 'Sorry, the submission failed.');
              id = node.onError;
              if (!id) { failed(ctx); return; }
            }
            break;
          }
          case 'verify':
            nxt = await runVerify(ctx, node);
            if (nxt === AWAIT) return;
            if (nxt === null && st.status === 'failed') return;
            id = nxt;
            break;
          case 'findRecord':
            if (ctx.replay && st.records[node.as]) { id = node.found; break; }
            ctx.replay = false;
            nxt = await runFind(ctx, node);
            if (nxt === AWAIT) return;
            id = nxt;
            break;
          case 'changeFields':
            if (!st.records[node.record]) throw new Error('Change fields "' + id + '" needs a loaded record "' + node.record + '".');
            await ensureOptions(ctx);
            ctx.replay = false;
            st.current = id;
            st.editingField = null;
            ctx.out.push(recordCard(ctx, node));
            say(ctx, 'text', interpolate(node.prompt || 'What would you like to change?', view(ctx)));
            return;
          case 'saveChanges':
            nxt = await runSave(ctx, node);
            if (nxt === AWAIT) return;
            if (nxt === null && st.status === 'failed') return;
            id = nxt;
            break;
          case 'end':
            say(ctx, 'success', interpolate(node.text, view(ctx)));
            st.status = 'completed'; st.current = null;
            return;
          default:
            throw new Error('Unknown node type "' + node.type + '" (' + id + ').');
        }
      }
      if (st.status === 'in_progress') { st.status = 'completed'; st.current = null; }
    }

    // Input spec sent to the browser: lookup options resolved, server-side details removed.
    function turnInput(ctx, spec) {
      var out = clone(eff(ctx, spec || { kind: 'text' }));
      delete out.optionsFrom; delete out.optionsParams; delete out.staleMessage; delete out.emptyMessage;
      return out;
    }

    function buildTurn(ctx) {
      var st = ctx.st, aw = null, v = view(ctx);
      if (st.status === 'in_progress' && st.current) {
        var n = ctx.nodes[st.current];
        if (n.type === 'ask') {
          aw = { type: 'ask', nodeId: n.id, slot: n.slot, label: n.label || n.slot,
                 input: turnInput(ctx, n.input),
                 value: isFilled(st.slots[n.slot]) ? st.slots[n.slot] : null };
          if (!aw.input.kind) aw.input.kind = 'text';
        } else if (n.type === 'summary') {
          aw = { type: 'summary', nodeId: n.id, confirmLabel: n.confirmLabel || 'Confirm & submit' };
        } else if (n.type === 'verify') {
          var vo = verifyOpts(n);
          aw = { type: 'ask', nodeId: n.id, slot: '#code', label: n.label || 'Code', secret: true, value: null,
                 input: { kind: 'text', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: vo.len,
                          placeholder: n.placeholder || vo.len + '-digit code' },
                 actions: [{ command: 'resend', label: n.resendLabel || 'Send a new code' }] };
        } else if (n.type === 'findRecord') {
          aw = { type: 'pick', nodeId: n.id,
                 items: (st.results[n.id] || []).map(function (r) { return { token: r.token, title: r.title, subtitle: r.subtitle }; }),
                 allowNone: n.allowNone !== false, noneLabel: n.noneLabel || 'None of these' };
        } else if (n.type === 'changeFields') {
          var rec = st.records[n.record];
          if (st.editingField) {
            var f = fieldDef(n, st.editingField);
            aw = { type: 'ask', nodeId: n.id, slot: n.record + '.' + f.field, label: fieldLabel(f),
                   input: turnInput(ctx, f.input), value: isFilled(rec.current[f.field]) ? rec.current[f.field] : null, sub: true };
            if (!aw.input.kind) aw.input.kind = 'text';
          } else {
            aw = { type: 'fieldMenu', nodeId: n.id, doneLabel: n.doneLabel || 'Done',
                   fields: (n.fields || []).map(function (fd) {
                     var ed = fieldEditable(ctx, n, fd);
                     return { field: fd.field, label: fieldLabel(fd), display: displayFor(eff(ctx, fd.input), rec.current[fd.field]),
                              changed: !same(rec.current[fd.field], rec.original[fd.field]), editable: ed,
                              reason: ed ? null : (fd.lockedMessage || 'This field cannot be changed right now.') };
                   }) };
          }
        }
      }
      return {
        sessionId: ctx.sid, flowId: st.flowId, version: st.version, status: st.status,
        messages: ctx.out,
        'await': aw,
        fieldUpdates: ctx.updates.map(function (s) {
          return { slot: s, value: isFilled(v[s]) ? v[s] : null,
                   display: displayValue(ctx, s), binding: (ctx.flow.bindings || {})[s] || null };
        }),
        progress: progress(ctx),
        canGoBack: st.history.length > 0 || !!st.editingField
      };
    }

    async function start(flowId, context) {
      var flow = compile(flowId).flow;
      var sid = randomId();
      var st = { flowId: flowId, version: flow.version || 1, status: 'in_progress', current: null,
                 slots: {}, history: [], editing: false, context: clone(context || {}), records: {}, results: {}, editingField: null,
                 verify: {}, verified: {}, verifiedLast: null };
      sessions.set(sid, st);
      var ctx = makeCtx(sid, st);
      seedContext(ctx);
      await run(ctx, flow.start);
      await ensureOptions(ctx);
      return clone(buildTurn(ctx));
    }

    async function input(sid, payload) {
      var st = sessions.get(sid);
      if (!st) throw new Error('Session not found or expired.');
      var ctx = makeCtx(sid, st);
      payload = payload || {};
      if (st.status !== 'in_progress') return clone(buildTurn(ctx));
      var cmd = String(payload.command || '').toLowerCase();
      var node = ctx.nodes[st.current];
      await ensureOptions(ctx);

      if (cmd === 'restart') {
        Object.keys(view(ctx)).forEach(function (k) { touch(ctx, k); });
        st.slots = {}; st.history = []; st.editing = false; st.records = {}; st.results = {}; st.editingField = null;
        st.verify = {}; st.verified = {}; st.verifiedLast = null;
        seedContext(ctx);
        say(ctx, 'text', "Okay, let's start over.");
        await run(ctx, ctx.flow.start);
      } else if (cmd === 'back' && node && node.type === 'changeFields' && st.editingField) {
        st.editingField = null;
        say(ctx, 'text', 'No problem, I kept it as it was. Anything else to change?');
      } else if (cmd === 'back') {
        var prev = st.history.pop();
        // A passed Verify step has nothing to ask again: step back past it.
        while (prev && ctx.nodes[prev] && ctx.nodes[prev].type === 'verify' && st.history.length) prev = st.history.pop();
        st.editing = false;
        ctx.forceAsk = prev || st.current;
        await run(ctx, prev || st.current);
      } else if (cmd === 'edit') {
        var slot = String(payload.slot || '');
        var dot = slot.indexOf('.');
        var cn = dot > 0 ? ctx.changeNodes[slot.slice(0, dot)] : null;
        var fd = cn && fieldDef(cn, slot.slice(dot + 1));
        var target = ctx.slotNodes[slot];
        if (fd && fieldEditable(ctx, cn, fd)) promptField(ctx, cn, fd);
        else if (target) { st.editing = true; ctx.forceAsk = target.id; await run(ctx, target.id); }
        else say(ctx, 'error', 'There is no question for "' + slot + '".');
      } else if (node.type === 'ask') {
        var parsed = parseValue(eff(ctx, node.input), payload.value);
        var err = parsed.error || await validate(ctx, node, parsed.value);
        if (err) say(ctx, 'error', err);
        else {
          st.slots[node.slot] = parsed.value; touch(ctx, node.slot);
          st.history.push(node.id);
          if (st.editing) { st.editing = false; ctx.replay = true; await run(ctx, ctx.flow.start); }
          else await run(ctx, node.next);
        }
      } else if (node.type === 'summary') {
        if (/^(confirm|yes|y|ok|submit|save)$/i.test(String(payload.value || '').trim())) await run(ctx, node.next);
        else say(ctx, 'text', 'Tap "' + (node.confirmLabel || 'Confirm & submit') + '", or use Edit next to any answer to change it.');
      } else if (node.type === 'verify') {
        await handleVerify(ctx, node, payload, cmd);
      } else if (node.type === 'findRecord') {
        await handlePick(ctx, node, payload);
      } else if (node.type === 'changeFields') {
        await handleChange(ctx, node, payload, cmd);
      }
      await ensureOptions(ctx);
      return clone(buildTurn(ctx));
    }

    async function handlePick(ctx, node, payload) {
      var results = ctx.st.results[node.id] || [];
      var choice = null;
      if ('pick' in payload) {
        if (payload.pick === null) {
          delete ctx.st.results[node.id];
          say(ctx, 'text', (node.prompts || {}).cancelled || 'Okay.');
          await run(ctx, node.cancelled || node.notFound);
          return;
        }
        choice = results.find(function (r) { return r.token === payload.pick; });
      } else if (isFilled(payload.value)) {
        var t = String(payload.value).trim().toLowerCase();
        choice = /^\d+$/.test(t) ? results[parseInt(t, 10) - 1]
          : results.find(function (r) { return r.title.toLowerCase().indexOf(t) >= 0; });
      }
      if (!choice) { say(ctx, 'error', 'Please choose one of the records shown.'); return; }
      ctx.st.history.push(node.id);
      var nxt = await loadRecord(ctx, node, choice.key);
      await run(ctx, nxt);
    }

    async function handleChange(ctx, node, payload, cmd) {
      var st = ctx.st, rec = st.records[node.record];
      if (st.editingField) {
        var f = fieldDef(node, st.editingField);
        var parsed = parseValue(eff(ctx, f.input), payload.value);
        var err = parsed.error || await validate(ctx, fieldAsNode(node, f), parsed.value);
        if (err) { say(ctx, 'error', err); return; }
        rec.current[f.field] = parsed.value;
        touch(ctx, node.record + '.' + f.field);
        st.editingField = null;
        say(ctx, 'text', interpolate(node.againPrompt || 'Got it. Anything else to change?', view(ctx)));
        return;
      }
      var val = String(payload.value || '').trim().toLowerCase();
      if (cmd === 'done' || (!payload.field && val && (val === 'done' || val === (node.doneLabel || 'done').toLowerCase()))) {
        if (Object.keys(recordChanges(rec)).length) await run(ctx, node.done);
        else { say(ctx, 'text', node.noChangesText || "You haven't changed anything."); await run(ctx, node.noChanges || node.done); }
        return;
      }
      var fieldName = payload.field || null;
      var fd = fieldName ? fieldDef(node, fieldName)
        : (node.fields || []).find(function (x) { return fieldLabel(x).toLowerCase() === val || x.field === val; });
      if (!fd) { say(ctx, 'error', 'Please choose a field to change, or ' + (node.doneLabel || 'Done') + '.'); return; }
      if (!fieldEditable(ctx, node, fd)) { say(ctx, 'error', fd.lockedMessage || 'This field cannot be changed right now.'); return; }
      promptField(ctx, node, fd);
    }

    return {
      start: start,
      input: input,
      registerFlow: registerFlow,
      registerConnector: registerConnector,
      registerDataSource: registerDataSource,
      registerLov: registerLov,
      getState: function (sid) { return clone(sessions.get(sid)); }
    };
  }

  var api = { createEngine: createEngine, createMemorySource: createMemorySource, parseValue: parseValue,
              evalCond: evalCond, interpolate: interpolate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.FlowChatEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
