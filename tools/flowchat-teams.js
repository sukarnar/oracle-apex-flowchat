// Microsoft Teams outgoing webhooks for FlowChat (Node). The reference for FC_TEAMS in
// db/20_fc_teams.sql, tested in tests/teams.test.js, and used by tools/teams-send.js.
//
//   const teams = createTeamsHandler({
//     engine: (appUser) => FC.createEngine({ flows, connectors, appUser }),
//     webhooks: { travel: { securityToken, flowId: 'trip_booking', context: {}, tenantId: null, maxAgeSecs: 300 } },
//     users: { '<entra object id>': 'JDOE' }        // or resolveUser(aadObjectId, name)
//   });
//   const { status, body } = await teams.handle('travel', rawBodyString, req.headers.authorization);
'use strict';
const crypto = require('crypto');
const FC = require('../widget/flowchat-engine.js');

const HELP_HINT = 'Reply in this thread and mention me each time. HELP lists what you can say.';

// "HMAC " + base64(HMAC-SHA256(base64-decoded security token, the raw body bytes)).
function signBody(body, securityToken) {
  return 'HMAC ' + crypto.createHmac('sha256', Buffer.from(securityToken, 'base64'))
    .update(Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')).digest('base64');
}
function signatureOk(body, authorization, securityToken) {
  if (!body || !securityToken || !authorization) return false;
  const a = Buffer.from(String(authorization).trim()), b = Buffer.from(signBody(body, securityToken));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cleanText(text) {
  return String(text || '')
    .replace(/<at>[\s\S]*?<\/at>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
function toHtml(text) {
  if (text === null || text === undefined) return null;
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\r/g, '').replace(/\n/g, '<br>');
}
function message(text) { return { type: 'message', text: toHtml(text) }; }

function tooOld(timestamp, maxAgeSecs, now) {
  if (!timestamp || !(maxAgeSecs > 0)) return false;
  const at = Date.parse(String(timestamp).slice(0, 19) + 'Z');
  if (isNaN(at)) return true;
  return Math.abs(now - at) / 1000 > maxAgeSecs;
}

function helpText(active) {
  return active
    ? "Answer the question, or reply with an option's number.\n" +
      'BACK goes to the previous question, RESTART starts over, STOP ends the conversation.\n' +
      'In a list: ADD, DONE, EDIT n, REMOVE n. At the summary: CONFIRM or EDIT n.\n' +
      'Mention me each time you reply.'
    : 'Mention me in a thread to start. Each thread is its own conversation.';
}

function createTeamsHandler(opts) {
  let current = null;                                     // the user of the message being handled
  const engine = opts.engine(() => current);
  const conversations = new Map();                        // webhook|conversation|aad -> row
  const now = opts.now || (() => Date.now());

  function userFor(aad, name) {
    if (opts.resolveUser) return opts.resolveUser(aad, name) || null;
    const u = (opts.users || {})[String(aad).toLowerCase()];
    return u || null;
  }
  async function alive(sid) {
    if (!sid) return false;
    const st = engine.getState(sid);
    return !!st && st.status === 'in_progress';
  }

  async function handle(webhookId, body, authorization) {
    const hook = (opts.webhooks || {})[webhookId];
    if (!hook || hook.enabled === false) return { status: 404, body: { error: 'There is no such webhook.' } };
    if (!signatureOk(body, authorization, hook.securityToken)) return { status: 401, body: { error: 'The signature is not valid.' } };
    let act;
    try { act = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body); }
    catch (e) { return { status: 400, body: { error: 'The body is not JSON.' } }; }
    const from = act.from || {}, conv = act.conversation || {};
    const aad = from.aadObjectId ? String(from.aadObjectId).slice(0, 64) : null;
    const convId = conv.id || null, actId = act.id || null;
    const tenant = conv.tenantId || ((act.channelData || {}).tenant || {}).id || null;
    if (!aad || !convId) return { status: 400, body: { error: 'This is not a Teams message.' } };
    if (hook.tenantId && String(tenant || '-').toLowerCase() !== String(hook.tenantId).toLowerCase()) {
      return { status: 403, body: { error: 'This tenant is not allowed.' } };
    }
    if (tooOld(act.timestamp, hook.maxAgeSecs === undefined ? 300 : hook.maxAgeSecs, now())) {
      return { status: 401, body: { error: 'The message is too old.' } };
    }

    const user = userFor(aad, from.name);
    if (!user) {
      return { status: 200, body: message("I don't know your Teams account yet. Please ask an administrator to link it to your user. " +
                                          'Your account id is ' + aad + '.') };
    }
    const key = webhookId + '|' + convId + '|' + aad;
    const has = conversations.has(key);
    const row = has ? conversations.get(key) : { sessionId: null, status: null, lastTurn: null };
    if (has && actId && row.lastActivityId === actId) return { status: 200, body: row.lastResponse };

    const text = cleanText(act.text), cmd = text.slice(0, 100).toLowerCase();
    const active = has && row.status === 'active' && await alive(row.sessionId);
    let out, t = null;
    current = user;
    try {
      if (cmd === 'help' || cmd === '?') out = helpText(active);
      else if (cmd === 'stop' || cmd === 'quit' || cmd === 'exit') {
        if (active) { row.status = 'done'; out = 'Okay, I stopped. Mention me again to start over.'; }
        else out = "There's nothing to stop. Mention me to start.";
      } else if (!active) {
        const turn = await engine.start(hook.flowId, hook.context || {}, hook.flowVersion ? { version: hook.flowVersion } : undefined);
        t = FC.describeTurn(turn); t.turnJson = turn;
        out = FC.renderTurn(t);
        if (t.status === 'in_progress') out += '\n' + HELP_HINT;
      } else {
        const prev = FC.describeTurn(row.lastTurn);
        const turn = await engine.input(row.sessionId, FC.replyInput(prev, text));
        t = FC.describeTurn(turn); t.turnJson = turn;
        out = FC.renderTurn(t);
      }
    } catch (e) {
      hook.lastError = e.message;
      return { status: 200, body: message('Sorry, something went wrong. Please try again.') };
    } finally { current = null; }

    if (t && t.sessionId) {
      row.sessionId = t.sessionId; row.lastTurn = t.turnJson;
      if (t.status === 'in_progress') {
        row.status = 'active';
        if (t.secret) out += '\nCareful: everyone in this channel can read your answer.';
      } else {
        row.status = 'done';
        out += '\nMention me again to start over.';
      }
    }
    if (!row.status) row.status = 'done';
    row.lastActivityId = actId;
    row.lastResponse = message(out);
    conversations.set(key, row);
    return { status: 200, body: row.lastResponse };
  }

  return { handle: handle, conversations: conversations };
}

// A Teams outgoing-webhook activity, as Teams sends it (for tests and tools/teams-send.js).
function activity(o) {
  const id = o.id || String(Date.now()) + Math.floor(Math.random() * 1000);
  return {
    type: 'message', id: id, timestamp: o.timestamp || new Date().toISOString(),
    serviceUrl: 'https://smba.trafficmanager.net/emea/', channelId: 'msteams',
    from: { id: '29:' + o.aadObjectId, name: o.name || 'Test User', aadObjectId: o.aadObjectId },
    conversation: { isGroup: true, conversationType: 'channel', tenantId: o.tenantId || null,
                    id: o.conversationId || '19:test@thread.skype;messageid=1' },
    textFormat: 'plain',
    text: '<at>' + (o.botName || 'FlowChat') + '</at> ' + (o.text || ''),
    channelData: { tenant: { id: o.tenantId || null } }
  };
}

module.exports = { createTeamsHandler, signBody, signatureOk, cleanText, toHtml, tooOld, activity };
