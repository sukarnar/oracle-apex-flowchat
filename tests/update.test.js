// Run: node tests/update.test.js
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');
const flow = require('../flows/update_application.json');
const demoData = require('../demo/demo-data-sources.js');

const last = (t) => t.messages[t.messages.length - 1];
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}
function setup() {
  const src = demoData.create(FC);
  const eng = FC.createEngine({ flows: [flow], dataSources: { loan_apps: src } });
  return { eng, src, row: (id) => src.rows.find((r) => r.app_id === id) };
}
async function answers(eng, sid, list) {
  let t;
  for (const p of list) t = await eng.input(sid, typeof p === 'string' ? { value: p } : p);
  return t;
}

(async () => {
  console.log('memory source');
  await test('search masks, get does not, update enforces whitelist + version', () => {
    const { src } = setup();
    const res = src.search({ criteria: [{ field: 'email', op: 'eq', value: 'JANE.DOE@example.com' }], limit: 10 });
    assert.strictEqual(res.length, 2);
    assert.strictEqual(res[0].values.phone, '•••• 4567');
    assert.strictEqual(src.get({ key: 1041 }).values.phone, '+1 555 123 4567');
    assert.strictEqual(src.update({ key: 1041, version: 1, changes: { status: 'APPROVED' } }).status, 'forbidden');
    assert.strictEqual(src.update({ key: 1041, version: 9, changes: { phone: '1' } }).status, 'conflict');
    assert.throws(() => src.search({ criteria: [{ field: 'phone', value: 'x' }] }), /not searchable/);
  });

  console.log('update flow');
  await test('multiple matches -> pick card -> change phone -> diff -> save', async () => {
    const { eng, row } = setup();
    let t = await eng.start('update_application');
    t = await answers(eng, t.sessionId, ['jane.doe@example.com', '']);
    assert.strictEqual(t.await.type, 'pick');
    assert.strictEqual(t.await.items.length, 2);
    assert.match(t.await.items[0].subtitle, /•••• 4567/, 'cards show masked values');
    assert.ok(!JSON.stringify(t).includes('1041,'), 'keys never leave the server');

    t = await eng.input(t.sessionId, { pick: t.await.items[0].token });
    assert.strictEqual(t.await.type, 'fieldMenu');
    assert.ok(t.messages.some((m) => m.type === 'record'));
    assert.ok(t.fieldUpdates.some((u) => u.slot === 'app.phone' && u.binding.dom === '#u_phone'));

    t = await eng.input(t.sessionId, { field: 'phone' });
    assert.strictEqual(t.await.type, 'ask');
    assert.strictEqual(t.await.sub, true);
    assert.match(last(t).text, /currently \+1 555 123 4567/);
    t = await eng.input(t.sessionId, { value: 'call me' });
    assert.strictEqual(last(t).type, 'error');
    t = await eng.input(t.sessionId, { value: '+1 555 999 0000' });
    assert.strictEqual(t.await.type, 'fieldMenu');
    assert.strictEqual(t.await.fields.find((f) => f.field === 'phone').changed, true);

    t = await eng.input(t.sessionId, { command: 'done' });
    assert.strictEqual(t.await.type, 'summary');
    const diff = last(t);
    assert.strictEqual(diff.type, 'changes');
    assert.deepStrictEqual(diff.items.map((i) => [i.label, i.before, i.after]), [['Phone', '+1 555 123 4567', '+1 555 999 0000']]);

    t = await eng.input(t.sessionId, { value: 'confirm' });
    assert.strictEqual(t.status, 'completed');
    assert.match(last(t).text, /LN-01041 is up to date/);
    assert.strictEqual(row(1041).phone, '+1 555 999 0000');
    assert.strictEqual(row(1041).version, 2);
  });

  await test('single match auto-picks; locked field is not editable', async () => {
    const { eng } = setup();
    let t = await eng.start('update_application');
    t = await answers(eng, t.sessionId, ['jane.doe@example.com', 'LN-00988']);
    assert.strictEqual(t.await.type, 'fieldMenu');
    const amt = t.await.fields.find((f) => f.field === 'amount');
    assert.strictEqual(amt.editable, false);
    assert.match(amt.reason, /under review/);
    t = await eng.input(t.sessionId, { field: 'amount' });
    assert.strictEqual(last(t).type, 'error');
    assert.strictEqual(t.await.type, 'fieldMenu');
  });

  await test('not found loops back to the email question', async () => {
    const { eng } = setup();
    let t = await eng.start('update_application');
    t = await answers(eng, t.sessionId, ['nobody@example.com', '']);
    assert.strictEqual(t.await.slot, 'email');
    assert.ok(t.messages.some((m) => /couldn't find/.test(m.text)));
  });

  await test('"None of these" goes to the cancelled path', async () => {
    const { eng } = setup();
    let t = await eng.start('update_application');
    t = await answers(eng, t.sessionId, ['jane.doe@example.com', '']);
    t = await eng.input(t.sessionId, { pick: null });
    assert.strictEqual(t.await.slot, 'email');
  });

  await test('conflict reloads latest values, keeps my change, re-reviews', async () => {
    const { eng, row } = setup();
    let t = await eng.start('update_application');
    t = await answers(eng, t.sessionId, ['raj.kumar@example.com', '', { field: 'amount' }, '60k', { command: 'done' }]);
    assert.strictEqual(last(t).items[0].after, '$60,000');
    // someone else edits the row meanwhile
    Object.assign(row(1050), { phone: '+44 20 0000 1111', version: 2 });
    t = await eng.input(t.sessionId, { value: 'confirm' });
    assert.strictEqual(t.await.type, 'summary', 'routed back to review');
    assert.ok(t.messages.some((m) => m.type === 'error' && /Someone else changed/.test(m.text)));
    assert.ok(t.fieldUpdates.some((u) => u.slot === 'app.phone' && u.value === '+44 20 0000 1111'), 'fresh values pushed to page');
    t = await eng.input(t.sessionId, { value: 'confirm' });
    assert.strictEqual(t.status, 'completed');
    assert.strictEqual(row(1050).amount, 60000);
    assert.strictEqual(row(1050).phone, '+44 20 0000 1111', 'other user\'s change preserved');
    assert.strictEqual(row(1050).version, 3);
  });

  await test('edit from the diff card, keep current, and no-changes path', async () => {
    const { eng } = setup();
    let t = await eng.start('update_application');
    t = await answers(eng, t.sessionId, ['raj.kumar@example.com', '', { field: 'contact_ok' }, 'no', { command: 'done' }]);
    t = await eng.input(t.sessionId, { command: 'edit', slot: 'app.contact_ok' });
    assert.strictEqual(t.await.slot, 'app.contact_ok');
    t = await eng.input(t.sessionId, { value: 'yes' });          // back to original value
    t = await eng.input(t.sessionId, { field: 'phone' });
    t = await eng.input(t.sessionId, { command: 'back' });       // keep current
    assert.strictEqual(t.await.type, 'fieldMenu');
    t = await eng.input(t.sessionId, { command: 'done' });
    assert.strictEqual(t.status, 'completed');
    assert.match(last(t).text, /No changes were made to LN-01050/);
  });

  await test('server rejects a change to a non-updatable field even if the flow allows it', async () => {
    const { eng } = setup();
    const bad = JSON.parse(JSON.stringify(flow));
    bad.flowId = 'bad_update';
    bad.nodes.find((n) => n.id === 'change').fields.push({ field: 'status', label: 'Status', input: { kind: 'text' } });
    eng.registerFlow(bad);
    let t = await eng.start('bad_update');
    t = await answers(eng, t.sessionId, ['raj.kumar@example.com', '']);
    assert.strictEqual(t.await.fields.find((f) => f.field === 'status').editable, false, 'metadata blocks it in the menu');
  });

  console.log(`\n${passed} passed`);
})();
