// Run: node tests/workflow.test.js
// Workflow node: starts an APEX workflow (options.startWorkflow in the browser engine).
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}
const texts = (t) => t.messages.map((m) => m.text || '').join(' | ');

const flow = (extra) => ({
  flowId: 'leave', start: 'days',
  nodes: [
    { id: 'days', type: 'ask', slot: 'days', prompt: 'How many days?', input: { kind: 'number' }, next: 'start' },
    { id: 'start', type: 'ask', slot: 'start_date', prompt: 'First day?', input: { kind: 'date' }, next: 'review' },
    { id: 'review', type: 'summary', next: 'wf' },
    Object.assign({ id: 'wf', type: 'workflow', workflow: 'LEAVE_APPROVAL',
      parameters: { P_DAYS: '{{days}}', P_START: '{{start_date}}', P_NOTE: '{{days}} days from {{start_date}}' },
      detailKey: '{{days}}', resultSlot: 'workflow_id',
      message: 'Sent for approval (reference {{workflow_id}}).', next: 'end' }, extra || {}),
    { id: 'end', type: 'end', text: 'Done.' },
    { id: 'oops', type: 'end', text: 'Please use the leave form instead.' }
  ]
});

async function run(eng) {
  let t = await eng.start('leave', {});
  t = await eng.input(t.sessionId, { value: '3' });
  t = await eng.input(t.sessionId, { value: '2026-12-01' });
  return eng.input(t.sessionId, { value: 'confirm' });
}

(async () => {
  console.log('workflow');
  await test('starts the workflow with templated parameters, stores its id and continues', async () => {
    const calls = [];
    const eng = FC.createEngine({ flows: [flow()], appUser: 'JDOE', startWorkflow: (r) => { calls.push(r); return { workflowId: 4711 }; } });
    const t = await run(eng);
    assert.strictEqual(calls.length, 1);
    const r = calls[0];
    assert.strictEqual(r.workflow, 'LEAVE_APPROVAL');
    assert.strictEqual(r.applicationId, null);
    assert.strictEqual(r.appUser, 'JDOE');
    assert.deepStrictEqual(r.parameters, [
      { name: 'P_DAYS', value: '3', formatMask: null },
      { name: 'P_START', value: '2026-12-01', formatMask: 'YYYY-MM-DD' },
      { name: 'P_NOTE', value: '3 days from 2026-12-01', formatMask: null }]);
    assert.strictEqual(r.detailKey, '3');
    assert.match(texts(t), /reference 4711/);
    assert.match(texts(t), /Done\./);
    assert.strictEqual(t.status, 'completed');
  });

  await test('a plain id return value works too; formatMasks override the date default', async () => {
    let req;
    const eng = FC.createEngine({ flows: [flow({ formatMasks: { P_START: 'DD-MON-YYYY' }, applicationId: 100 })],
      startWorkflow: (r) => { req = r; return 12; } });
    const t = await run(eng);
    assert.strictEqual(req.applicationId, 100);
    assert.strictEqual(req.parameters[1].formatMask, 'DD-MON-YYYY');
    assert.match(texts(t), /reference 12/);
  });

  await test('a failure goes to onError with the raised message', async () => {
    const eng = FC.createEngine({ flows: [flow({ onError: 'oops' })], startWorkflow: () => {
      throw new Error('ORA-20001: You already have a pending request.\nORA-06512: at line 4'); } });
    const t = await run(eng);
    assert.match(texts(t), /You already have a pending request\./);
    assert.ok(!/ORA-/.test(texts(t)), 'no ORA- codes in the chat');
    assert.match(texts(t), /use the leave form/);
  });

  await test('a failure without onError shows the error message and fails the conversation', async () => {
    const eng = FC.createEngine({ flows: [flow({ errorMessage: 'Approval is unavailable.' })], startWorkflow: () => { throw new Error('ORA-01403: no data found'); } });
    const t = await run(eng);
    assert.match(texts(t), /Approval is unavailable\./);
    assert.strictEqual(t.status, 'failed');
  });

  await test('no starter configured is an error, not a silent success', async () => {
    const eng = FC.createEngine({ flows: [flow({ onError: 'oops' })] });
    const t = await run(eng);
    assert.match(texts(t), /couldn't start/);
    assert.match(texts(t), /use the leave form/);
  });

  await test('editing an answer after the workflow started never starts it again', async () => {
    let n = 0;
    const f = flow();
    f.nodes[3].next = 'review2';
    f.nodes.push({ id: 'review2', type: 'summary', next: 'end' });
    const eng = FC.createEngine({ flows: [f], startWorkflow: () => ({ workflowId: ++n }) });
    let t = await run(eng);
    assert.strictEqual(n, 1);
    t = await eng.input(t.sessionId, { command: 'edit', slot: 'days' });
    t = await eng.input(t.sessionId, { value: '4' });
    assert.strictEqual(n, 1, 'not started twice');
  });

  console.log('\n' + passed + ' passed');
})();
