// Run: node tests/redact.test.js
// Hidden answers ("redact"): the turn says how to hide the input, the chat shows masks, logs mask too.
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}
const DOT8 = '•'.repeat(8);

const flow = {
  flowId: 'kyc', debug: true, start: 'ssn',
  nodes: [
    { id: 'ssn', type: 'ask', slot: 'ssn', redact: true, prompt: 'SSN?', input: { kind: 'text' }, next: 'card' },
    { id: 'card', type: 'ask', slot: 'card', redact: 'last4', allowReveal: false, prompt: 'Card?', input: { kind: 'text' }, next: 'name' },
    { id: 'name', type: 'ask', slot: 'name', prompt: 'Name?', input: { kind: 'text' }, next: 'look' },
    { id: 'look', type: 'lookup', connector: 'check', next: 'echo' },
    { id: 'echo', type: 'message', text: 'Thanks {{name}}, SSN {{ssn}}, card {{card}}.', next: 'review' },
    { id: 'review', type: 'summary', next: 'end' },
    { id: 'end', type: 'end', text: 'ok' }
  ]
};

(async () => {
  console.log('redact');
  const quiet = Object.assign({}, flow, { debug: false });
  await test('the turn asks the widget to hide the input, with reveal on by default', async () => {
    const eng = FC.createEngine({ flows: [quiet] });
    const t = await eng.start('kyc', {});
    assert.strictEqual(t.await.redact, 'full');
    assert.strictEqual(t.await.allowReveal, true);
    const t2 = await eng.input(t.sessionId, { value: '123-45-6789' });
    assert.strictEqual(t2.await.redact, 'last4');
    assert.strictEqual(t2.await.allowReveal, false);
    const t3 = await eng.input(t2.sessionId, { value: '4111111111111111' });
    assert.strictEqual(t3.await.redact, undefined, 'plain Ask is not hidden');
  });

  await test('later messages and the summary show masks; connectors still get the real value', async () => {
    let seen = null;
    const events = [];
    const eng = FC.createEngine({ flows: [flow], onDebug: (e) => events.push(e),
      connectors: { check: (p) => { seen = p.slots; return { found: true }; } } });
    let t = await eng.start('kyc', {});
    t = await eng.input(t.sessionId, { value: '123-45-6789' });
    t = await eng.input(t.sessionId, { value: '4111111111111111' });
    t = await eng.input(t.sessionId, { value: 'Ada' });
    const out = JSON.stringify(t.messages);
    assert.ok(!out.includes('123-45-6789'), 'SSN not in chat');
    assert.ok(!out.includes('4111111111111111'), 'card not in chat');
    assert.ok(out.includes('SSN ' + DOT8));
    assert.ok(out.includes('card •••• 1111'));
    assert.ok(out.includes('Thanks Ada'));
    const sum = t.messages.find((m) => m.type === 'summary');
    assert.ok(sum && !JSON.stringify(sum).includes('6789'), 'summary masked');
    assert.strictEqual(seen.ssn, '123-45-6789', 'connector gets the real SSN');
    assert.strictEqual(seen.card, '4111111111111111');
    const log = JSON.stringify(events);
    assert.ok(!log.includes('123-45-6789') && !log.includes('4111111111111111'), 'redact implies pii in logs');
  });

  await test('going back to a hidden Ask does not send the old value to prefill', async () => {
    const eng = FC.createEngine({ flows: [quiet] });
    let t = await eng.start('kyc', {});
    t = await eng.input(t.sessionId, { value: '123-45-6789' });
    t = await eng.input(t.sessionId, { command: 'back' });
    assert.strictEqual(t.await.slot, 'ssn');
    assert.strictEqual(t.await.value, null);
    assert.ok(!JSON.stringify(t).includes('123-45-6789'));
  });

  await test('hidden Change fields field: masked in the card and field menu, hidden when edited', async () => {
    const f = JSON.parse(JSON.stringify(require('../flows/update_application.json')));
    f.nodes.forEach((n) => (n.fields || []).forEach((fd) => { if (fd.field === 'phone') fd.redact = 'last4'; }));
    const src = require('../demo/demo-data-sources.js').create(FC);
    const eng = FC.createEngine({ flows: [f], dataSources: { loan_apps: src } });
    let t = await eng.start('update_application');
    t = await eng.input(t.sessionId, { value: 'jane.doe@example.com' });
    t = await eng.input(t.sessionId, { value: '' });
    t = await eng.input(t.sessionId, { pick: t.await.items[0].token });
    assert.strictEqual(t.await.type, 'fieldMenu');
    const shown = JSON.stringify([t.messages, t.await]);
    assert.ok(!shown.includes('+1 555 123 4567'), 'phone masked in the card and menu');
    assert.ok(shown.includes('•••• 4567'));
    t = await eng.input(t.sessionId, { field: 'phone' });
    assert.strictEqual(t.await.redact, 'last4');
    assert.strictEqual(t.await.value, null);
    assert.ok(!JSON.stringify(t.messages).includes('+1 555 123 4567'), '"currently ..." prompt masked');
    t = await eng.input(t.sessionId, { value: '+1 555 999 0000' });
    assert.strictEqual(t.await.type, 'fieldMenu');
    assert.ok(!JSON.stringify([t.messages, t.await]).includes('+1 555 999 0000'));
  });

  console.log('\n' + passed + ' passed');
})();
