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
 */
(function (global) {
  'use strict';

  var MAX_STEPS = 200;
  var REQUIRED_MSG = 'This one is required. Please provide a value.';

  function pad(n) { return String(n).padStart(2, '0'); }
  function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function isFilled(v) { return !(v === undefined || v === null || v === ''); }
  function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }

  function randomId() {
    var b = new Uint8Array(16);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(b, function (x) { return x.toString(16).padStart(2, '0'); }).join('').toUpperCase();
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

  function interpolate(text, slots) {
    return String(text == null ? '' : text).replace(/\{\{\s*(\w+)\s*\}\}/g, function (_, k) {
      return isFilled(slots[k]) ? String(slots[k]) : '';
    });
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

  function evalCond(c, slots) {
    if (!c) return true;
    if (c.all) return c.all.every(function (x) { return evalCond(x, slots); });
    if (c.any) return c.any.some(function (x) { return evalCond(x, slots); });
    if (c.not) return !evalCond(c.not, slots);
    var v = slots[c.slot];
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

  function pickBranch(node, slots) {
    var branches = node.branches || [];
    for (var i = 0; i < branches.length; i++) if (evalCond(branches[i].when, slots)) return branches[i].next;
    return node['else'];
  }

  // ---------------------------------------------------------------- engine
  function createEngine(options) {
    options = options || {};
    var flows = {};
    var compiled = {};
    var connectors = Object.assign({}, options.connectors);
    var sessions = new Map();

    function registerFlow(def) { flows[def.flowId] = clone(def); delete compiled[def.flowId]; }
    function registerConnector(name, fn) { connectors[name] = fn; }
    (options.flows || []).forEach(registerFlow);

    function compile(flowId) {
      if (compiled[flowId]) return compiled[flowId];
      var flow = flows[flowId];
      if (!flow) throw new Error('Unknown flow "' + flowId + '"');
      var nodes = {}, slotNodes = {};
      flow.nodes.forEach(function (n) {
        nodes[n.id] = n;
        if (n.type === 'ask' && !slotNodes[n.slot]) slotNodes[n.slot] = n;
      });
      return (compiled[flowId] = { flow: flow, nodes: nodes, slotNodes: slotNodes });
    }

    function makeCtx(sid, st) {
      var c = compile(st.flowId);
      return { sid: sid, st: st, flow: c.flow, nodes: c.nodes, slotNodes: c.slotNodes,
               out: [], updates: [], replay: false, forceAsk: null };
    }

    function say(ctx, type, text) { if (text) ctx.out.push({ type: type, text: text }); }
    function touch(ctx, slot) { if (ctx.updates.indexOf(slot) < 0) ctx.updates.push(slot); }

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

    function displayValue(ctx, slot) {
      var v = ctx.st.slots[slot];
      if (!isFilled(v)) return '';
      var node = ctx.slotNodes[slot], spec = (node && node.input) || {};
      switch (spec.kind) {
        case 'number': return (spec.prefix || '') + formatNumber(v);
        case 'yesno': return v === 'Y' ? 'Yes' : 'No';
        case 'choice': {
          var o = (spec.options || []).find(function (x) { return String(x.value) === String(v); });
          return o ? (o.label || o.value) : String(v);
        }
        default: return String(v);
      }
    }

    async function validate(ctx, node, value) {
      var spec = node.input || {};
      if (!isFilled(value)) return spec.required === false ? null : (spec.requiredMessage || REQUIRED_MSG);
      if (spec.kind === 'number') {
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
      var slots = node.fields || ctx.flow.nodes
        .filter(function (n) { return n.type === 'ask' && isFilled(ctx.st.slots[n.slot]); })
        .map(function (n) { return n.slot; });
      var items = [];
      slots.forEach(function (s) {
        if (items.some(function (x) { return x.slot === s; })) return;
        var n = ctx.slotNodes[s];
        items.push({ slot: s, label: (n && n.label) || s, display: displayValue(ctx, s), editable: !!n });
      });
      return { type: 'summary', text: interpolate(node.text || "Here's what I have. Please check:", ctx.st.slots), items: items };
    }

    function progress(ctx) {
      var id = ctx.flow.start, done = 0, total = 0, steps = 0;
      while (id && steps++ < MAX_STEPS) {
        var n = ctx.nodes[id];
        if (!n) break;
        if (n.type === 'ask') { total++; if (isFilled(ctx.st.slots[n.slot])) done++; id = n.next; }
        else if (n.type === 'condition') id = pickBranch(n, ctx.st.slots);
        else if (n.type === 'message' || n.type === 'lookup') id = n.next;
        else break;
      }
      if (ctx.st.status === 'completed') done = total;
      return { done: done, total: total };
    }

    async function run(ctx, startId) {
      var st = ctx.st, id = startId, steps = 0;
      while (id) {
        if (++steps > MAX_STEPS) throw new Error('Flow exceeded ' + MAX_STEPS + ' steps. Check it for a loop.');
        var node = ctx.nodes[id], r;
        if (!node) throw new Error('Flow references unknown node "' + id + '".');
        switch (node.type) {
          case 'message':
            if (!ctx.replay) say(ctx, 'text', interpolate(node.text, st.slots));
            id = node.next;
            break;
          case 'condition':
            id = pickBranch(node, st.slots);
            break;
          case 'lookup':
            if (ctx.replay) { id = node.next; break; }
            r = await callConnector(ctx, node.connector, { nodeId: node.id });
            mergeSlots(ctx, r.slots);
            if (r.message) say(ctx, 'text', r.message);
            id = r.found === false && node.onNotFound ? node.onNotFound : node.next;
            break;
          case 'ask':
            if ((ctx.replay || node.skipIfFilled) && isFilled(st.slots[node.slot]) && ctx.forceAsk !== id) { id = node.next; break; }
            // A question reached while replaying an edit keeps the replay going after it's answered.
            if (ctx.replay) st.editing = true;
            ctx.replay = false; ctx.forceAsk = null;
            st.current = id;
            say(ctx, 'text', interpolate(node.prompt, st.slots));
            return;
          case 'summary':
            ctx.replay = false;
            st.current = id;
            ctx.out.push(summaryMessage(ctx, node));
            return;
          case 'submit': {
            var bad = await revalidate(ctx);
            if (bad) { say(ctx, 'error', bad.error); st.editing = true; ctx.forceAsk = bad.nodeId; id = bad.nodeId; break; }
            r = await callConnector(ctx, node.connector, { nodeId: node.id });
            mergeSlots(ctx, r.slots);
            if (r.ok) { say(ctx, 'text', r.message); id = node.onSuccess || node.next; }
            else {
              say(ctx, 'error', r.message || 'Sorry, the submission failed.');
              id = node.onError;
              if (!id) { st.status = 'failed'; st.current = null; return; }
            }
            break;
          }
          case 'end':
            say(ctx, 'success', interpolate(node.text, st.slots));
            st.status = 'completed'; st.current = null;
            return;
          default:
            throw new Error('Unknown node type "' + node.type + '" (' + id + ').');
        }
      }
      st.status = 'completed'; st.current = null;
    }

    function buildTurn(ctx) {
      var st = ctx.st, aw = null;
      if (st.status === 'in_progress' && st.current) {
        var n = ctx.nodes[st.current];
        if (n.type === 'ask') {
          aw = { type: 'ask', nodeId: n.id, slot: n.slot, label: n.label || n.slot,
                 input: clone(n.input || { kind: 'text' }),
                 value: isFilled(st.slots[n.slot]) ? st.slots[n.slot] : null };
          if (!aw.input.kind) aw.input.kind = 'text';
        } else {
          aw = { type: 'summary', nodeId: n.id, confirmLabel: n.confirmLabel || 'Confirm & submit' };
        }
      }
      return {
        sessionId: ctx.sid, flowId: st.flowId, version: st.version, status: st.status,
        messages: ctx.out,
        'await': aw,
        fieldUpdates: ctx.updates.map(function (s) {
          return { slot: s, value: isFilled(st.slots[s]) ? st.slots[s] : null,
                   display: displayValue(ctx, s), binding: (ctx.flow.bindings || {})[s] || null };
        }),
        progress: progress(ctx),
        canGoBack: st.history.length > 0
      };
    }

    async function start(flowId, context) {
      var flow = compile(flowId).flow;
      var sid = randomId();
      var st = { flowId: flowId, version: flow.version || 1, status: 'in_progress', current: null,
                 slots: {}, history: [], editing: false, context: clone(context || {}) };
      sessions.set(sid, st);
      var ctx = makeCtx(sid, st);
      seedContext(ctx);
      await run(ctx, flow.start);
      return clone(buildTurn(ctx));
    }

    async function input(sid, payload) {
      var st = sessions.get(sid);
      if (!st) throw new Error('Session not found or expired.');
      var ctx = makeCtx(sid, st);
      payload = payload || {};
      if (st.status !== 'in_progress') return clone(buildTurn(ctx));
      var cmd = String(payload.command || '').toLowerCase();

      if (cmd === 'restart') {
        Object.keys(st.slots).forEach(function (k) { touch(ctx, k); });
        st.slots = {}; st.history = []; st.editing = false;
        seedContext(ctx);
        say(ctx, 'text', "Okay, let's start over.");
        await run(ctx, ctx.flow.start);
      } else if (cmd === 'back') {
        var prev = st.history.pop();
        st.editing = false;
        ctx.forceAsk = prev || st.current;
        await run(ctx, prev || st.current);
      } else if (cmd === 'edit') {
        var target = ctx.slotNodes[payload.slot];
        if (!target) say(ctx, 'error', 'There is no question for "' + payload.slot + '".');
        else { st.editing = true; ctx.forceAsk = target.id; await run(ctx, target.id); }
      } else {
        var node = ctx.nodes[st.current];
        if (node.type === 'ask') {
          var parsed = parseValue(node.input, payload.value);
          var err = parsed.error || await validate(ctx, node, parsed.value);
          if (err) say(ctx, 'error', err);
          else {
            st.slots[node.slot] = parsed.value; touch(ctx, node.slot);
            st.history.push(node.id);
            if (st.editing) { st.editing = false; ctx.replay = true; await run(ctx, ctx.flow.start); }
            else await run(ctx, node.next);
          }
        } else if (node.type === 'summary') {
          if (/^(confirm|yes|y|ok|submit)$/i.test(String(payload.value || '').trim())) await run(ctx, node.next);
          else say(ctx, 'text', 'Tap "' + (node.confirmLabel || 'Confirm & submit') + '", or use Edit next to any answer to change it.');
        }
      }
      return clone(buildTurn(ctx));
    }

    return {
      start: start,
      input: input,
      registerFlow: registerFlow,
      registerConnector: registerConnector,
      getState: function (sid) { return clone(sessions.get(sid)); }
    };
  }

  var api = { createEngine: createEngine, parseValue: parseValue, evalCond: evalCond, interpolate: interpolate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.FlowChatEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
