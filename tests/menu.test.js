// Run: node tests/menu.test.js
// The Menu node: static options shown as pills, each option leading to its own next node.
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}
const texts = (t) => t.messages.map((m) => m.text || '').join(' | ');

const flow = {
  flowId: 'helpdesk', start: 'main',
  nodes: [
    { id: 'main', type: 'menu', prompt: 'Hi {{app_user}}, what can I help with?', slot: 'topic', label: 'Topic',
      options: [
        { value: 'leave', label: 'Apply for leave', next: 'ask_days' },
        { value: 'payslip', label: 'Payslip question', next: 'payslip' },
        { value: 'admin', label: 'Admin tools', next: 'admin', when: { slot: 'context.role', op: '=', value: 'ADMIN' } },
        { value: 'bye', label: 'Nothing, thanks', next: 'end' }] },
    { id: 'ask_days', type: 'ask', slot: 'days', label: 'Days', prompt: 'How many days?', input: { kind: 'number' }, next: 'more' },
    { id: 'payslip', type: 'message', text: 'Payslips are on the HR portal.', next: 'more' },
    { id: 'admin', type: 'message', text: 'Admin tools are on page 99.', next: 'more' },
    { id: 'more', type: 'menu', prompt: 'Anything else?',
      options: [{ value: 'yes', label: 'Yes', next: 'main' }, { value: 'no', label: 'No', next: 'end' }] },
    { id: 'end', type: 'end', text: 'Bye. Topic was {{topic}}.' }
  ]
};
const engine = (o) => FC.createEngine(Object.assign({ flows: [flow], appUser: 'JSMITH' }, o || {}));

(async () => {
  console.log('menu node');
  await test('shows the options as pills and routes to the chosen option', async () => {
    const eng = engine();
    let t = await eng.start('helpdesk', {});
    assert.match(texts(t), /Hi JSMITH, what can I help with\?/);
    assert.strictEqual(t.await.type, 'ask');
    assert.strictEqual(t.await.input.kind, 'choice');
    assert.strictEqual(t.await.input.display, 'buttons');
    assert.deepStrictEqual(t.await.input.options.map((o) => o.value), ['leave', 'payslip', 'bye']);   // admin hidden
    t = await eng.input(t.sessionId, { value: 'payslip' });
    assert.match(texts(t), /Payslips are on the HR portal\. \| Anything else\?/);
    assert.strictEqual(t.await.slot, '#menu');                              // "more" has no slot
    assert.strictEqual(t.fieldUpdates.find((u) => u.slot === 'topic').display, 'Payslip question');
  });
  await test('accepts the label or the option number as typed text, and rejects anything else', async () => {
    const eng = engine();
    let t = await eng.start('helpdesk', {});
    t = await eng.input(t.sessionId, { value: 'something else' });
    assert.strictEqual(t.messages[0].type, 'error');
    assert.strictEqual(t.await.nodeId, 'main');
    t = await eng.input(t.sessionId, { value: 'apply for leave' });
    assert.strictEqual(t.await.slot, 'days');
    const t2 = await eng.start('helpdesk', {});
    const t3 = await eng.input(t2.sessionId, { value: '3' });              // third shown option
    assert.match(texts(t3), /Bye\. Topic was bye\./);
  });
  await test('a menu can be returned to and shows again (loop back to the main menu)', async () => {
    const eng = engine();
    let t = await eng.start('helpdesk', {});
    t = await eng.input(t.sessionId, { value: 'payslip' });
    t = await eng.input(t.sessionId, { value: 'yes' });
    assert.strictEqual(t.await.nodeId, 'main');
    assert.match(texts(t), /what can I help with/);
    t = await eng.input(t.sessionId, { value: 'leave' });
    t = await eng.input(t.sessionId, { value: '2' });
    t = await eng.input(t.sessionId, { value: 'no' });
    assert.strictEqual(t.status, 'completed');
    assert.match(texts(t), /Topic was leave\./);
  });
  await test('Back from the next step shows the menu again; Edit replays through the chosen option', async () => {
    const eng = engine();
    let t = await eng.start('helpdesk', {});
    t = await eng.input(t.sessionId, { value: 'leave' });
    assert.ok(t.canGoBack);
    t = await eng.input(t.sessionId, { command: 'back' });
    assert.strictEqual(t.await.nodeId, 'main');
    t = await eng.input(t.sessionId, { value: 'leave' });
    t = await eng.input(t.sessionId, { value: '4' });
    assert.strictEqual(t.await.nodeId, 'more');
    t = await eng.input(t.sessionId, { command: 'edit', slot: 'days' });
    t = await eng.input(t.sessionId, { value: '6' });
    assert.strictEqual(t.await.nodeId, 'more');                             // replay followed "leave" again
    assert.strictEqual(eng.getState(t.sessionId).slots.days, 6);
  });
  await test('options with a condition show only when it holds', async () => {
    const eng = engine();
    let t = await eng.start('helpdesk', { role: 'ADMIN' });
    assert.deepStrictEqual(t.await.input.options.map((o) => o.value), ['leave', 'payslip', 'admin', 'bye']);
    t = await eng.input(t.sessionId, { value: 'admin' });
    assert.match(texts(t), /Admin tools are on page 99/);
    const t2 = await eng.start('helpdesk', {});
    const t3 = await eng.input(t2.sessionId, { value: 'admin' });
    assert.strictEqual(t3.messages[0].type, 'error');                       // hidden options can't be picked
  });
  console.log(passed + ' passed');
})();
