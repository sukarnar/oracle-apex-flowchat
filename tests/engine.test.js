// Run: node flowchat/tests/engine.test.js
const assert = require('assert');
const path = require('path');
const { createEngine, parseValue } = require('../widget/flowchat-engine.js');
const flow = require('../flows/loan_application.json');

global.window = global;
require('../demo/demo-connectors.js');
const connectors = global.FlowChatDemoConnectors;

const last = (t) => t.messages[t.messages.length - 1];
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

(async () => {
  console.log('parseValue');
  await test('number shorthand', () => {
    assert.strictEqual(parseValue({ kind: 'number' }, '25k').value, 25000);
    assert.strictEqual(parseValue({ kind: 'number' }, '$1,250.50').value, 1250.5);
    assert.ok(parseValue({ kind: 'number' }, 'lots').error);
  });
  await test('dates', () => {
    assert.strictEqual(parseValue({ kind: 'date' }, '31/12/2030').value, '2030-12-31');
    assert.ok(parseValue({ kind: 'date' }, '2030-02-30').error);
  });
  await test('choice by label / index', () => {
    const spec = flow.nodes.find((n) => n.id === 'ask_purpose').input;
    assert.strictEqual(parseValue(spec, 'car').value, 'CAR');
    assert.strictEqual(parseValue(spec, '3').value, 'EDU');
  });

  console.log('engine');
  const eng = createEngine({ flows: [flow], connectors });

  await test('new customer, big loan, phone path, submit', async () => {
    let t = await eng.start('loan_application');
    assert.strictEqual(t.await.slot, 'email');
    assert.strictEqual(t.messages.length, 2);

    t = await eng.input(t.sessionId, { value: 'x@mailinator.com' });
    assert.strictEqual(last(t).type, 'error');
    assert.strictEqual(t.await.slot, 'email');

    t = await eng.input(t.sessionId, { value: 'New.Person@Acme.com' });
    assert.strictEqual(t.await.slot, 'applicant_name');
    assert.deepStrictEqual(t.fieldUpdates.map((u) => u.slot), ['email']);
    assert.strictEqual(t.fieldUpdates[0].value, 'new.person@acme.com');
    assert.strictEqual(t.fieldUpdates[0].binding.apex, 'P10_EMAIL');

    t = await eng.input(t.sessionId, { value: 'Ann Lee' });
    assert.match(last(t).text, /Ann Lee/);
    t = await eng.input(t.sessionId, { value: '200k' });
    t = await eng.input(t.sessionId, { value: 'car' });
    assert.strictEqual(t.await.slot, 'annual_income');            // branch taken
    t = await eng.input(t.sessionId, { value: '30000' });          // 5x = 150k < 200k
    assert.strictEqual(last(t).type, 'error');
    t = await eng.input(t.sessionId, { value: '60000' });
    assert.strictEqual(t.await.slot, 'start_date');
    t = await eng.input(t.sessionId, { value: '2001-01-01' });
    assert.strictEqual(last(t).type, 'error');
    t = await eng.input(t.sessionId, { value: 'tomorrow' });
    t = await eng.input(t.sessionId, { value: 'yes' });
    assert.strictEqual(t.await.slot, 'phone');
    t = await eng.input(t.sessionId, { value: 'call me' });
    assert.strictEqual(last(t).type, 'error');
    t = await eng.input(t.sessionId, { value: '+1 555 123 4567' });
    assert.strictEqual(t.await.type, 'summary');
    const card = last(t);
    assert.strictEqual(card.type, 'summary');
    assert.deepStrictEqual(card.items.find((i) => i.slot === 'amount').display, '$200,000');
    assert.deepStrictEqual(card.items.find((i) => i.slot === 'purpose').display, 'Car');

    t = await eng.input(t.sessionId, { value: 'confirm' });
    assert.strictEqual(t.status, 'completed');
    assert.strictEqual(t.await, null);
    assert.match(last(t).text, /LN-\d{5}/);
    assert.ok(t.fieldUpdates.some((u) => u.slot === 'reference'));
  });

  await test('lookup prefills known customer and skips name', async () => {
    let t = await eng.start('loan_application');
    t = await eng.input(t.sessionId, { value: 'jane.doe@example.com' });
    assert.strictEqual(t.await.slot, 'amount');
    assert.ok(t.messages.some((m) => /Welcome back, Jane/.test(m.text)));
    assert.ok(t.fieldUpdates.some((u) => u.slot === 'applicant_name' && u.value === 'Jane Doe'));
  });

  await test('edit from summary replays branching (new question appears)', async () => {
    let t = await eng.start('loan_application');
    const sid = t.sessionId;
    for (const v of ['raj.kumar@example.com', '50000', 'home', 'tomorrow', 'no']) t = await eng.input(sid, { value: v });
    assert.strictEqual(t.await.type, 'summary');
    t = await eng.input(sid, { command: 'edit', slot: 'amount' });
    assert.strictEqual(t.await.slot, 'amount');
    assert.strictEqual(t.await.value, 50000);
    t = await eng.input(sid, { value: '300000' });
    assert.strictEqual(t.await.slot, 'annual_income', 'branch re-evaluated after edit');
    assert.strictEqual(t.messages.filter((m) => m.type === 'text').length, 1, 'replay suppresses messages');
    t = await eng.input(sid, { value: '90000' });
    assert.strictEqual(t.await.type, 'summary', 'replay skips already-answered questions');
  });

  await test('back returns to previous question', async () => {
    let t = await eng.start('loan_application');
    t = await eng.input(t.sessionId, { value: 'a@b.co' });
    t = await eng.input(t.sessionId, { value: 'Al Bo' });
    assert.strictEqual(t.canGoBack, true);
    t = await eng.input(t.sessionId, { command: 'back' });
    assert.strictEqual(t.await.slot, 'applicant_name');
    assert.strictEqual(t.await.value, 'Al Bo');
  });

  await test('restart clears slots and bound fields', async () => {
    let t = await eng.start('loan_application');
    t = await eng.input(t.sessionId, { value: 'a@b.co' });
    t = await eng.input(t.sessionId, { command: 'restart' });
    assert.strictEqual(t.await.slot, 'email');
    assert.ok(t.fieldUpdates.some((u) => u.slot === 'email' && u.value === null));
  });

  await test('context prefill', async () => {
    const t = await eng.start('loan_application', { email: 'jane.doe@example.com', unknown_key: 'x' });
    assert.strictEqual(eng.getState(t.sessionId).slots.email, 'jane.doe@example.com');
    assert.strictEqual(eng.getState(t.sessionId).slots.unknown_key, undefined);
  });

  console.log(`\n${passed} passed`);
})();
