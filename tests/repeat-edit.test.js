// Run: node tests/repeat-edit.test.js
// Repeat: changing an item already in the list (Edit), e.g. rows loaded from the database.
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}
const texts = (t) => t.messages.map((m) => m.text || '').join(' | ');

function flow(extra) {
  return {
    flowId: 'stops', debug: false, start: 'load',
    nodes: [
      { id: 'load', type: 'lookup', connector: 'load_stops', next: 'stops' },
      Object.assign({ id: 'stops', type: 'repeat', slot: 'stops', label: 'Stops', itemLabel: 'stop', min: 1, max: 5,
        itemTitle: '{{city}} ({{nights}} nights)',
        fields: [
          { field: 'city', label: 'City', input: { kind: 'text' } },
          { field: 'nights', label: 'Nights', input: { kind: 'number', min: 1, max: 30 } },
          { field: 'note', label: 'Note', input: { kind: 'text', required: false } } ],
        next: 'save' }, extra || {}),
      { id: 'save', type: 'submit', connector: 'save_stops', next: 'end' },
      { id: 'end', type: 'end', text: 'Saved.' } ]
  };
}

function setup(extra) {
  const saved = [];
  const eng = FC.createEngine({
    flows: [flow(extra)],
    connectors: {
      load_stops: () => ({ found: true, slots: { stops: [
        { stop_id: 11, city: 'Berlin', nights: 2, note: 'Hotel booked' },
        { stop_id: 12, city: 'Paris', nights: 3 } ] } }),
      save_stops: (p) => { saved.push(JSON.parse(JSON.stringify(p.slots.stops))); return { ok: true }; }
    }
  });
  return { eng, saved };
}

(async () => {
  console.log('repeat: edit an item');

  await test('loaded rows are listed with Edit offered', async () => {
    const { eng } = setup();
    const t = await eng.start('stops', {});
    assert.strictEqual(t.await.type, 'listMenu');
    assert.strictEqual(t.await.items.length, 2);
    assert.strictEqual(t.await.canEdit, true);
    assert.strictEqual(t.await.editLabel, 'Edit');
  });

  await test('Edit shows the item\'s fields; a changed field is marked; Save updates that row and keeps its id', async () => {
    const { eng, saved } = setup();
    let t = await eng.start('stops', {});
    t = await eng.input(t.sessionId, { command: 'editItem', index: 1 });
    assert.match(texts(t), /Changing Paris \(3 nights\)/);
    assert.strictEqual(t.await.type, 'fieldMenu');
    assert.strictEqual(t.await.doneLabel, 'Save');
    assert.deepStrictEqual(t.await.fields.map((f) => f.display), ['Paris', '3', '']);
    t = await eng.input(t.sessionId, { field: 'nights' });
    assert.match(texts(t), /Nights is currently 3\. What should it be\?/);
    assert.strictEqual(t.await.type, 'ask');
    assert.strictEqual(t.await.value, 3, 'the current value is pre-filled');
    assert.strictEqual(t.await.sub, true, 'Keep current is offered');
    t = await eng.input(t.sessionId, { value: '5' });
    assert.strictEqual(t.await.type, 'fieldMenu');
    assert.strictEqual(t.await.fields.find((f) => f.field === 'nights').changed, true);
    assert.strictEqual(t.await.fields.find((f) => f.field === 'city').changed, false);
    t = await eng.input(t.sessionId, { command: 'done' });
    assert.match(texts(t), /Updated Paris \(5 nights\)/);
    assert.strictEqual(t.await.type, 'listMenu');
    t = await eng.input(t.sessionId, { command: 'done' });
    assert.strictEqual(t.status, 'completed');
    assert.deepStrictEqual(saved[0], [
      { stop_id: 11, city: 'Berlin', nights: 2, note: 'Hotel booked' },
      { stop_id: 12, city: 'Paris', nights: 5 } ]);
  });

  await test('an edited answer is validated like a new one', async () => {
    const { eng } = setup();
    let t = await eng.start('stops', {});
    t = await eng.input(t.sessionId, { command: 'editItem', index: 0 });
    t = await eng.input(t.sessionId, { field: 'nights' });
    t = await eng.input(t.sessionId, { value: '99' });
    assert.ok(t.messages.some((m) => m.type === 'error'), 'too large is refused');
    assert.strictEqual(t.await.type, 'ask', 'still asking');
  });

  await test('clearing an optional field removes it from the row', async () => {
    const { eng, saved } = setup();
    let t = await eng.start('stops', {});
    t = await eng.input(t.sessionId, { command: 'editItem', index: 0 });
    t = await eng.input(t.sessionId, { field: 'note' });
    t = await eng.input(t.sessionId, { value: '' });
    t = await eng.input(t.sessionId, { command: 'done' });
    t = await eng.input(t.sessionId, { command: 'done' });
    assert.deepStrictEqual(saved[0][0], { stop_id: 11, city: 'Berlin', nights: 2 });
  });

  await test('Keep current (back) leaves the field as it was; back from the field list drops all changes', async () => {
    const { eng, saved } = setup();
    let t = await eng.start('stops', {});
    t = await eng.input(t.sessionId, { command: 'editItem', index: 0 });
    t = await eng.input(t.sessionId, { field: 'city' });
    t = await eng.input(t.sessionId, { command: 'back' });
    assert.match(texts(t), /kept it as it was/);
    assert.strictEqual(t.await.type, 'fieldMenu');
    t = await eng.input(t.sessionId, { field: 'city' });
    t = await eng.input(t.sessionId, { value: 'Munich' });
    t = await eng.input(t.sessionId, { command: 'back' });
    assert.match(texts(t), /left Berlin \(2 nights\) as it was/);
    assert.strictEqual(t.await.type, 'listMenu');
    t = await eng.input(t.sessionId, { command: 'done' });
    assert.strictEqual(saved[0][0].city, 'Berlin');
  });

  await test('Save with nothing changed says so and changes nothing', async () => {
    const { eng } = setup();
    let t = await eng.start('stops', {});
    t = await eng.input(t.sessionId, { command: 'editItem', index: 0 });
    t = await eng.input(t.sessionId, { command: 'done' });
    assert.match(texts(t), /No changes to Berlin/);
    assert.strictEqual(t.await.type, 'listMenu');
  });

  await test('"allowEdit": false hides Edit and refuses it', async () => {
    const { eng } = setup({ allowEdit: false });
    let t = await eng.start('stops', {});
    assert.strictEqual(t.await.canEdit, false);
    t = await eng.input(t.sessionId, { command: 'editItem', index: 0 });
    assert.ok(t.messages.some((m) => m.type === 'error'));
    assert.strictEqual(t.await.type, 'listMenu');
  });

  await test('an unknown row index is refused', async () => {
    const { eng } = setup();
    let t = await eng.start('stops', {});
    t = await eng.input(t.sessionId, { command: 'editItem', index: 7 });
    assert.match(texts(t), /no such item/);
  });

  console.log('\n' + passed + ' passed');
})();
