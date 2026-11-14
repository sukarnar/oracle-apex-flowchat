// Run: node tests/appuser.test.js
// The built-in {{app_user}} placeholder: the signed-in user, set by the server (options.appUser).
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}
const flow = {
  flowId: 'hello', start: 'greet', bindings: { app_user: { dom: '#u' } },
  nodes: [
    { id: 'greet', type: 'message', text: 'Welcome, {{app_user}}.', next: 'route' },
    { id: 'route', type: 'condition', branches: [{ when: { slot: 'app_user', op: '=', value: 'ADMIN' }, next: 'admin' }], else: 'ask_phone' },
    { id: 'admin', type: 'end', text: 'Admin route for {{app_user}}.' },
    { id: 'ask_phone', type: 'ask', slot: 'phone', prompt: 'Hi {{app_user}}, what is your phone number?', input: { kind: 'text' }, next: 'done' },
    { id: 'done', type: 'end', text: 'Thanks {{app_user}}, saved {{phone}}.' }
  ]
};
const texts = (t) => t.messages.map((m) => m.text || '').join(' | ');

(async () => {
  console.log('app_user');
  await test('shown in messages and ask prompts', async () => {
    const eng = FC.createEngine({ flows: [flow], appUser: 'JSMITH' });
    const t = await eng.start('hello', {});
    assert.match(texts(t), /Welcome, JSMITH\./);
    assert.match(texts(t), /Hi JSMITH, what is your phone number\?/);
    const t2 = await eng.input(t.sessionId, { value: '555 1234' });
    assert.match(texts(t2), /Thanks JSMITH, saved 555 1234\./);
  });
  await test('usable in conditions', async () => {
    const eng = FC.createEngine({ flows: [flow], appUser: 'ADMIN' });
    const t = await eng.start('hello', {});
    assert.match(texts(t), /Admin route for ADMIN\./);
  });
  await test('a function is called per session', async () => {
    let n = 0;
    const eng = FC.createEngine({ flows: [flow], appUser: () => 'USER' + (++n) });
    const t = await eng.start('hello', {});
    assert.match(texts(t), /Welcome, USER\d+\./);
  });
  await test('context and slots named app_user cannot override it', async () => {
    const eng = FC.createEngine({ flows: [flow], appUser: 'JSMITH' });
    const t = await eng.start('hello', { app_user: 'ADMIN' });   // bound field, so context would seed it
    assert.match(texts(t), /Welcome, JSMITH\./);
    assert.doesNotMatch(texts(t), /Admin route/);
  });
  await test('blank when no app user is configured', async () => {
    const eng = FC.createEngine({ flows: [flow] });
    const t = await eng.start('hello', {});
    assert.match(texts(t), /Welcome, \./);
  });
  console.log(passed + ' passed');
})();
