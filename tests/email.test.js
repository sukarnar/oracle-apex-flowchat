// Run: node tests/email.test.js
// The Email node: builds a message from templates over the answers and sends it through a
// connector, or through options.sendEmail when the node names no connector.
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}
const texts = (t) => t.messages.map((m) => m.text || '').join(' | ');

const flow = (email) => ({
  flowId: 'notify', start: 'ask_name',
  nodes: [
    { id: 'ask_name', type: 'ask', slot: 'name', label: 'Name', prompt: 'Your name?', next: 'ask_email' },
    { id: 'ask_email', type: 'ask', slot: 'email', label: 'Email', prompt: 'Your email?', input: { kind: 'email' }, next: 'review' },
    { id: 'review', type: 'summary', text: 'Check:', next: 'mail' },
    Object.assign({ id: 'mail', type: 'email', to: '{{email}}', bcc: 'audit@example.com',
                    subject: 'Thanks {{name}}\r\nBcc: evil@example.com', body: 'Hi {{name}},\nwe got your request.\n-- {{app_user}}',
                    message: 'I emailed {{email}}.', next: 'done' }, email || {}),
    { id: 'oops', type: 'end', text: 'Ended on the error path.' },
    { id: 'done', type: 'end', text: 'All done.' }
  ]
});

async function runTo(eng, name, email) {
  let t = await eng.start('notify', {});
  t = await eng.input(t.sessionId, { value: name });
  t = await eng.input(t.sessionId, { value: email });
  return eng.input(t.sessionId, { value: 'confirm' });
}

(async () => {
  console.log('email node');
  await test('sends through options.sendEmail with templates filled in and newlines stripped from the subject', async () => {
    const sent = [];
    const eng = FC.createEngine({ flows: [flow()], appUser: 'JSMITH', sendEmail: (m) => { sent.push(m); return { ok: true }; } });
    const t = await runTo(eng, 'Ann', 'ann@example.com');
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(sent[0].to, ['ann@example.com']);
    assert.deepStrictEqual(sent[0].bcc, ['audit@example.com']);
    assert.strictEqual(sent[0].subject, 'Thanks Ann Bcc: evil@example.com');   // one line: no header injection
    assert.strictEqual(sent[0].body, 'Hi Ann,\nwe got your request.\n-- JSMITH');
    assert.strictEqual(sent[0].appUser, 'JSMITH');
    assert.match(texts(t), /I emailed ann@example\.com\. \| All done\./);
    assert.strictEqual(t.status, 'completed');
  });
  await test('a connector receives the message in its payload, with file answers as attachments', async () => {
    const calls = [];
    const f = flow({ connector: 'mailer', attachments: ['receipt'] });
    f.nodes.splice(1, 0, { id: 'ask_file', type: 'ask', slot: 'receipt', label: 'Receipt', prompt: 'Receipt?', input: { kind: 'file' }, next: 'ask_email' });
    f.nodes[0].next = 'ask_file';
    const eng = FC.createEngine({ flows: [f], connectors: { mailer: (p) => { calls.push(p); return { ok: true }; } } });
    let t = await eng.start('notify', {});
    t = await eng.input(t.sessionId, { value: 'Bo' });
    t = await eng.input(t.sessionId, { file: { name: 'r.pdf', mimeType: 'application/pdf', size: 3, data: 'AAAA' } });
    t = await eng.input(t.sessionId, { value: 'bo@example.com' });
    t = await eng.input(t.sessionId, { value: 'confirm' });
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].to, ['bo@example.com']);
    assert.strictEqual(calls[0].nodeId, 'mail');
    assert.strictEqual(calls[0].slots.name, 'Bo');
    assert.strictEqual(calls[0].attachments.length, 1);
    assert.strictEqual(calls[0].attachments[0].name, 'r.pdf');
    assert.ok(eng.getFile(t.sessionId, calls[0].attachments[0].id));
  });
  await test('a failure shows the error and goes to onError (or carries on to next without one)', async () => {
    const eng = FC.createEngine({ flows: [flow({ onError: 'oops', errorMessage: 'Mail is down, {{name}}.' })],
                                  sendEmail: () => ({ ok: false, message: 'SMTP refused' }) });
    const t = await runTo(eng, 'Cy', 'cy@example.com');
    assert.match(texts(t), /Mail is down, Cy\. \| Ended on the error path\./);
    const eng2 = FC.createEngine({ flows: [flow()], sendEmail: () => { throw new Error('boom'); } });
    const t2 = await runTo(eng2, 'Cy', 'cy@example.com');
    assert.match(texts(t2), /Sorry, I couldn't send the email\. \| All done\./);
  });
  await test('bad or missing recipients are never sent, and no sender configured is a failure', async () => {
    const sent = [];
    const eng = FC.createEngine({ flows: [flow({ to: '{{name}}' })], sendEmail: (m) => { sent.push(m); } });
    const t = await runTo(eng, 'not an address', 'd@example.com');
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(t.messages.find((m) => m.type === 'error').text, "Sorry, I couldn't send the email.");
    const eng2 = FC.createEngine({ flows: [flow()] });
    const t2 = await runTo(eng2, 'Di', 'd@example.com');
    assert.ok(t2.messages.some((m) => m.type === 'error'));
    assert.strictEqual(t2.status, 'completed');
  });
  await test('several recipients split on commas and semicolons; replaying an edit does not send again', async () => {
    const sent = [];
    const f = flow({ to: '{{email}}; boss@example.com, hr@example.com' });
    f.nodes[3].next = 'check';
    f.nodes.push({ id: 'check', type: 'summary', text: 'Again?', next: 'done' });
    const eng = FC.createEngine({ flows: [f], sendEmail: (m) => { sent.push(m); return { ok: true }; } });
    let t = await runTo(eng, 'Ed', 'ed@example.com');
    assert.deepStrictEqual(sent[0].to, ['ed@example.com', 'boss@example.com', 'hr@example.com']);
    assert.strictEqual(t.await.nodeId, 'check');
    t = await eng.input(t.sessionId, { command: 'edit', slot: 'name' });
    t = await eng.input(t.sessionId, { value: 'Eddie' });
    assert.strictEqual(t.await.nodeId, 'review');
    assert.strictEqual(sent.length, 1);
  });
  console.log(passed + ' passed');
})();
