// Run: node flowchat/tests/lov.test.js   (lookup lists: choice options loaded from the server)
const assert = require('assert');
const { createEngine, createMemorySource } = require('../widget/flowchat-engine.js');
const loanFlow = require('../flows/loan_application.json');
const demoLovs = require('../demo/demo-lovs.js');

global.window = global;
require('../demo/demo-connectors.js');
const connectors = global.FlowChatDemoConnectors;

const last = (t) => t.messages[t.messages.length - 1];
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}

// Small flow: country -> branch (depends on country) -> summary -> end.
const mini = {
  flowId: 'mini', start: 'ask_country',
  nodes: [
    { id: 'ask_country', type: 'ask', slot: 'country', label: 'Country', prompt: 'Country?',
      input: { kind: 'choice', optionsFrom: 'countries', display: 'list' }, next: 'ask_branch' },
    { id: 'ask_branch', type: 'ask', slot: 'branch', label: 'Branch', prompt: 'Branch?',
      input: { kind: 'choice', optionsFrom: 'branches', optionsParams: { country: 'country' },
               staleMessage: 'Pick a branch again.', emptyMessage: 'No branches there.' }, next: 'review' },
    { id: 'review', type: 'summary', next: 'submit' },
    { id: 'submit', type: 'submit', connector: 'ok', onSuccess: 'done' },
    { id: 'done', type: 'end', text: 'Done.' }
  ]
};

(async () => {
  const calls = [];
  const lovs = {
    countries: (req) => { calls.push(req); return demoLovs.countries(req).concat([{ value: 'XX', label: 'Nowhere' }]); },
    branches: (req) => { calls.push(req); return demoLovs.branches(req); }
  };
  const eng = createEngine({ flows: [mini], lovs, connectors: { ok: () => ({ ok: true }) } });

  await test('options are resolved on the server and sent with the question', async () => {
    const t = await eng.start('mini', { tenant: 'acme' });
    assert.strictEqual(t.await.slot, 'country');
    assert.strictEqual(t.await.input.options.length, 14);   // 13 demo countries + Nowhere
    assert.deepStrictEqual(t.await.input.options[0], { value: 'AU', label: 'Australia' });
    assert.strictEqual(t.await.input.display, 'list');
    assert.strictEqual(t.await.input.optionsFrom, undefined, 'list id is not sent to the browser');
    const req = calls.find((c) => c.lov === 'countries');
    assert.strictEqual(req.context.tenant, 'acme');
    assert.ok('verified' in req && 'sessionId' in req);
  });

  await test('a dependent list is only fetched once its parameter is answered', async () => {
    calls.length = 0;
    let t = await eng.start('mini');
    assert.ok(!calls.some((c) => c.lov === 'branches'), 'branches not fetched before a country is chosen');
    t = await eng.input(t.sessionId, { value: 'germany' });
    assert.strictEqual(t.await.slot, 'branch');
    assert.deepStrictEqual(t.await.input.options.map((o) => o.label), ['Berlin Mitte', 'Frankfurt Zeil']);
    assert.deepStrictEqual(calls.find((c) => c.lov === 'branches').params, { country: 'DE' });
  });

  await test('answers outside the list are refused; label, value or number accepted', async () => {
    let t = await eng.start('mini');
    t = await eng.input(t.sessionId, { value: 'Atlantis' });
    assert.strictEqual(last(t).type, 'error');
    assert.strictEqual(t.await.slot, 'country');
    t = await eng.input(t.sessionId, { value: 'IN' });
    t = await eng.input(t.sessionId, { value: '999' });
    assert.strictEqual(last(t).type, 'error');
    t = await eng.input(t.sessionId, { value: '151' });                 // value
    assert.strictEqual(t.await.type, 'summary');
    const card = last(t);
    assert.strictEqual(card.items.find((i) => i.slot === 'country').display, 'India');
    assert.strictEqual(card.items.find((i) => i.slot === 'branch').display, 'Mumbai Fort');
    assert.strictEqual(eng.getState(t.sessionId).slots.branch, '151');
  });

  await test('changing the country asks for the branch again', async () => {
    let t = await eng.start('mini');
    const sid = t.sessionId;
    t = await eng.input(sid, { value: 'canada' });
    t = await eng.input(sid, { value: 'Toronto Bay St' });
    assert.strictEqual(t.await.type, 'summary');
    t = await eng.input(sid, { command: 'edit', slot: 'country' });
    t = await eng.input(sid, { value: 'france' });
    assert.strictEqual(t.await.slot, 'branch', 'replay stops at the branch, which France does not offer');
    assert.strictEqual(last(t).text, 'Pick a branch again.');
    assert.deepStrictEqual(t.await.input.options.map((o) => o.label), ['Paris Opéra']);
    t = await eng.input(sid, { value: '1' });
    assert.strictEqual(t.await.type, 'summary');
  });

  await test('an unchanged dependent answer is kept on replay', async () => {
    let t = await eng.start('mini');
    const sid = t.sessionId;
    t = await eng.input(sid, { value: 'US' });
    t = await eng.input(sid, { value: 'Chicago Loop' });
    t = await eng.input(sid, { command: 'edit', slot: 'country' });
    t = await eng.input(sid, { value: 'US' });
    assert.strictEqual(t.await.type, 'summary');
  });

  await test('an empty list says so (emptyMessage)', async () => {
    let t = await eng.start('mini');
    t = await eng.input(t.sessionId, { value: 'Nowhere' });
    assert.strictEqual(t.await.slot, 'branch');
    assert.strictEqual(t.await.input.options.length, 0);
    assert.strictEqual(last(t).text, 'No branches there.');
    assert.strictEqual(last(t).type, 'error');
  });

  await test('submit re-checks lookup answers (defence in depth)', async () => {
    let flip = false;
    const e2 = createEngine({ flows: [mini], connectors: { ok: () => ({ ok: true }) },
      lovs: { countries: demoLovs.countries,
              branches: (req) => demoLovs.branches(req).filter((o) => !(flip && o.value === '221')) } });
    let t = await e2.start('mini');
    t = await e2.input(t.sessionId, { value: 'US' });
    t = await e2.input(t.sessionId, { value: 'New York Midtown' });
    flip = true;                                       // the branch closes before the user confirms
    t = await e2.input(t.sessionId, { value: 'confirm' });
    assert.notStrictEqual(t.status, 'completed');
    assert.strictEqual(t.await.slot, 'branch');
    assert.ok(t.messages.some((m) => m.type === 'error' && m.text === 'Pick a branch again.'));
  });

  await test('unknown list id fails clearly', async () => {
    const e3 = createEngine({ flows: [mini], lovs: {} });
    await assert.rejects(() => e3.start('mini'), /Unknown lookup list "countries"/);
  });

  await test('lookup list on a Change fields field (record editing)', async () => {
    const rows = [{ id: 7, email: 'a@b.co', branch: '212', country: 'GB', version: 1 }];
    const src = createMemorySource({ rows, key: 'id', versionField: 'version',
      fields: { email: { searchable: true }, branch: { updatable: true }, country: { updatable: false } } });
    const flow = {
      flowId: 'upd', start: 'ask_email',
      nodes: [
        { id: 'ask_email', type: 'ask', slot: 'email', prompt: 'Email?', input: { kind: 'email' }, next: 'find' },
        { id: 'find', type: 'findRecord', source: 'apps', as: 'app', criteria: [{ field: 'email', slot: 'email' }],
          title: '{{app.email}}', found: 'change', notFound: 'done' },
        { id: 'change', type: 'changeFields', record: 'app', done: 'save',
          fields: [{ field: 'branch', label: 'Branch',
                     input: { kind: 'choice', optionsFrom: 'branches', optionsParams: { country: 'app.country' } } }] },
        { id: 'save', type: 'saveChanges', record: 'app', saved: 'done' },
        { id: 'done', type: 'end', text: 'Saved.' }
      ]
    };
    const e4 = createEngine({ flows: [flow], dataSources: { apps: src }, lovs: demoLovs });
    let t = await e4.start('upd');
    t = await e4.input(t.sessionId, { value: 'a@b.co' });
    if (t.await.type === 'pick') t = await e4.input(t.sessionId, { pick: t.await.items[0].token });
    assert.strictEqual(t.await.type, 'fieldMenu');
    assert.strictEqual(t.await.fields[0].display, 'Manchester Spinningfields');
    assert.ok(t.messages.some((m) => m.type === 'record' && m.items[0].display === 'Manchester Spinningfields'));
    t = await e4.input(t.sessionId, { field: 'branch' });
    assert.match(t.messages.map((m) => m.text).join(' '), /currently Manchester Spinningfields/);
    assert.deepStrictEqual(t.await.input.options.map((o) => o.value), ['211', '212']);
    t = await e4.input(t.sessionId, { value: 'New York Midtown' });
    assert.strictEqual(last(t).type, 'error', 'a US branch is not offered for a GB record');
    t = await e4.input(t.sessionId, { value: 'London City' });
    t = await e4.input(t.sessionId, { command: 'done' });
    assert.strictEqual(t.status, 'completed');
    assert.strictEqual(rows[0].branch, '211');
  });

  console.log(`\n${passed} passed`);
})();
