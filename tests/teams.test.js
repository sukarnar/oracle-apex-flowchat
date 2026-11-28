// Run: node tests/teams.test.js
// Microsoft Teams outgoing webhooks (tools/flowchat-teams.js): the reference for FC_TEAMS in
// db/20_fc_teams.sql.
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');
const T = require('../tools/flowchat-teams.js');
const trip = require('../flows/trip_booking.json');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}

const TOKEN = Buffer.from('a-test-security-token-of-32bytes').toString('base64');
const ANA = '6b1f3c1e-2a4d-4f2b-9b1a-0a1b2c3d4e5f', BOB = '9c2e4d6f-0000-4f2b-9b1a-0a1b2c3d4e5f';

function setup(extra) {
  const seen = [];
  const teams = T.createTeamsHandler(Object.assign({
    engine: (appUser) => FC.createEngine({
      flows: [Object.assign({}, trip, { debug: false })], appUser: appUser,
      connectors: {
        trip_get_profile: (p) => { seen.push(p.appUser); return { found: true, slots: { editable_trips: 0, cancellable_trips: 0, emergency_contacts: [] } }; },
        trip_save: () => ({ ok: true, slots: { trip_id: 101, itinerary_no: 'FY26-1', trip_status: 'SAVED' } }),
        trip_mark_pending: () => ({ found: true, slots: { trip_status: 'PENDING_APPROVAL' } })
      },
      lovs: { trip_my_editable: () => [], trip_my_cancellable: () => [] },
      startWorkflow: () => ({ workflowId: 1 })
    }),
    webhooks: { travel: { securityToken: TOKEN, flowId: 'trip_booking', tenantId: 'tenant-1', maxAgeSecs: 300 } },
    users: { [ANA]: 'JDOE' }
  }, extra || {}));
  async function say(text, o) {
    o = o || {};
    const body = JSON.stringify(T.activity(Object.assign({ aadObjectId: ANA, tenantId: 'tenant-1', text: text }, o)));
    return teams.handle(o.webhook || 'travel', body, o.auth || T.signBody(body, TOKEN));
  }
  return { teams, say, seen };
}
const text = (r) => r.body.text.replace(/<br>/g, '\n');

(async () => {
  console.log('teams.test.js');

  await test('signature: Teams HMAC-SHA256 over the raw body', async () => {
    const body = '{"type":"message","text":"hi"}';
    const sig = T.signBody(body, TOKEN);
    assert.ok(/^HMAC [A-Za-z0-9+/]+=*$/.test(sig));
    assert.ok(T.signatureOk(body, sig, TOKEN));
    assert.ok(!T.signatureOk(body + ' ', sig, TOKEN));
    assert.ok(!T.signatureOk(body, sig, Buffer.from('another token').toString('base64')));
    assert.ok(!T.signatureOk(body, null, TOKEN));
  });

  await test('the text typed: mention and HTML removed, entities decoded', async () => {
    assert.strictEqual(T.cleanText('<at>Travel Bot</at>&nbsp;2'), '2');
    assert.strictEqual(T.cleanText('<p><at>Bot</at> Rock &amp; Roll &lt;3</p>\n'), 'Rock & Roll <3');
    assert.strictEqual(T.toHtml('a < b & c\nnext'), 'a &lt; b &amp; c<br>next');
  });

  await test('refused: bad signature, unknown webhook, another tenant, a stale message, not Teams', async () => {
    const { say, teams } = setup();
    assert.strictEqual((await say('hi', { auth: 'HMAC abc=' })).status, 401);
    assert.strictEqual((await say('hi', { webhook: 'nope' })).status, 404);
    assert.strictEqual((await say('hi', { tenantId: 'tenant-2' })).status, 403);
    assert.strictEqual((await say('hi', { timestamp: new Date(Date.now() - 3600e3).toISOString() })).status, 401);
    const body = '{"type":"message","text":"hi"}';
    assert.strictEqual((await teams.handle('travel', body, T.signBody(body, TOKEN))).status, 400);
  });

  await test('an unknown Teams account is told its id, and nothing starts', async () => {
    const { say, teams } = setup();
    const r = await say('hi', { aadObjectId: BOB });
    assert.strictEqual(r.status, 200);
    assert.ok(text(r).includes(BOB), text(r));
    assert.strictEqual(teams.conversations.size, 0);
  });

  await test('the first mention starts the flow as the linked user', async () => {
    const { say, seen } = setup();
    const r = await say('hello');
    assert.strictEqual(r.body.type, 'message');
    assert.ok(/Hi JDOE/.test(text(r)), text(r));
    assert.ok(/full name\?/.test(text(r)));
    assert.ok(/mention me each time/.test(text(r)));
    assert.deepStrictEqual(seen, ['JDOE']);
  });

  await test('replies answer the flow: typed text, an option number, list commands', async () => {
    const { say, teams } = setup();
    await say('hello');
    let r = await say('Ana Doe');
    assert.ok(/1\. Spouse \/ partner/.test(text(r)), text(r));
    r = await say('1');
    assert.ok(/phone number/.test(text(r)), text(r));
    r = await say('+1 555 123 4567');
    r = await say('ana@example.com');
    assert.ok(/Reply ADD, .*DONE\./.test(text(r)), text(r));
    r = await say('done');
    assert.ok(/1\. Personal vacation/.test(text(r)), text(r));
    const row = [...teams.conversations.values()][0];
    assert.strictEqual(row.status, 'active');
  });

  await test('each thread, and each person, is its own conversation', async () => {
    const { say, teams } = setup({ users: { [ANA]: 'JDOE', [BOB]: 'BSMITH' } });
    await say('hello');
    await say('hello', { aadObjectId: BOB });
    await say('hello', { conversationId: '19:test@thread.skype;messageid=2' });
    assert.strictEqual(teams.conversations.size, 3);
    const r = await say('Bob Smith', { aadObjectId: BOB });
    assert.ok(/How is Bob Smith related to you/.test(text(r)), text(r));
  });

  await test('Teams sending the same message twice answers once', async () => {
    const { say, teams } = setup();
    await say('hello');
    const a = await say('Ana Doe', { id: 'act-7' });
    const b = await say('Ana Doe', { id: 'act-7' });
    assert.deepStrictEqual(a.body, b.body);
    const r = await say('2');
    assert.ok(/phone number/.test(text(r)), text(r));   // still the same contact: the name went in once
    assert.ok([...teams.conversations.values()][0].status === 'active');
  });

  await test('HELP, STOP and starting again', async () => {
    const { say, teams } = setup();
    assert.ok(/Mention me in a thread to start/.test(text(await say('help'))));
    await say('hello');
    assert.ok(/BACK goes to the previous question/.test(text(await say('help'))));
    assert.ok(/I stopped/.test(text(await say('stop'))));
    assert.strictEqual([...teams.conversations.values()][0].status, 'done');
    assert.ok(/nothing to stop/.test(text(await say('stop'))));
    const r = await say('again');
    assert.ok(/full name\?/.test(text(r)), text(r));
  });

  await test('a user resolver instead of the users table', async () => {
    const { say, seen } = setup({ users: {}, resolveUser: (aad, name) => (aad === ANA ? 'ANA_FROM_HR' : null) });
    await say('hello');
    assert.deepStrictEqual(seen, ['ANA_FROM_HR']);
  });

  console.log(passed + ' passed');
})();
