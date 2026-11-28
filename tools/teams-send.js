#!/usr/bin/env node
// Talks to the FC_TEAMS endpoint the way Teams does (signed outgoing-webhook messages), so you can
// test it before setting up Teams. Needs Node 18+.
//
//   node tools/teams-send.js --url https://host/ords/myschema/flowchat/teams/travel \
//        --token <security token> --user <Entra object id> [--tenant <tenant id>] [--thread t1] [text]
//
// With text it sends one message; without, it chats until you type /quit. --thread picks the Teams
// thread (each thread is its own conversation).
'use strict';
const readline = require('readline');
const T = require('./flowchat-teams.js');

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
    else o._.push(argv[i]);
  }
  return o;
}
function plain(html) {
  return String(html || '').replace(/<br>/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function send(o, text) {
  const body = JSON.stringify(T.activity({
    aadObjectId: o.user, name: o.name || 'Test User', tenantId: o.tenant || null, text: text,
    conversationId: '19:flowchat-test@thread.skype;messageid=' + (o.thread || '1')
  }));
  const res = await fetch(o.url, {
    method: 'POST', body: body,
    headers: { 'Content-Type': 'application/json', Authorization: T.signBody(body, o.token) }
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch (e) { /* not JSON */ }
  if (!res.ok) return 'HTTP ' + res.status + ': ' + (json && json.error ? json.error : raw);
  return json && json.text !== undefined ? plain(json.text) : raw;
}

(async () => {
  const o = args(process.argv.slice(2));
  if (!o.url || !o.token || !o.user) {
    console.error('Usage: node tools/teams-send.js --url <callback url> --token <security token> --user <Entra object id> [--tenant id] [--thread t] [text]');
    process.exit(2);
  }
  if (o._.length) { console.log(await send(o, o._.join(' '))); return; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  console.log('Type a reply (you don\'t need the @mention). /quit ends.');
  rl.prompt();
  for await (const line of rl) {
    if (line.trim() === '/quit') break;
    try { console.log(await send(o, line)); } catch (e) { console.log('Error: ' + e.message); }
    rl.prompt();
  }
  rl.close();
})();
