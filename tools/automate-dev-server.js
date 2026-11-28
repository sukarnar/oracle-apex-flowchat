#!/usr/bin/env node
// A local stand-in for the FC_AUTOMATE endpoints (no database), for trying and testing clients such as
// tools/windows-client/flowchat_client.py:
//   POST /flowchat/automate/turn   {flowId, user, sessionId, reply}   header X-FlowChat-Key
//   POST /flowchat/automate/flows  {user}                             header X-FlowChat-Key
//
//   node tools/automate-dev-server.js --key dev-key --map "CORP\jdoe=JDOE:it_helpdesk,trip_booking"
//
// Options:
//   --port N        default 8790 (0 = any free port; the port is printed as "listening on <port>")
//   --key K         the API key (default dev-key)
//   --mode M        TABLE (default), UPN or LOCAL, as fc_automate.add_client's p_user_mode
//   --flows a,b     flows the key may run (default: any)
//   --default ID    the default flow
//   --map "upn=APPUSER[:flow1,flow2]"   repeatable; TABLE mode users and their registered flows
// Every flow in flows/ is published. Connectors are stubs: the help desk ones keep tickets in memory,
// any other connector answers {ok: true, found: false}; lookup lists are empty.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const FC = require('../widget/flowchat-engine.js');
const C = require('./flowchat-cards.js');

function args(argv) {
  const o = { port: 8790, key: 'dev-key', mode: 'TABLE', flows: null, def: null, map: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--port') { o.port = parseInt(v, 10); i++; }
    else if (a === '--key') { o.key = v; i++; }
    else if (a === '--mode') { o.mode = String(v).toUpperCase(); i++; }
    else if (a === '--flows') { o.flows = v.split(',').map((x) => x.trim()).filter(Boolean); i++; }
    else if (a === '--default') { o.def = v; i++; }
    else if (a === '--map') { o.map.push(v); i++; }
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 18).join('\n')); process.exit(0); }
    else { console.error('unknown option ' + a); process.exit(2); }
  }
  return o;
}

function loadFlows() {
  const dir = path.join(__dirname, '..', 'flows');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'flow.schema.json')
    .map((f) => Object.assign(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), { debug: false }));
}

// Connector and lookup-list names a flow uses, so each gets a stub.
function namesUsed(flows) {
  const conns = new Set(), lovs = new Set();
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    if (typeof x.connector === 'string') conns.add(x.connector);
    if (typeof x.optionsFrom === 'string') lovs.add(x.optionsFrom);
    Object.keys(x).forEach((k) => walk(x[k]));
  };
  flows.forEach(walk);
  return { conns: [...conns], lovs: [...lovs] };
}

function createServer(o) {
  const flows = loadFlows();
  const used = namesUsed(flows);
  const tickets = [];
  let seq = 1000;
  const open = (u) => tickets.filter((t) => t.reporter === u && t.status === 'OPEN');
  const connectors = {};
  used.conns.forEach((n) => { connectors[n] = () => ({ ok: true, found: false }); });
  Object.assign(connectors, {
    it_my_tickets: (p) => ({ found: true, slots: { open_tickets: open(p.appUser).length,
      ticket_list: open(p.appUser).map((t) => t.ticketNo + ' ' + t.title).join('\n') } }),
    it_create_ticket: (p) => {
      const s = p.slots, no = 'IT-' + (++seq);
      const pri = s.impact === 'SITE' && s.urgency === 'HIGH' ? 'P1' : s.impact === 'SITE' || s.urgency === 'HIGH' ? 'P2' : 'P3';
      tickets.push({ ticketNo: no, id: seq, reporter: p.appUser, status: 'OPEN', title: s.title });
      return { ok: true, slots: { ticket_no: no, priority: pri } };
    },
    it_close_ticket: (p) => {
      const t = open(p.appUser).find((x) => String(x.id) === String(p.slots.close_ticket_id));
      if (!t) return { found: false };
      t.status = 'CLOSED';
      return { found: true, slots: { close_ticket_no: t.ticketNo } };
    }
  });
  const lovs = {};
  used.lovs.forEach((n) => { lovs[n] = () => []; });
  lovs.it_my_open_tickets = (r) => open(r.appUser).map((t) => ({ value: String(t.id), label: t.ticketNo + ' - ' + t.title }));

  const users = {};
  o.map.forEach((m) => {
    const eq = m.indexOf('=');
    if (eq < 1) throw new Error('--map needs upn=APPUSER[:flows]: ' + m);
    const upn = m.slice(0, eq).trim().toLowerCase(), rest = m.slice(eq + 1);
    const colon = rest.indexOf(':');
    users[upn] = { appUser: (colon < 0 ? rest : rest.slice(0, colon)).trim(),
                   flows: colon < 0 ? null : rest.slice(colon + 1).split(',').map((x) => x.trim()).filter(Boolean) };
  });

  const h = C.createAutomateHandler({
    engine: (appUser) => FC.createEngine({ flows: flows, appUser: appUser, connectors: connectors, lovs: lovs }),
    clients: { dev: { key: o.key, flows: o.flows, defaultFlow: o.def, userMode: o.mode } },
    users: users,
    catalog: flows.map((f) => ({ flowId: f.flowId, name: f.name, description: f.description, version: f.version }))
  });

  return http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const route = (req.url || '').split('?')[0].replace(/\/+$/, '');
    const fn = route.endsWith('/flowchat/automate/turn') ? h.handle : route.endsWith('/flowchat/automate/flows') ? h.listFlows : null;
    if (!fn) return send(404, { error: 'Not found' });
    if (req.method !== 'POST') return send(405, { error: 'Use POST' });
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const r = await fn(req.headers['x-flowchat-key'] || '', body);
        send(r.status, r.body);
      } catch (e) { send(500, { error: String(e && e.message || e) }); }
    });
  });
}

if (require.main === module) {
  const o = args(process.argv.slice(2));
  const srv = createServer(o);
  srv.listen(o.port, '127.0.0.1', () => {
    const port = srv.address().port;
    console.log('listening on ' + port);
    console.log('URL: http://127.0.0.1:' + port + '/flowchat/automate   (mode ' + o.mode + ', ' + o.map.length + ' mapped user(s))');
  });
}
module.exports = { createServer };
