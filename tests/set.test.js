// Run: node tests/set.test.js
// The Set node (initialise / copy values) and context variables ({{context.x}}, declared "context" list).
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}
const texts = (t) => t.messages.map((m) => m.text || '').join(' | ');

const flow = {
  flowId: 'req', start: 'init', context: ['dept', { name: 'emp_id', label: 'Employee id' }],
  bindings: { status: { dom: '#status' } },
  nodes: [
    { id: 'init', type: 'set', assign: [
      { slot: 'status', value: 'NEW' },
      { slot: 'priority', value: 'LOW', onlyIfEmpty: true },
      { slot: 'region', from: 'context.region' },
      { slot: 'title', template: 'Request from {{app_user}} ({{dept}})' },
      { slot: 'app_user', value: 'HACKER' }
    ], next: 'hello' },
    { id: 'hello', type: 'message', text: '{{title}}; employee {{emp_id}}; page {{context.page}}; region {{region}}.', next: 'route' },
    { id: 'route', type: 'condition', branches: [{ when: { slot: 'context.page', op: '=', value: 'P20' }, next: 'ask' }], else: 'bye' },
    { id: 'ask', type: 'ask', slot: 'note', prompt: 'Any note?', input: { kind: 'text' }, next: 'again' },
    { id: 'again', type: 'set', assign: [{ slot: 'status', value: 'SUBMITTED' }, { slot: 'region', clear: true },
                                         { slot: 'summary', template: '{{note}} [{{status}}]' }], next: 'bye' },
    { id: 'bye', type: 'end', text: '{{summary}} {{status}} region={{region}}' }
  ]
};

(async () => {
  console.log('set node and context variables');
  await test('initialises values, copies from context, builds templates; app_user stays protected', async () => {
    const eng = FC.createEngine({ flows: [flow], appUser: 'JSMITH' });
    const t = await eng.start('req', { dept: 'HR', emp_id: 42, page: 'P20', region: 'EU', priority: 'HIGH' });
    assert.match(texts(t), /Request from JSMITH \(HR\); employee 42; page P20; region EU\./);
    const st = eng.getState(t.sessionId);
    assert.strictEqual(st.slots.status, 'NEW');
    assert.strictEqual(st.slots.priority, 'LOW');            // "priority" isn't declared, so context doesn't seed it
    assert.ok(!('app_user' in st.slots));
    assert.ok(t.fieldUpdates.some((u) => u.slot === 'status' && u.value === 'NEW' && u.binding));
  });
  await test('onlyIfEmpty keeps a value that is already there', async () => {
    const f = JSON.parse(JSON.stringify(flow));
    f.flowId = 'req2'; f.context.push('priority');
    const eng = FC.createEngine({ flows: [f] });
    const t = await eng.start('req2', { priority: 'HIGH' });
    assert.strictEqual(eng.getState(t.sessionId).slots.priority, 'HIGH');
  });
  await test('a later Set overwrites and clears; conditions read context values', async () => {
    const eng = FC.createEngine({ flows: [flow], appUser: 'JSMITH' });
    let t = await eng.start('req', { page: 'P20', region: 'EU' });
    assert.strictEqual(t.await.slot, 'note');
    t = await eng.input(t.sessionId, { value: 'Urgent' });
    assert.match(texts(t), /Urgent \[SUBMITTED\] SUBMITTED region=$/);
    const t2 = await eng.start('req', { page: 'P99' });
    assert.strictEqual(t2.status, 'completed');              // the condition took the else path
  });
  await test('connectors receive Set values in slots', async () => {
    let got = null;
    const f = { flowId: 'c', start: 's', nodes: [
      { id: 's', type: 'set', assign: [{ slot: 'channel', value: 'chat' }, { slot: 'source_page', from: 'context.page' }], next: 'look' },
      { id: 'look', type: 'lookup', connector: 'x', next: 'e' },
      { id: 'e', type: 'end', text: 'ok' }] };
    const eng = FC.createEngine({ flows: [f], connectors: { x: (p) => { got = p; return { found: true }; } } });
    await eng.start('c', { page: 'P5' });
    assert.deepStrictEqual(got.slots, { channel: 'chat', source_page: 'P5' });
    assert.strictEqual(got.context.page, 'P5');
  });
  await test('search criteria can use context values, Set values and app_user', async () => {
    let crit = null;
    const src = { search: (q) => { crit = q.criteria; return []; }, get: () => null };
    const f = { flowId: 'fc', start: 's', nodes: [
      { id: 's', type: 'set', assign: [{ slot: 'status', value: 'OPEN' }], next: 'find' },
      { id: 'find', type: 'findRecord', source: 'emps', as: 'emp', criteria: [
          { field: 'emp_id', op: 'eq', slot: 'context.emp_id' },
          { field: 'status', op: 'eq', slot: 'status' },
          { field: 'owner', op: 'eq', slot: 'app_user' }],
        next: 'e', notFound: 'e' },
      { id: 'e', type: 'end', text: 'ok' }] };
    const eng = FC.createEngine({ flows: [f], appUser: 'JSMITH', dataSources: { emps: src } });
    await eng.start('fc', { emp_id: 'E-42' });
    assert.deepStrictEqual(crit, [
      { field: 'emp_id', op: 'eq', value: 'E-42' },
      { field: 'status', op: 'eq', value: 'OPEN' },
      { field: 'owner', op: 'eq', value: 'JSMITH' }]);
  });
  console.log(passed + ' passed');
})();
