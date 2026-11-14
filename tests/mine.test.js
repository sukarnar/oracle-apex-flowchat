// Run: node tests/mine.test.js
// Find record with byRowFilter: no criteria; the data source's row filter (owner = :APP_USER) picks the rows.
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');
const base = require('../flows/update_application.json');
const demoData = require('../demo/demo-data-sources.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}
function mineFlow() {
  const f = JSON.parse(JSON.stringify(base));
  f.flowId = 'my_application';
  const find = f.nodes.find((n) => n.id === 'find_app');
  find.byRowFilter = true;
  delete find.criteria; delete find.minCriteria;
  find.prompts.many = 'You have {{count}} applications. Which one?';
  find.prompts.none = "You don't have an application yet.";
  f.start = 'find_app';
  return f;
}
// Like FC_DATA_SOURCES.ROW_FILTER = 'upper(t.email) = upper(:APP_USER)'
function setup(withFilter) {
  const demo = demoData.create(FC);
  const src = FC.createMemorySource({
    rows: demo.rows, key: 'app_id', versionField: 'version', fields: demo.fields,
    rowFilter: withFilter === false ? null : (row, ctx) => String(row.email).toLowerCase() === String(ctx.appUser || '').toLowerCase()
  });
  return FC.createEngine({ flows: [mineFlow()], dataSources: { loan_apps: src } });
}

(async () => {
  console.log('find by row filter');
  await test('one row for the user: loaded straight away, no questions', async () => {
    const eng = setup();
    const t = await eng.start('my_application', { appUser: 'raj.kumar@example.com' });
    assert.strictEqual(t.await.type, 'fieldMenu');
    assert.ok(t.messages.some((m) => m.type === 'record'));
  });
  await test('several rows for the user: pick one of them only', async () => {
    const eng = setup();
    const t = await eng.start('my_application', { appUser: 'JANE.DOE@example.com' });
    assert.strictEqual(t.await.type, 'pick');
    assert.strictEqual(t.await.items.length, 2);
    assert.ok(t.messages.some((m) => /You have 2 applications/.test(m.text || '')));
  });
  await test('no rows for the user: notFound path', async () => {
    const eng = setup();
    const t = await eng.start('my_application', { appUser: 'nobody@example.com' });
    assert.ok(t.messages.some((m) => /don't have an application/.test(m.text || '')));
  });
  await test('criteria in the flow are ignored', async () => {
    const f = mineFlow();
    f.nodes.find((n) => n.id === 'find_app').criteria = [{ field: 'email', op: 'eq', slot: 'email' }];
    const demo = demoData.create(FC);
    const src = FC.createMemorySource({ rows: demo.rows, key: 'app_id', versionField: 'version', fields: demo.fields,
      rowFilter: (row, ctx) => row.email === ctx.appUser });
    const eng = FC.createEngine({ flows: [f], dataSources: { loan_apps: src } });
    const t = await eng.start('my_application', { appUser: 'raj.kumar@example.com', email: 'jane.doe@example.com' });
    assert.strictEqual(t.await.type, 'fieldMenu');
  });
  await test('a source without a row filter refuses a search with no criteria', async () => {
    const eng = setup(false);
    await assert.rejects(eng.start('my_application', { appUser: 'raj.kumar@example.com' }), /needs a row filter/);
  });

  console.log('\n' + passed + ' passed');
})();
