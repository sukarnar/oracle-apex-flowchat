// Run: node tests/note.test.js
// Information notes: a question's "note" goes out with the turn while that question is open.
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}

const flow = {
  flowId: 'notes', debug: false, start: 'card',
  nodes: [
    { id: 'card', type: 'ask', slot: 'card', redact: 'last4', prompt: 'Card?', input: { kind: 'text' },
      note: 'Use the corporate card.', next: 'name' },
    { id: 'name', type: 'ask', slot: 'name', prompt: 'Name on the passport?', input: { kind: 'text' },
      note: 'Exactly as printed. The card ending in {{card}} is charged.', noteStyle: 'warning', next: 'city' },
    { id: 'city', type: 'ask', slot: 'city', prompt: 'City?', input: { kind: 'text' },
      note: '{{nothing_yet}}', next: 'pick' },
    { id: 'pick', type: 'menu', slot: 'what', prompt: 'Next?', note: 'You can come back to this later, {{name}}.', noteStyle: 'tip',
      options: [{ value: 'A', label: 'Add stops', next: 'stops' }, { value: 'B', label: 'Finish', next: 'end' }] },
    { id: 'stops', type: 'repeat', slot: 'stops', min: 1, max: 3, next: 'end',
      fields: [{ field: 'place', label: 'Place', input: { kind: 'text' }, note: 'A town or an airport.', noteStyle: 'bogus' },
               { field: 'nights', label: 'Nights', input: { kind: 'number' } }] },
    { id: 'end', type: 'end', text: 'ok' }
  ]
};

(async () => {
  console.log('information notes');
  const eng = FC.createEngine({ flows: [flow] });
  let t;

  await test('an Ask note goes out with its question, as an information note by default', async () => {
    t = await eng.start('notes', {});
    assert.deepStrictEqual(t.await.note, { text: 'Use the corporate card.', style: 'info' });
  });

  await test('placeholders are filled, and a hidden answer stays masked in the note', async () => {
    t = await eng.input(t.sessionId, { value: '4111111111111111' });
    assert.strictEqual(t.await.slot, 'name');
    assert.strictEqual(t.await.note.style, 'warning');
    assert.strictEqual(t.await.note.text, 'Exactly as printed. The card ending in •••• 1111 is charged.');
  });

  await test('a note that comes out empty is not sent', async () => {
    t = await eng.input(t.sessionId, { value: 'Ada Lovelace' });
    assert.strictEqual(t.await.slot, 'city');
    assert.strictEqual(t.await.note, undefined);
  });

  await test('a menu shows its note too', async () => {
    t = await eng.input(t.sessionId, { value: 'Paris' });
    assert.ok(t.await.menu);
    assert.deepStrictEqual(t.await.note, { text: 'You can come back to this later, Ada Lovelace.', style: 'tip' });
  });

  await test('a list field shows its own note; an unknown style falls back to info; a field without one shows none', async () => {
    t = await eng.input(t.sessionId, { value: 'A' });
    if (t.await.type === 'listMenu') t = await eng.input(t.sessionId, { command: 'add' });
    assert.strictEqual(t.await.slot, 'stops.place');
    assert.deepStrictEqual(t.await.note, { text: 'A town or an airport.', style: 'info' });
    assert.ok(!t.messages.some((m) => /airport/.test(m.text || '')), 'the note is not a chat message');
    t = await eng.input(t.sessionId, { value: 'Lyon' });
    assert.strictEqual(t.await.slot, 'stops.nights');
    assert.strictEqual(t.await.note, undefined);
  });

  await test('the note comes back when the user goes back to the question', async () => {
    const e2 = FC.createEngine({ flows: [flow] });
    let u = await e2.start('notes', {});
    u = await e2.input(u.sessionId, { value: '4111111111111111' });
    u = await e2.input(u.sessionId, { command: 'back' });
    assert.strictEqual(u.await.slot, 'card');
    assert.strictEqual(u.await.note.text, 'Use the corporate card.');
  });

  console.log('\n' + passed + ' passed');
})();
