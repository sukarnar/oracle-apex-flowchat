// Power Automate + Teams Adaptive Cards for FlowChat (Node). The reference for FC_AUTOMATE in
// db/23_fc_automate.sql, tested in tests/cards.test.js.
//
// A Power Automate flow loops: it POSTs {flowId, user, sessionId, reply} to the endpoint, posts the
// "card" it gets back to the person (Teams, "Post adaptive card and wait for a response", Flow bot),
// and sends the card's response ("data") back as the next "reply", until "done" is true.
//
//   buildCard(turn)    a FlowChat turn as an Adaptive Card (1.4): its messages, the note, and inputs
//                      and buttons for the question. Each button's data says what it does.
//   cardInput(data)    the card's response (Power Automate's "data") as the engine's input. It needs
//                      no state: every button carries its action, e.g. {action: 'answer', value: 'Y'}.
'use strict';
const crypto = require('crypto');
const FC = require('../widget/flowchat-engine.js');

const CARD_VERSION = '1.4';
const MAX_BUTTONS = 5;                    // choices up to this many are buttons, more are a list
const NOTE_STYLE = { info: 'accent', tip: 'good', warning: 'warning' };
const NOTE_PREFIX = { info: 'Note: ', tip: 'Tip: ', warning: 'Warning: ' };

function str(v) { return v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v); }
function text(t, extra) { return Object.assign({ type: 'TextBlock', text: t, wrap: true }, extra || {}); }
function submit(title, data, noInputs) {
  const a = { type: 'Action.Submit', title: title, data: data };
  if (noInputs) a.associatedInputs = 'none';
  return a;
}

function messageBlocks(m) {
  const items = Array.isArray(m.items) ? m.items : [];
  const out = [];
  if (m.type === 'error') { if (m.text) out.push(text(m.text, { color: 'attention' })); return out; }
  if (m.type === 'success') { if (m.text) out.push(text(m.text, { color: 'good', weight: 'bolder' })); return out; }
  if (!items.length) { if (m.text) out.push(text(m.text)); return out; }
  if (m.text) out.push(text(m.text, { weight: 'bolder' }));
  let facts;
  if (m.type === 'list') facts = items.map((it, i) => ({ title: (i + 1) + '.', value: str(it.title) || '' }));
  else if (m.type === 'changes') facts = items.map((it) => ({ title: str(it.label || it.slot), value: (str(it.before) || '(empty)') + ' → ' + (str(it.after) || '(empty)') }));
  else facts = items.map((it) => ({ title: str(it.label || it.slot), value: str(it.display) || '' }));
  out.push({ type: 'FactSet', facts: facts });
  return out;
}

function choiceSet(id, choices, o) {
  return Object.assign({ type: 'Input.ChoiceSet', id: id, choices: choices,
                         style: choices.length <= 8 ? 'expanded' : 'compact' }, o || {});
}

function buildCard(turn) {
  const t = FC.describeTurn(turn), aw = (turn && turn['await']) || {}, inp = aw.input || {};
  const card = { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                 version: CARD_VERSION, body: [], actions: [] };
  (turn.messages || []).forEach((m) => { card.body.push.apply(card.body, messageBlocks(m)); });
  if (t.note) {
    card.body.push({ type: 'Container', style: NOTE_STYLE[t.noteStyle] || 'accent',
                     items: [text((NOTE_PREFIX[t.noteStyle] || NOTE_PREFIX.info) + t.note, { size: 'small' })] });
  }
  if (t.status !== 'in_progress') return card;

  const required = 'Please answer this.';
  switch (t.kind) {
    case 'text': case 'email': case 'code': {
      const ml = Number(inp.maxLength) || null;
      card.body.push(Object.assign({ type: 'Input.Text', id: 'answer', label: t.label || undefined,
        style: t.kind === 'email' ? 'email' : undefined,
        isRequired: t.required, errorMessage: required, isMultiline: !!(ml && ml > 200) },
        ml ? { maxLength: ml } : {}, inp.placeholder ? { placeholder: inp.placeholder } : {},
        t.value !== null && !t.secret ? { value: t.value } : {}));
      card.actions.push(submit('Next', { action: 'answer' }));
      if (t.kind === 'code') card.actions.push(submit('Send a new code', { action: 'resend' }, true));
      break;
    }
    case 'number':
      card.body.push(Object.assign({ type: 'Input.Number', id: 'answer', label: t.label || undefined,
        isRequired: t.required, errorMessage: required },
        isFinite(inp.min) && inp.min !== null ? { min: Number(inp.min) } : {},
        isFinite(inp.max) && inp.max !== null ? { max: Number(inp.max) } : {},
        t.value !== null ? { value: Number(t.value) } : {}));
      card.actions.push(submit('Next', { action: 'answer' }));
      break;
    case 'date':
      card.body.push(Object.assign({ type: 'Input.Date', id: 'answer', label: t.label || undefined,
        isRequired: t.required, errorMessage: required }, t.value !== null ? { value: t.value } : {}));
      card.actions.push(submit('Next', { action: 'answer' }));
      break;
    case 'choice': case 'yesno':
      if (t.options.length <= MAX_BUTTONS) {
        t.options.forEach((o) => card.actions.push(submit(o.label, { action: 'answer', value: o.value }, true)));
      } else {
        card.body.push(Object.assign(choiceSet('answer', t.options.map((o) => ({ title: o.label, value: o.value })),
          { label: t.label || undefined, isRequired: true, errorMessage: 'Please choose one.' }),
          t.value !== null ? { value: t.value } : {}));
        card.actions.push(submit('Next', { action: 'answer' }));
      }
      break;
    case 'pick':
      card.body.push(choiceSet('pick', t.options.map((o) => ({ title: o.label + (o.detail ? ' (' + o.detail + ')' : ''), value: o.value })),
        { isRequired: true, errorMessage: 'Please choose one.' }));
      card.actions.push(submit('Open', { action: 'pick' }));
      if (t.canSkip) card.actions.push(submit(t.noneLabel, { action: 'none' }, true));
      break;
    case 'list':
      if (t.options.length) {
        card.body.push(choiceSet('item', t.options.map((o) => ({ title: o.label, value: o.value })),
          { style: 'compact', placeholder: 'Choose an item to change or remove' }));
      }
      if (t.canAdd) card.actions.push(submit(t.addLabel, { action: 'add' }, true));
      if (t.options.length && t.canEdit) card.actions.push(submit(t.editLabel, { action: 'editItem' }));
      if (t.options.length) card.actions.push(submit(t.removeLabel, { action: 'remove' }));
      if (t.canDone) card.actions.push(submit(t.doneLabel, { action: 'done' }, true));
      break;
    case 'fields': {
      const ok = t.options.filter((o) => o.enabled);
      card.body.push(choiceSet('field', ok.map((o) => ({ title: o.label + (o.detail ? ': ' + o.detail : ''), value: o.value })),
        { isRequired: true, errorMessage: 'Please choose what to change.' }));
      const locked = t.options.filter((o) => !o.enabled);
      if (locked.length) card.body.push(text(locked.map((o) => o.label + ': ' + (o.reason || "can't be changed now")).join('\n'), { isSubtle: true, size: 'small' }));
      card.actions.push(submit('Change', { action: 'field' }));
      card.actions.push(submit(t.doneLabel, { action: 'done' }, true));
      break;
    }
    case 'summary':
      card.actions.push(submit(t.confirmLabel, { action: 'answer', value: 'confirm' }, true));
      if (t.options.length) {
        card.body.push(choiceSet('editSlot', t.options.map((o) => ({ title: o.label, value: o.value })),
          { style: 'compact', placeholder: 'Change an answer…', isRequired: true, errorMessage: 'Choose the answer to change.' }));
        card.actions.push(submit('Change', { action: 'edit' }));
      }
      break;
    case 'confirm':
      card.actions.push(submit(t.confirmLabel, { action: 'confirm' }, true));
      card.actions.push(submit(t.cancelLabel, { action: 'cancel' }, true));
      break;
    default:   // a file, or anything a card can't ask
      card.body.push(text("This step can't be answered in Teams. Please finish it on the web page.", { color: 'attention' }));
  }
  if (t.canGoBack) card.actions.push(submit('Back', { action: 'back' }, true));
  return card;
}

const COMMANDS = ['back', 'restart', 'add', 'done', 'confirm', 'cancel', 'resend'];
function cardInput(data) {
  const d = data && typeof data === 'object' ? data : {};
  const a = String(d.action || '');
  const val = (v) => (v === undefined || v === null ? '' : String(v));
  if (a === 'answer') return { value: val(d.value !== undefined ? d.value : d.answer) };
  if (a === 'skip') return { value: '' };
  if (COMMANDS.indexOf(a) >= 0) return { command: a };
  if (a === 'editItem' || a === 'remove') {
    const i = /^\d+$/.test(val(d.item)) ? parseInt(d.item, 10) : -1;
    return { command: a, index: i };
  }
  if (a === 'field') return { field: val(d.field) };
  if (a === 'edit') return { command: 'edit', slot: val(d.editSlot) };
  if (a === 'pick') return { pick: val(d.pick) };
  if (a === 'none') return { pick: null };
  return { command: 'resume' };
}

// The endpoint (POST {flowId, user, sessionId, reply}, header X-FlowChat-Key), as FC_AUTOMATE.HANDLE.
//   clients: {name: {key, flows: ['it_helpdesk'] | null (any), defaultFlow, userMode: 'TABLE'|'UPN'|'LOCAL', enabled}}
//   users:   (userMode TABLE) {'jane.doe@example.com': 'JDOE'}, or with the flows registered for the
//            person: {'corp\\jdoe': {appUser: 'JDOE', flows: ['it_helpdesk']}} (flows null = every
//            flow the key allows). Or resolveUser(upn, client).
//   catalog: [{flowId, name, description, version}]: the published flows, for listFlows.
// A "upn" is a sign-in name: jane.doe@example.com, or DOMAIN\user from a Windows client.
function hashKey(k) { return crypto.createHash('sha256').update(String(k), 'utf8').digest('hex'); }
function userEntry(upn, opts) {
  const e = (opts.users || {})[upn];
  if (e === undefined || e === null) return null;
  return typeof e === 'string' ? { appUser: e, flows: null } : e;
}
function appUserFor(client, upn, opts) {
  const u = String(upn || '').trim().toLowerCase();
  if (!u) return null;
  if (opts.resolveUser) return opts.resolveUser(u, client) || null;
  const mode = (client.userMode || 'TABLE').toUpperCase();
  if (mode === 'UPN') return u.toUpperCase();
  if (mode === 'LOCAL') return u.replace(/^.*\\/, '').split('@')[0].toUpperCase() || null;   // DOMAIN\jdoe or jdoe@x -> JDOE
  const e = userEntry(u, opts);
  return e && e.enabled !== false ? e.appUser || null : null;
}
// The flows registered for the person (userMode TABLE only); null = every flow the key allows.
function userFlows(client, upn, opts) {
  if (opts.resolveUser || (client.userMode || 'TABLE').toUpperCase() !== 'TABLE') return null;
  const e = userEntry(String(upn || '').trim().toLowerCase(), opts);
  return e && e.flows && e.flows.length ? e.flows : null;
}
function inList(list, id) {
  return !list || list.some((x) => String(x).trim().toLowerCase() === String(id).toLowerCase());
}

function createAutomateHandler(opts) {
  let current = null;
  const engine = opts.engine(() => current);
  const keys = {};
  Object.keys(opts.clients || {}).forEach((name) => { keys[hashKey(opts.clients[name].key)] = Object.assign({ name: name }, opts.clients[name]); });
  const owners = new Map();                                   // sessionId -> {appUser, flowId}

  function result(status, body) { return { status: status, body: body }; }
  function doneWith(textMsg, extra) {
    const turn = { status: 'refused', messages: [{ type: 'error', text: textMsg }] };
    return result(200, Object.assign({ sessionId: null, status: 'refused', done: true, kind: 'none',
                                       text: textMsg, card: buildCard(turn) }, extra || {}));
  }
  function out(turn, appUser) {
    const t = FC.describeTurn(turn);
    return result(200, { sessionId: t.sessionId, status: t.status, done: t.status !== 'in_progress', kind: t.kind,
                         appUser: appUser, text: FC.renderTurn(t, { hints: false }), card: buildCard(turn) });
  }

  async function handle(apiKey, body) {
    const client = apiKey ? keys[hashKey(apiKey)] : null;
    if (!client || client.enabled === false) return result(401, { error: 'The API key is not valid.' });
    let b;
    try { b = typeof body === 'string' ? JSON.parse(body) : (body || {}); }
    catch (e) { return result(400, { error: 'The body is not JSON.' }); }
    const appUser = appUserFor(client, b.user, opts);
    if (!appUser) return doneWith("I don't know your account yet. Please ask an administrator to link " + (b.user || 'it') + ' to your user.');
    current = appUser;
    try {
      const sid = b.sessionId ? String(b.sessionId) : '';
      if (!sid) {
        const flowId = b.flowId || client.defaultFlow;
        if (!flowId) return result(400, { error: 'No flowId.' });
        if (!inList(client.flows, flowId)) return result(403, { error: 'This flow is not allowed for this key.' });
        if (!inList(userFlows(client, b.user, opts), flowId)) return result(403, { error: 'This flow is not registered for your account.' });
        const turn = await engine.start(flowId, b.context && typeof b.context === 'object' ? b.context : {});
        owners.set(turn.sessionId, { appUser: appUser, flowId: flowId });
        return out(turn, appUser);
      }
      const own = owners.get(sid);
      if (!own) return doneWith('That conversation has ended. Please start again.');
      if (own.appUser !== appUser) return result(403, { error: 'This conversation belongs to another user.' });
      if (!inList(client.flows, own.flowId)) return result(403, { error: 'This flow is not allowed for this key.' });
      if (!inList(userFlows(client, b.user, opts), own.flowId)) return result(403, { error: 'This flow is not registered for your account.' });
      return out(await engine.input(sid, cardInput(b.reply)), appUser);
    } catch (e) {
      return doneWith('Sorry, something went wrong. Please try again.');
    } finally { current = null; }
  }

  // POST {user} -> {user, appUser, defaultFlow, flows: [{flowId, name, description, version}]}, as
  // FC_AUTOMATE.LIST_FLOWS: the published flows both the key and the person may run.
  async function listFlows(apiKey, body) {
    const client = apiKey ? keys[hashKey(apiKey)] : null;
    if (!client || client.enabled === false) return result(401, { error: 'The API key is not valid.' });
    let b;
    try { b = typeof body === 'string' ? JSON.parse(body) : (body || {}); }
    catch (e) { return result(400, { error: 'The body is not JSON.' }); }
    const upn = String(b.user || '').trim().toLowerCase();
    const appUser = appUserFor(client, upn, opts);
    if (!appUser) return result(403, { error: 'Your account ' + (upn || '(none)') + ' is not linked to a FlowChat user. Ask an administrator to register it.' });
    const uf = userFlows(client, upn, opts);
    const ok = (id) => inList(client.flows, id) && inList(uf, id);
    const flows = (opts.catalog || []).filter((f) => f && f.flowId && ok(f.flowId))
      .map((f) => ({ flowId: f.flowId, name: f.name || f.flowId, description: f.description || null, version: f.version || null }))
      .sort((x, y) => x.name.localeCompare(y.name));
    return result(200, { user: upn, appUser: appUser,
                         defaultFlow: client.defaultFlow && ok(client.defaultFlow) ? client.defaultFlow : null, flows: flows });
  }
  return { handle: handle, listFlows: listFlows };
}

// ---- Posting to a channel: Teams Workflows "Post to a channel when a webhook request is received".
// The reference for FC_CHANNEL (db/25_fc_channel.sql). One way only: the card can open links
// (Action.OpenUrl) but nothing waits for a reply, so it has no Action.Submit buttons.
const CHANNEL_STYLES = ['emphasis', 'good', 'attention', 'warning', 'accent'];
// "[text](url)" in an answer would become a link in a post made under the workflow owner's name.
function noLinks(s) { return String(s == null ? '' : s).replace(/\]\s*\(/g, '] ('); }
function cut(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// msg = {title, text, facts: [{title, value}], link, linkLabel, style}
function channelCard(msg) {
  msg = msg || {};
  const body = [];
  const title = cut(noLinks(msg.title), 200);
  if (title) {
    const tb = text(title, { weight: 'Bolder', size: 'Medium' });
    body.push(CHANNEL_STYLES.indexOf(msg.style) >= 0 ? { type: 'Container', style: msg.style, bleed: true, items: [tb] } : tb);
  }
  if (msg.text) body.push(text(cut(noLinks(msg.text), 4000)));
  const facts = (msg.facts || []).filter((f) => f && f.title && f.value !== undefined && f.value !== null && f.value !== '')
    .slice(0, 20).map((f) => ({ title: cut(noLinks(f.title), 100), value: cut(noLinks(f.value), 1000) }));
  if (facts.length) body.push({ type: 'FactSet', facts: facts });
  const actions = msg.link ? [{ type: 'Action.OpenUrl', title: cut(msg.linkLabel || 'Open', 50), url: msg.link }] : [];
  return { type: 'AdaptiveCard', version: CARD_VERSION, body: body, actions: actions };
}
// The request body the Workflows webhook expects.
function channelPayload(msg) {
  return { type: 'message',
           attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: channelCard(msg) }] };
}
// options.postToTeams for the engine: opts.channels = {name: workflow URL} (secrets: keep them out of flows).
function createTeamsPoster(opts) {
  opts = opts || {};
  const doFetch = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  return async function postToTeams(msg) {
    const url = (opts.channels || {})[String(msg.channel || '').toLowerCase()];
    if (!url) return { ok: false, message: 'unknown Teams channel "' + msg.channel + '"' };
    if (!doFetch) return { ok: false, message: 'no fetch()' };
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), opts.timeoutMs || 10000) : null;
    try {
      const r = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                     body: JSON.stringify(channelPayload(msg)), signal: ctl ? ctl.signal : undefined });
      if (r.status === 200 || r.status === 202) return { ok: true };
      return { ok: false, message: 'Teams workflow returned HTTP ' + r.status };
    } catch (e) {
      return { ok: false, message: (e && e.message) || String(e) };
    } finally { if (timer) clearTimeout(timer); }
  };
}

module.exports = { buildCard, cardInput, createAutomateHandler, hashKey, channelCard, channelPayload, createTeamsPoster };
