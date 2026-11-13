/*!
 * FlowChat Designer: visual editor for FlowChat flow definitions.
 * No dependencies. Produces the same JSON the engines run (plus "ui" positions, which engines ignore).
 */
(function () {
  'use strict';

  // ======================================================================== constants
  const NODE_W = 230;
  const STORE_KEY = 'flowchat-designer:v1';
  const SAMPLE_URL = '../flows/loan_application.json';
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
                 make: (id) => ({ id, type: 'end', text: 'All done!' }) }
  };

  const PORT_TITLES = {
    next: 'Then go to', onNotFound: 'If nothing is found, go to', onSuccess: 'On success, go to',
    onError: 'On error, go to', 'else': 'Otherwise go to'
  };

  // ======================================================================== state
  const S = {
    flow: null, sel: null, view: { x: 60, y: 50, z: 1 }, mocks: {},
    undo: [], redo: [], lastKey: null, lastTime: 0, tab: 'props', drag: null, testStale: false
  };

  // ======================================================================== dom helpers
  const $ = (id) => document.getElementById(id);
  function h(tag, attrs) {
    const e = document.createElement(tag);
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
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function download(name, text, type) {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ======================================================================== model helpers
  const byId = (id) => S.flow.nodes.find((n) => n.id === id);

  function ports(n) {
    switch (n.type) {
      case 'message': case 'ask': return [{ key: 'next', label: 'next' }];
      case 'summary': return [{ key: 'next', label: 'confirm' }];
      case 'lookup': return [{ key: 'next', label: 'next' }, { key: 'onNotFound', label: 'not found', optional: true }];
      case 'submit': return [{ key: 'onSuccess', label: 'success' }, { key: 'onError', label: 'error', optional: true }];
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
    return s;
  }
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
      if (n.fields) n.fields = n.fields.map((s) => (s === oldSlot ? newSlot : s));
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
    save();
  }

  function replaceFlow(f, msg) {
    S.undo.push(JSON.stringify(S.flow));
    S.redo = [];
    S.flow = f;
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
    save();
  }
  function redo() {
    if (!S.redo.length) return;
    S.undo.push(JSON.stringify(S.flow));
    S.flow = JSON.parse(S.redo.pop());
    S.lastKey = null;
    fixSelection();
    renderAll();
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
      try { localStorage.setItem(STORE_KEY, JSON.stringify({ flow: S.flow, mocks: S.mocks })); } catch (e) { /* storage unavailable */ }
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
    const placeholders = (text, nodeId) => {
      String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
        if (slots.indexOf(k) < 0) add('warning', '{{' + k + '}} is not a known field.', nodeId);
        return _;
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
          (n.validators || []).forEach((v) => {
            if (v.type === 'regex') {
              try { new RegExp(v.pattern); } catch (e) { add('error', 'Invalid pattern: ' + v.pattern, n.id); }
              if (/\(\?[=!<]/.test(v.pattern || '')) add('warning', 'Pattern uses a lookahead/lookbehind, which Oracle regex does not support.', n.id);
            }
            if (v.type === 'server' && !v.connector) add('error', 'Server check has no connector.', n.id);
          });
          break;
        }
        case 'lookup': case 'submit':
          if (!n.connector) add('error', TYPES[n.type].label + ' has no connector.', n.id);
          break;
        case 'condition':
          if (!(n.branches || []).length) add('warning', 'Condition has no branches.', n.id);
          (n.branches || []).forEach((b) => checkCond(b.when, n.id));
          break;
        case 'message': case 'end': case 'summary':
          placeholders(n.text, n.id);
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
      if (marker) p.setAttribute('marker-end', 'url(#' + marker + ')');
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
    const editors = { message: textEditor, end: textEditor, ask: askEditor, condition: condEditor, lookup: connEditor, submit: connEditor, summary: summaryEditor };
    body.append(editors[n.type](n));
    if (n.type !== 'condition' && n.type !== 'end') {
      body.append(h('h4', { class: 'sub', text: 'Connections' }));
      ports(n).forEach((p) => body.append(F(n.type === 'summary' ? 'After confirm, go to' : PORT_TITLES[p.key], targetSelect(n, p.key),
        p.key === 'onNotFound' ? 'Optional. Used when the connector returns found: false.' :
        p.key === 'onError' ? 'Optional. Without it a failed submit ends the conversation.' : null)));
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

    wrap.append(h('h4', { class: 'sub', text: 'Answer' }));
    wrap.append(h('div', { class: 'grid2' },
      F('Type', sel(KINDS, kind, (v) => mutate(() => {
        n.input = { kind: v, required: spec.required, placeholder: spec.placeholder };
        Object.keys(n.input).forEach((k) => n.input[k] === undefined && delete n.input[k]);
        if (v === 'choice') n.input.options = spec.options || [{ value: 'A', label: 'Option A' }, { value: 'B', label: 'Option B' }];
      }, { panel: true }))),
      kind === 'choice' || kind === 'yesno' || kind === 'date' ? h('span') :
        F('Placeholder', bound(() => spec.placeholder, (v) => setIn('placeholder', v), { key: n.id + '.ph' }))));
    wrap.append(checkbox('Required', spec.required !== false, (c) => mutate(() => setIn('required', c ? null : false))));

    if (kind === 'number') {
      wrap.append(h('div', { class: 'grid2' },
        F('Minimum', bound(() => spec.min, (v) => setIn('min', numOrNull(v)), { type: 'number', key: n.id + '.min' })),
        F('Maximum', bound(() => spec.max, (v) => setIn('max', numOrNull(v)), { type: 'number', key: n.id + '.max' }))),
        F('Display prefix', bound(() => spec.prefix, (v) => setIn('prefix', v), { key: n.id + '.prefix', placeholder: 'e.g. $' }),
          'Shown in the summary. Users can type 25k, $1,250 etc.'));
    } else if (kind === 'date') {
      wrap.append(h('div', { class: 'grid2' },
        F('Earliest', bound(() => spec.minDate, (v) => setIn('minDate', v), { key: n.id + '.mind', placeholder: 'today / 2026-01-01' })),
        F('Latest', bound(() => spec.maxDate, (v) => setIn('maxDate', v), { key: n.id + '.maxd', placeholder: 'YYYY-MM-DD' }))));
    } else if (kind === 'text' || kind === 'email') {
      wrap.append(h('div', { class: 'grid2' },
        F('Min length', bound(() => spec.minLength, (v) => setIn('minLength', numOrNull(v)), { type: 'number', key: n.id + '.minl' })),
        F('Max length', bound(() => spec.maxLength, (v) => setIn('maxLength', numOrNull(v)), { type: 'number', key: n.id + '.maxl' }))));
    } else if (kind === 'choice') {
      wrap.append(optionsEditor(n));
    }

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

  function optionsEditor(n) {
    const opts = (n.input && n.input.options) || [];
    const box = h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('span', { class: 'grow', text: 'Options' }),
      h('span', { class: 'hint', text: 'value · label' })));
    opts.forEach((o, i) => {
      box.append(h('div', { class: 'rowx' },
        bound(() => o.value, (v) => { o.value = v; }, { mono: true, key: n.id + '.ov' + i, placeholder: 'VALUE' }),
        bound(() => o.label, (v) => setOrDelete(o, 'label', v), { key: n.id + '.ol' + i, placeholder: 'Label shown' }),
        h('button', { class: 'x', title: 'Up', text: '↑', disabled: i === 0, onclick: () => mutate(() => { opts.splice(i - 1, 0, opts.splice(i, 1)[0]); }, { panel: true }) }),
        h('button', { class: 'x', title: 'Remove', text: '×', onclick: () => mutate(() => opts.splice(i, 1), { panel: true }) })));
    });
    box.append(h('button', { class: 'lnk', text: '+ Add option', onclick: () => mutate(() => {
      n.input.options = opts; opts.push({ value: 'OPT' + (opts.length + 1), label: 'Option ' + (opts.length + 1) });
    }, { panel: true }) }));
    return box;
  }

  function validatorsEditor(n) {
    const vals = n.validators || [];
    const box = h('div', null, h('h4', { class: 'sub', text: 'Extra checks' }));
    vals.forEach((v, i) => {
      const card = h('div', { class: 'card' }, h('div', { class: 'card-h' },
        h('span', { class: 'grow', text: v.type === 'regex' ? 'Pattern (regex)' : 'Server check (connector)' }),
        h('button', { class: 'x', text: '×', title: 'Remove', onclick: () => mutate(() => { vals.splice(i, 1); if (!vals.length) delete n.validators; }, { panel: true }) })));
      if (v.type === 'regex') {
        card.append(F(null, bound(() => v.pattern, (x) => { v.pattern = x; }, { mono: true, key: n.id + '.vp' + i, placeholder: '^[0-9]{5}$' }),
          'Must work in both JavaScript and Oracle: avoid lookaheads.'));
      } else {
        card.append(F(null, connectorInput(() => v.connector, (x) => { v.connector = x; }, n.id + '.vc' + i),
          'Connector returns {"valid": true|false, "message": "…"}.'));
      }
      card.append(F('Error message', bound(() => v.message, (x) => setOrDelete(v, 'message', x), { key: n.id + '.vm' + i,
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
    const listId = 'connlist';
    let dl = document.getElementById(listId);
    if (!dl) { dl = h('datalist', { id: listId }); document.body.append(dl); }
    dl.textContent = '';
    Object.keys(connectorUses()).forEach((c) => dl.append(h('option', { value: c })));
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
    const fields = n.fields || [];
    const box = h('div', { class: 'card' }, h('div', { class: 'card-h', text: 'Fields to show' }));
    askSlots().forEach((s) => box.append(checkbox(s, fields.indexOf(s) >= 0, (c) => mutate(() => {
      const cur = (n.fields || []).filter((x) => x !== s);
      if (c) cur.push(s);
      if (cur.length) n.fields = askSlots().filter((x) => cur.indexOf(x) >= 0); else delete n.fields;
    }))));
    box.append(h('div', { class: 'hint', text: 'Nothing ticked = every answered question, in flow order.' }));
    return h('div', null, F('Intro text', ta), slotChips(ta),
      F('Confirm button label', bound(() => n.confirmLabel, (v) => setOrDelete(n, 'confirmLabel', v), { key: n.id + '.cl', placeholder: 'Confirm & submit' })),
      box);
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
      const label = askers.length ? (c === 'always' ? 'every path' : c === 'sometimes' ? 'some paths' : 'unreachable') : 'set by connector';
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

  function renderMocks() {
    const box = $('mocks');
    box.textContent = '';
    const uses = connectorUses();
    const ids = Object.keys(uses);
    if (!ids.length) { box.append(h('p', { class: 'hint', text: 'This flow calls no connectors.' })); return; }
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
    testEngine = FlowChatEngine.createEngine({ flows: [flow], connectors });
    const chat = $('simChat');
    chat.setAttribute('flow', flow.flowId || 'draft');
    chat.configure({ transport: new FlowChat.LocalTransport(testEngine), adapter: new FlowChat.NoneAdapter() });
    chat.start();
    S.testStale = false;
    updateTestNote();
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
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    ['props', 'check', 'test', 'json'].forEach((t) => { $('tab-' + t).hidden = t !== tab; });
    if (tab === 'check') renderCheck();
    if (tab === 'json') renderJson();
    if (tab === 'test') { renderMocks(); if (!testEngine) runTest(); }
  }

  function renderTitle() {
    $('flowTitle').textContent = (S.flow.name || 'Untitled flow') + '  ·  ' + (S.flow.flowId || '?');
    document.title = (S.flow.name || 'Flow') + ' · FlowChat Designer';
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
    $('btnOpen').onclick = () => $('fileInput').click();
    $('fileInput').onchange = (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      file.text().then((txt) => replaceFlow(checkShape(JSON.parse(txt)), 'Opened ' + file.name))
        .catch((err) => toast('Could not open: ' + err.message));
    };
    $('btnSample').onclick = () => fetch(SAMPLE_URL).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((f) => replaceFlow(checkShape(f), 'Loaded the loan application sample'))
      .catch((err) => toast('Could not load the sample: ' + err.message));
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
    document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
    $('btnRunTest').onclick = runTest;
    $('simChat').addEventListener('fc-turn', () => {
      const st = testEngine && testEngine.getState($('simChat').sessionId);
      $('simState').textContent = JSON.stringify(st ? st.slots : {}, null, 2);
    });
    $('btnApplyJson').onclick = () => {
      try { replaceFlow(checkShape(JSON.parse($('jsonText').value)), 'JSON applied'); }
      catch (e) { toast('Not applied: ' + e.message); }
    };
    $('btnCopyJson').onclick = () => {
      navigator.clipboard.writeText($('jsonText').value).then(() => toast('Copied'), () => toast('Copy failed; select and copy manually'));
    };

    document.addEventListener('keydown', (e) => {
      const a = document.activeElement;
      const typing = a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable || a.shadowRoot);
      const mod = e.ctrlKey || e.metaKey;
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) { e.preventDefault(); deleteSelection(); }
      else if (e.key === 'Escape') { hideQuick(); if (S.sel) select(null); }
    });
  }

  function buildPalette() {
    const pal = $('palette');
    Object.keys(TYPES).forEach((type) => {
      const t = TYPES[type];
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
    canvas = $('canvas'); world = $('world'); nodesEl = $('nodes'); edgeLayer = $('edgeLayer');
    buildPalette();
    bindCanvas();
    bindToolbar();
    const saved = loadSaved();
    let restored = false;
    if (saved && saved.flow) {
      try { S.flow = checkShape(saved.flow); S.mocks = saved.mocks || {}; restored = true; } catch (e) { S.flow = null; }
    }
    if (!S.flow) {
      try { S.flow = checkShape(await fetch(SAMPLE_URL).then((r) => r.json())); }
      catch (e) { S.flow = blankFlow(); }
    }
    normalize();
    applyView();
    renderAll();
    fitView();
    if (restored) toast('Restored your last draft');
    window.addEventListener('resize', () => drawEdges());
  }

  // Small debugging / automation handle.
  window.FlowChatDesigner = { get state() { return S; }, analyze, publishSql, select: (id) => select(id ? { kind: 'node', id } : null) };
  init();
})();
