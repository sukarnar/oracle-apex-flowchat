// Run: node tests/verify.test.js
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');
const flow = require('../flows/update_application_public.json');
const demoData = require('../demo/demo-data-sources.js');

const last = (t) => t.messages[t.messages.length - 1];
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}
function setup(opts) {
  const outbox = [];
  const src = demoData.createPublic(FC);
  const seen = [];
  const wrapped = {
    fields: src.fields, rows: src.rows,
    search: (r) => { seen.push(r); return src.search(r); }, get: (r) => src.get(r), update: (r) => src.update(r)
  };
  const send_code = (p) => {
    if (opts && opts.failSend) return { ok: false, message: 'Mail is down.' };
    outbox.push(p); return { ok: true };
  };
  const eng = FC.createEngine({ flows: [flow], connectors: { send_code }, dataSources: { loan_apps_public: wrapped } });
  return { eng, outbox, seen, code: () => outbox[outbox.length - 1].code };
}
const wrongOf = (c) => c.split('').map((d) => String((Number(d) + 1) % 10)).join('');

(async () => {
  console.log('verify step');
  await test('sends a code, stores only a hash, and continues after the right code', async () => {
    const { eng, outbox, code } = setup();
    let t = await eng.start('update_application_public');
    t = await eng.input(t.sessionId, { value: 'jane.doe@example.com' });
    assert.strictEqual(outbox.length, 1);
    assert.strictEqual(outbox[0].to, 'jane.doe@example.com');
    assert.match(outbox[0].code, /^\d{6}$/);
    assert.strictEqual(t.await.type, 'ask');
    assert.strictEqual(t.await.secret, true);
    assert.strictEqual(t.await.input.autocomplete, 'one-time-code');
    assert.deepStrictEqual(t.await.actions.map((a) => a.command), ['resend']);
    assert.ok(!JSON.stringify(t).includes(code()), 'the code never appears in a turn');
    assert.ok(!JSON.stringify(eng.getState(t.sessionId)).includes(code()), 'the code is not kept in the session');

    t = await eng.input(t.sessionId, { value: code() });
    assert.strictEqual(t.await.slot, 'reference', 'goes on to the next question');
    t = await eng.input(t.sessionId, { value: '' });
    assert.strictEqual(t.await.type, 'pick');
    assert.strictEqual(t.await.items.length, 2);
  });

  await test('wrong codes count down, then the flow stops on the failed branch', async () => {
    const { eng, code } = setup();
    let t = await eng.start('update_application_public');
    t = await eng.input(t.sessionId, { value: 'jane.doe@example.com' });
    const bad = wrongOf(code());
    t = await eng.input(t.sessionId, { value: bad });
    assert.match(last(t).text, /2 more tries/);
    t = await eng.input(t.sessionId, { value: bad });
    assert.match(last(t).text, /1 more try\b/);
    t = await eng.input(t.sessionId, { value: bad });
    assert.strictEqual(t.status, 'completed');
    assert.match(last(t).text, /For your security/);
  });

  await test('resend issues a new code (old one stops working) and is limited', async () => {
    const { eng, outbox } = setup();
    let t = await eng.start('update_application_public');
    t = await eng.input(t.sessionId, { value: 'jane.doe@example.com' });
    const first = outbox[0].code;
    t = await eng.input(t.sessionId, { command: 'resend' });
    t = await eng.input(t.sessionId, { command: 'resend' });
    assert.strictEqual(outbox.length, 3);
    t = await eng.input(t.sessionId, { command: 'resend' });
    assert.strictEqual(outbox.length, 3, 'maxResends 2');
    assert.strictEqual(last(t).type, 'error');
    if (first !== outbox[2].code) {
      t = await eng.input(t.sessionId, { value: first });
      assert.strictEqual(last(t).type, 'error', 'superseded code is rejected');
    }
    t = await eng.input(t.sessionId, { value: outbox[2].code });
    assert.strictEqual(t.await.slot, 'reference');
  });

  await test('an expired code is replaced automatically', async () => {
    const { eng, outbox } = setup();
    let t = await eng.start('update_application_public');
    t = await eng.input(t.sessionId, { value: 'jane.doe@example.com' });
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60000;
    try {
      t = await eng.input(t.sessionId, { value: outbox[0].code });
    } finally { Date.now = realNow; }
    assert.match(last(t).text, /expired/);
    assert.strictEqual(outbox.length, 2);
    t = await eng.input(t.sessionId, { value: outbox[1].code });
    assert.strictEqual(t.await.slot, 'reference');
  });

  await test('changing the email afterwards needs a fresh verification', async () => {
    const { eng, outbox, code, seen } = setup();
    let t = await eng.start('update_application_public');
    t = await eng.input(t.sessionId, { value: 'jane.doe@example.com' });
    t = await eng.input(t.sessionId, { value: code() });
    t = await eng.input(t.sessionId, { command: 'back' });
    assert.strictEqual(t.await.slot, 'email', 'back skips the passed verify step');
    t = await eng.input(t.sessionId, { value: 'raj.kumar@example.com' });
    assert.strictEqual(outbox.length, 2);
    assert.strictEqual(outbox[1].to, 'raj.kumar@example.com');
    assert.strictEqual(t.await.slot, '#code');
    t = await eng.input(t.sessionId, { value: code() });
    t = await eng.input(t.sessionId, { value: '' });
    assert.strictEqual(t.await.type, 'fieldMenu', 'single match loads directly');
    assert.strictEqual(seen[seen.length - 1].verified, 'raj.kumar@example.com', 'data source receives the verified identity');
  });

  await test('the data source hides rows of other identities', async () => {
    const src = demoData.createPublic(FC);
    const crit = [{ field: 'email', op: 'eq', value: 'jane.doe@example.com' }];
    assert.strictEqual(src.search({ criteria: crit }).length, 0, 'nothing without verification');
    assert.strictEqual(src.search({ criteria: crit, verified: 'raj.kumar@example.com' }).length, 0);
    assert.strictEqual(src.search({ criteria: crit, verified: 'Jane.Doe@example.com' }).length, 2);
    assert.strictEqual(src.get({ key: 1041, verified: 'raj.kumar@example.com' }), null);
  });

  await test('findRecord with requireVerified refuses to search unverified identities', async () => {
    const bad = JSON.parse(JSON.stringify(flow));
    bad.flowId = 'skips_verify';
    bad.nodes.find((n) => n.id === 'ask_email').next = 'ask_ref';
    const src = demoData.createPublic(FC);
    const eng = FC.createEngine({ flows: [bad], dataSources: { loan_apps_public: src } });
    let t = await eng.start('skips_verify');
    t = await eng.input(t.sessionId, { value: 'jane.doe@example.com' });
    t = await eng.input(t.sessionId, { value: '' });
    assert.strictEqual(t.status, 'failed');
    assert.match(last(t).text, /verified/);
  });

  await test('a failing send goes to the failed branch', async () => {
    const { eng } = setup({ failSend: true });
    let t = await eng.start('update_application_public');
    t = await eng.input(t.sessionId, { value: 'jane.doe@example.com' });
    assert.ok(t.messages.some((m) => m.type === 'error' && /Mail is down/.test(m.text)));
    assert.strictEqual(t.status, 'completed');
  });

  await test('restart clears verification', async () => {
    const { eng, outbox, code } = setup();
    let t = await eng.start('update_application_public');
    t = await eng.input(t.sessionId, { value: 'jane.doe@example.com' });
    t = await eng.input(t.sessionId, { value: code() });
    t = await eng.input(t.sessionId, { command: 'restart' });
    t = await eng.input(t.sessionId, { value: 'jane.doe@example.com' });
    assert.strictEqual(outbox.length, 2);
    assert.strictEqual(t.await.slot, '#code');
  });

  console.log('\n' + passed + ' passed');
})();
