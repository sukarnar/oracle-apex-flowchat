// Run: node tests/rest.test.js
// The REST call node: calls a registered endpoint, maps the JSON response into slots and routes on
// the status (2xx -> next, 404 -> onNotFound, else onError).
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}
const texts = (t) => t.messages.map((m) => m.text || '').join(' | ');

const flow = (rest, extra) => ({
  flowId: 'rates', start: 'ask_cur', debug: !!(extra && extra.debug),
  nodes: [
    { id: 'ask_cur', type: 'ask', slot: 'currency', label: 'Currency', prompt: 'Which currency?', next: 'ask_amt' },
    { id: 'ask_amt', type: 'ask', slot: 'amount', label: 'Amount', prompt: 'Amount?', input: { kind: 'number' }, next: 'call' },
    Object.assign({ id: 'call', type: 'rest', endpoint: 'fx', method: 'GET', path: '/rates/{{currency}}',
                    query: { amount: '{{amount}}', user: '{{app_user}}' },
                    map: { rate: '$.rate', bank: '$.source.name', first_tier: '$.tiers[0].min' },
                    message: 'The rate is {{rate}} ({{bank}}).', next: 'done', onError: 'oops' }, rest || {}),
    { id: 'nf', type: 'end', text: 'No such currency.' },
    { id: 'oops', type: 'end', text: 'Ended on the error path.' },
    { id: 'done', type: 'end', text: 'All done.' }
  ]
});
async function runTo(eng, cur, amt) {
  let t = await eng.start('rates', {});
  t = await eng.input(t.sessionId, { value: cur });
  return eng.input(t.sessionId, { value: amt });
}
// a fake fetch that records requests and answers from a table
function fakeFetch(answer) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const a = typeof answer === 'function' ? answer(url, init) : answer;
    return { status: a.status, text: async () => (typeof a.body === 'string' ? a.body : JSON.stringify(a.body)) };
  };
  fn.calls = calls;
  return fn;
}
const FX = { fx: { baseUrl: 'https://api.example.com/v1/', methods: ['GET', 'POST'], headers: { Authorization: 'Bearer SECRET' } } };

(async () => {
  console.log('rest node');
  await test('GET: builds the URL from the endpoint, encodes values and maps the JSON response into slots', async () => {
    const f = fakeFetch({ status: 200, body: { rate: 1.08, source: { name: 'ECB' }, tiers: [{ min: 100 }] } });
    const eng = FC.createEngine({ flows: [flow()], restEndpoints: FX, fetch: f, appUser: 'J.SMITH' });
    const t = await runTo(eng, 'EUR/../admin', '25k');
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.calls[0].url, 'https://api.example.com/v1/rates/EUR%2F%2E%2E%2Fadmin?amount=25000&user=J%2ESMITH');
    assert.strictEqual(f.calls[0].init.method, 'GET');
    assert.strictEqual(f.calls[0].init.headers.Authorization, 'Bearer SECRET');
    assert.strictEqual(f.calls[0].init.body, undefined);
    assert.match(texts(t), /The rate is 1\.08 \(ECB\)\. \| All done\./);
    const st = eng.getState(t.sessionId);
    assert.strictEqual(st.slots.rate, 1.08);
    assert.strictEqual(st.slots.first_tier, 100);
    assert.deepStrictEqual(t.fieldUpdates.map((u) => u.slot).filter((s) => s === 'rate' || s === 'bank').sort(), ['bank', 'rate']);
  });
  await test('POST: "{{slot}}" alone keeps the value type, other strings are text; header values are one line', async () => {
    const f = fakeFetch({ status: 201, body: { id: 'Q-7' } });
    const eng = FC.createEngine({ flows: [flow({ method: 'POST', path: '/quotes', query: {}, headers: { 'X-Note': 'for {{currency}}\nX-Evil: 1' },
      body: { amount: '{{amount}}', label: 'Quote in {{currency}}', tags: ['{{currency}}', 2], missing: '{{nope}}' },
      map: { quote_id: 'id' }, message: 'Quote {{quote_id}} created.' })], restEndpoints: FX, fetch: f });
    const t = await runTo(eng, 'USD', '1200');
    const init = f.calls[0].init;
    assert.strictEqual(f.calls[0].url, 'https://api.example.com/v1/quotes');
    assert.deepStrictEqual(JSON.parse(init.body), { amount: 1200, label: 'Quote in USD', tags: ['USD', 2], missing: null });
    assert.strictEqual(init.headers['Content-Type'], 'application/json');
    assert.strictEqual(init.headers['X-Note'], 'for USD X-Evil: 1');
    assert.match(texts(t), /Quote Q-7 created\./);
  });
  await test('404 goes to onNotFound when set; other errors go to onError with the error message', async () => {
    let eng = FC.createEngine({ flows: [flow({ onNotFound: 'nf', notFoundMessage: 'Nothing for {{currency}}.' })], restEndpoints: FX,
      fetch: fakeFetch({ status: 404, body: { error: 'no' } }) });
    let t = await runTo(eng, 'XXX', '1');
    assert.match(texts(t), /Nothing for XXX\. \| No such currency\./);
    eng = FC.createEngine({ flows: [flow({ errorMessage: 'The rate service is down.' })], restEndpoints: FX,
      fetch: fakeFetch({ status: 404, body: '' }) });
    t = await runTo(eng, 'XXX', '1');
    assert.match(texts(t), /The rate service is down\. \| Ended on the error path\./);
    eng = FC.createEngine({ flows: [flow()], restEndpoints: FX, fetch: async () => { throw new Error('connection refused'); } });
    t = await runTo(eng, 'EUR', '1');
    assert.match(texts(t), /couldn't get that information/);
    assert.strictEqual(t.status, 'completed');
  });
  await test('without onError a failed call ends the conversation as failed', async () => {
    const eng = FC.createEngine({ flows: [flow({ onError: undefined })], restEndpoints: FX, fetch: fakeFetch({ status: 500, body: 'boom' }) });
    const t = await runTo(eng, 'EUR', '1');
    assert.strictEqual(t.status, 'failed');
  });
  await test('refuses: an unknown endpoint, a method the endpoint does not allow, an absolute path, an Authorization header', async () => {
    const f = fakeFetch({ status: 200, body: {} });
    const cases = [{ endpoint: 'nope' }, { method: 'DELETE' }, { path: '//evil.example.com/x' }, { path: 'https://evil.example.com' },
                   { headers: { Authorization: 'Bearer {{currency}}' } }];
    for (const c of cases) {
      const eng = FC.createEngine({ flows: [flow(c)], restEndpoints: FX, fetch: f });
      const t = await runTo(eng, 'EUR', '1');
      assert.match(texts(t), /Ended on the error path/, JSON.stringify(c));
    }
    assert.strictEqual(f.calls.length, 0);
  });
  await test('options.rest replaces the transport; statusSlot keeps the HTTP status; debug logs no response body', async () => {
    const reqs = [], events = [];
    const eng = FC.createEngine({ flows: [flow({ statusSlot: 'http_status' }, { debug: true })], onDebug: (e) => events.push(e),
      rest: (req) => { reqs.push(req); return { status: 200, body: '{"rate": 2, "source": {"name": "Mock"}, "secret": "s3cr3t"}' }; } });
    const t = await runTo(eng, 'GBP', '5');
    assert.strictEqual(reqs[0].endpoint, 'fx');
    assert.strictEqual(reqs[0].path, '/rates/GBP?amount=5&user=');
    assert.strictEqual(eng.getState(t.sessionId).slots.http_status, 200);
    const ev = events.find((e) => e.event === 'rest');
    assert.strictEqual(ev.status, 200);
    assert.deepStrictEqual(ev.mapped, ['rate', 'bank', 'first_tier']);
    assert.ok(!JSON.stringify(events).includes('s3cr3t'));
  });
  await test('editing an answer replays: a GET runs again quietly with the new value; a POST is not repeated', async () => {
    for (const method of ['GET', 'POST']) {
      const f = fakeFetch((url) => ({ status: 200, body: { rate: url.indexOf('USD') > 0 ? 1.5 : 1.1, source: { name: 'X' } } }));
      const fl = flow({ method, next: 'review' });
      fl.nodes.push({ id: 'review', type: 'summary', text: 'Check:', next: 'done' });
      const eng = FC.createEngine({ flows: [fl], restEndpoints: FX, fetch: f });
      let t = await runTo(eng, 'EUR', '1');
      t = await eng.input(t.sessionId, { command: 'edit', slot: 'currency' });
      t = await eng.input(t.sessionId, { value: 'USD' });
      assert.strictEqual(f.calls.length, method === 'GET' ? 2 : 1, method);
      assert.strictEqual(eng.getState(t.sessionId).slots.rate, method === 'GET' ? 1.5 : 1.1, method);
      assert.ok(!/The rate is/.test(texts(t)), method + ': no message on replay');
    }
  });
  console.log(passed + ' passed');
})();
