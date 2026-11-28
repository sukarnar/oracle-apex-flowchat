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
//   users:   {'jane.doe@example.com': 'JDOE'}  (userMode TABLE), or resolveUser(upn, client)
function hashKey(k) { return crypto.createHash('sha256').update(String(k), 'utf8').digest('hex'); }
function appUserFor(client, upn, opts) {
  const u = String(upn || '').trim().toLowerCase();
  if (!u) return null;
  if (opts.resolveUser) return opts.resolveUser(u, client) || null;
  const mode = (client.userMode || 'TABLE').toUpperCase();
  if (mode === 'UPN') return u.toUpperCase();
  if (mode === 'LOCAL') return u.split('@')[0].toUpperCase() || null;
  return (opts.users || {})[u] || null;
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
        if (client.flows && client.flows.indexOf(flowId) < 0) return result(403, { error: 'This flow is not allowed for this key.' });
        const turn = await engine.start(flowId, b.context && typeof b.context === 'object' ? b.context : {});
        owners.set(turn.sessionId, { appUser: appUser, flowId: flowId });
        return out(turn, appUser);
      }
      const own = owners.get(sid);
      if (!own) return doneWith('That conversation has ended. Please start again.');
      if (own.appUser !== appUser) return result(403, { error: 'This conversation belongs to another user.' });
      if (client.flows && client.flows.indexOf(own.flowId) < 0) return result(403, { error: 'This flow is not allowed for this key.' });
      return out(await engine.input(sid, cardInput(b.reply)), appUser);
    } catch (e) {
      return doneWith('Sorry, something went wrong. Please try again.');
    } finally { current = null; }
  }
  return { handle: handle };
}

module.exports = { buildCard, cardInput, createAutomateHandler, hashKey };
