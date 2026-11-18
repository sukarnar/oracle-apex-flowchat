// Run: node tests/phase-e.test.js
// Phase E: version pinning, debug logging, PII masking, resume, Repeat (line items), Bulk update, file answers.
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}
const texts = (t) => t.messages.map((m) => m.text || '').join(' | ');
const b64 = (s) => Buffer.from(s).toString('base64');

const hello = (version, greeting) => ({
  flowId: 'hello', version, start: 'hi',
  nodes: [
    { id: 'hi', type: 'message', text: greeting, next: 'ask' },
    { id: 'ask', type: 'ask', slot: 'name', prompt: 'Your name?', input: { kind: 'text' }, next: 'bye' },
    { id: 'bye', type: 'end', text: 'Bye {{name}}.' }
  ]
});

const order = {
  flowId: 'order', start: 'lines',
  nodes: [
    { id: 'lines', type: 'repeat', slot: 'lines', label: 'Order lines', itemLabel: 'line', min: 1, max: 3,
      itemTitle: '{{qty}} × {{product}}',
      fields: [
        { field: 'product', label: 'Product', prompt: 'Product for line {{n}}?', input: { kind: 'text' } },
        { field: 'qty', label: 'Quantity', prompt: 'How many {{product}}?', input: { kind: 'number', min: 1 } }
      ], next: 'check' },
    { id: 'check', type: 'condition', branches: [{ when: { slot: 'lines.count', op: '>=', value: 2 }, next: 'review' }], else: 'review' },
    { id: 'review', type: 'summary', next: 'save' },
    { id: 'save', type: 'submit', connector: 'save_order', onSuccess: 'done' },
    { id: 'done', type: 'end', text: 'Saved {{lines}} lines.' }
  ]
};

function bulkSetup() {
  const rows = [
    { id: 1, owner: 'JSMITH', status: 'NEW', version: 1 },
    { id: 2, owner: 'JSMITH', status: 'NEW', version: 1 },
    { id: 3, owner: 'OTHER', status: 'NEW', version: 1 },
    { id: 4, owner: 'JSMITH', status: 'CLOSED', version: 1 }
  ];
  const src = FC.createMemorySource({
    rows, key: 'id', versionField: 'version',
    fields: { id: { searchable: true }, owner: { searchable: true }, status: { searchable: true, updatable: true } }
  });
  const flow = {
    flowId: 'bulk', start: 'ask', bindings: { cur_status: { dom: '#status' } },   // bound, so context seeds it
    nodes: [
      { id: 'ask', type: 'ask', slot: 'owner', prompt: 'Whose?', input: { kind: 'text' }, next: 'close' },
      { id: 'close', type: 'bulkUpdate', source: 'apps', maxRows: 5,
        criteria: [{ slot: 'owner', field: 'owner', op: 'eq' }, { slot: 'cur_status', field: 'status', op: 'eq' }],
        set: { status: { value: 'CLOSED', label: 'Status' } }, card: { title: 'App {{id}}' },
        done: 'end', none: 'nothing', cancelled: 'nothing' },
      { id: 'end', type: 'end', text: 'All done.' },
      { id: 'nothing', type: 'end', text: 'Nothing changed.' }
    ]
  };
  return { rows, src, flow };
}

(async () => {
  console.log('version pinning');
  await test('start uses the latest definition unless a version is pinned', async () => {
    const eng = FC.createEngine({ flows: [hello(1, 'Old hello'), hello(2, 'New hello')] });
    assert.match(texts(await eng.start('hello', {})), /New hello/);
    const t = await eng.start('hello', {}, { version: 1 });
    assert.match(texts(t), /Old hello/);
    assert.strictEqual(t.version, 1);
    const t2 = await eng.input(t.sessionId, { value: 'Ann' });   // the session stays on version 1
    assert.match(texts(t2), /Bye Ann/);
    assert.strictEqual(t2.version, 1);
  });
  await test('an unknown version is refused', async () => {
    const eng = FC.createEngine({ flows: [hello(2, 'Hi')] });
    await assert.rejects(eng.start('hello', {}, { version: 7 }), /Version 7 of flow "hello" is not available/);
  });

  console.log('debug logging and PII masking');
  await test('debug events cover steps, branches and connectors, with PII and codes masked', async () => {
    const events = [];
    const flow = {
      flowId: 'dbg', debug: true, start: 'ssn',
      nodes: [
        { id: 'ssn', type: 'ask', slot: 'ssn', pii: true, prompt: 'SSN?', input: { kind: 'text' }, next: 'card' },
        { id: 'card', type: 'ask', slot: 'card', pii: 'last4', prompt: 'Card?', input: { kind: 'text' }, next: 'route' },
        { id: 'route', type: 'condition', branches: [{ when: { slot: 'ssn', op: 'notEmpty' }, next: 'look' }], else: 'end' },
        { id: 'look', type: 'lookup', connector: 'check', next: 'end' },
        { id: 'end', type: 'end', text: 'ok' }
      ]
    };
    const eng = FC.createEngine({ flows: [flow], onDebug: (e) => events.push(e),
      connectors: { check: (p) => ({ found: true, slots: { echo: p.slots.ssn } }) } });
    const t = await eng.start('dbg', {});
    await eng.input(t.sessionId, { value: '123-45-6789' });
    await eng.input(t.sessionId, { value: '4111111111111111' });
    const all = JSON.stringify(events);
    assert.ok(events.some((e) => e.event === 'node' && e.node === 'route'));
    assert.ok(events.some((e) => e.event === 'branch' && e.next === 'look'));
    assert.ok(events.some((e) => e.event === 'connector' && e.connector === 'check' && typeof e.ms === 'number'));
    assert.ok(!all.includes('123-45-6789'), 'SSN never logged');
    assert.ok(!all.includes('4111111111111111'), 'card never logged in full');
    assert.ok(all.includes('[redacted]'));
    assert.ok(all.includes('••••1111'));
  });
  await test('no events when debug is off', async () => {
    const events = [];
    const eng = FC.createEngine({ flows: [hello(1, 'Hi')] });
    eng.registerFlow(hello(1, 'Hi'));
    await eng.start('hello', {});
    assert.strictEqual(events.length, 0);
  });
  await test('maskJsonText masks values inside JSON text, longest first', async () => {
    const out = FC.maskJsonText(JSON.stringify({ a: 'John Smith', b: 'Smith' }), [{ v: 'Smith', mode: 'full' }, { v: 'John Smith', mode: 'full' }]);
    assert.strictEqual(out, JSON.stringify({ a: '[redacted]', b: '[redacted]' }));
  });

  console.log('resume');
  await test('resume repeats the current question and re-sends every value', async () => {
    const eng = FC.createEngine({ flows: [hello(1, 'Hi')] });
    const t = await eng.start('hello', {});
    const r = await eng.input(t.sessionId, { command: 'resume' });
    assert.match(texts(r), /Welcome back/);
    assert.match(texts(r), /Your name\?/);
    assert.strictEqual(r.await.slot, 'name');
    const r2 = await eng.input(t.sessionId, { value: 'Bo' });
    assert.match(texts(r2), /Bye Bo/);
  });

  console.log('repeat (line items)');
  await test('collects items, shows the list, removes one, and passes the array to submit', async () => {
    let saved = null;
    const eng = FC.createEngine({ flows: [order], connectors: { save_order: (p) => { saved = p.slots.lines; return { ok: true }; } } });
    let t = await eng.start('order', {});
    assert.match(texts(t), /Product for line 1\?/);
    assert.strictEqual(t.await.slot, 'lines.product');
    t = await eng.input(t.sessionId, { value: 'Pens' });
    assert.match(texts(t), /How many Pens\?/);
    t = await eng.input(t.sessionId, { value: '0' });
    assert.strictEqual(t.messages[0].type, 'error');                   // min 1
    t = await eng.input(t.sessionId, { value: '3' });
    assert.match(texts(t), /Added 3 × Pens/);
    assert.strictEqual(t.await.type, 'listMenu');
    assert.deepStrictEqual(t.await.items.map((i) => i.title), ['3 × Pens']);
    t = await eng.input(t.sessionId, { command: 'add' });
    t = await eng.input(t.sessionId, { value: 'Ink' });
    t = await eng.input(t.sessionId, { value: '2' });
    t = await eng.input(t.sessionId, { command: 'add' });
    t = await eng.input(t.sessionId, { value: 'Paper' });
    t = await eng.input(t.sessionId, { value: '1' });
    assert.strictEqual(t.await.canAdd, false);                          // max 3
    t = await eng.input(t.sessionId, { command: 'remove', index: 1 });
    assert.match(texts(t), /Removed 2 × Ink/);
    t = await eng.input(t.sessionId, { command: 'done' });
    assert.strictEqual(t.await.type, 'summary');
    const item = t.messages.find((m) => m.type === 'summary').items.find((i) => i.slot === 'lines');
    assert.strictEqual(item.display, '3 × Pens; 1 × Paper');
    t = await eng.input(t.sessionId, { value: 'confirm' });
    assert.match(texts(t), /Saved 2 lines/);
    assert.deepStrictEqual(saved, [{ product: 'Pens', qty: 3 }, { product: 'Paper', qty: 1 }]);
  });
  await test('Back inside an item steps to the previous field, then drops the item', async () => {
    const eng = FC.createEngine({ flows: [order], connectors: { save_order: () => ({ ok: true }) } });
    let t = await eng.start('order', {});
    t = await eng.input(t.sessionId, { value: 'Pens' });
    t = await eng.input(t.sessionId, { value: '1' });
    t = await eng.input(t.sessionId, { command: 'add' });
    t = await eng.input(t.sessionId, { value: 'Ink' });
    assert.ok(t.canGoBack);
    t = await eng.input(t.sessionId, { command: 'back' });
    assert.match(texts(t), /Product for line 2\?/);
    t = await eng.input(t.sessionId, { command: 'back' });
    assert.match(texts(t), /dropped that one/);
    assert.strictEqual(t.await.type, 'listMenu');
    assert.strictEqual(t.await.items.length, 1);
  });
  await test('Edit from the summary reopens the list and returns to the summary', async () => {
    const eng = FC.createEngine({ flows: [order], connectors: { save_order: () => ({ ok: true }) } });
    let t = await eng.start('order', {});
    t = await eng.input(t.sessionId, { value: 'Pens' });
    t = await eng.input(t.sessionId, { value: '1' });
    t = await eng.input(t.sessionId, { command: 'done' });
    t = await eng.input(t.sessionId, { command: 'edit', slot: 'lines' });
    assert.strictEqual(t.await.type, 'listMenu');
    t = await eng.input(t.sessionId, { command: 'add' });
    t = await eng.input(t.sessionId, { value: 'Ink' });
    t = await eng.input(t.sessionId, { value: '5' });
    t = await eng.input(t.sessionId, { command: 'done' });
    assert.strictEqual(t.await.type, 'summary');
    assert.match(JSON.stringify(t.messages), /1 × Pens; 5 × Ink/);
  });

  await test('a lookup-list choice inside an item uses the list, and PII item fields are masked in debug', async () => {
    const events = [];
    const flow = {
      flowId: 'kids', debug: true, start: 'kids',
      nodes: [
        { id: 'kids', type: 'repeat', slot: 'kids', min: 1, max: 5, itemTitle: '{{name}} ({{school}})',
          fields: [
            { field: 'name', pii: true, prompt: 'Name?', input: { kind: 'text' } },
            { field: 'school', prompt: 'School?', input: { kind: 'choice', optionsFrom: 'schools' } }
          ], next: 'end' },
        { id: 'end', type: 'end', text: 'ok' }
      ]
    };
    const eng = FC.createEngine({ flows: [flow], onDebug: (e) => events.push(e),
      lovs: { schools: () => [{ value: 'S1', label: 'Hill School' }, { value: 'S2', label: 'Lake School' }] } });
    let t = await eng.start('kids', {});
    t = await eng.input(t.sessionId, { value: 'Rosalind Kerr' });
    assert.deepStrictEqual(t.await.input.options.map((o) => o.label), ['Hill School', 'Lake School']);
    t = await eng.input(t.sessionId, { value: 'Lake School' });
    assert.match(texts(t), /Added \[?Rosalind Kerr \(Lake School\)/);
    assert.ok(!JSON.stringify(events).includes('Rosalind Kerr'), 'PII item field masked in debug');
  });

  console.log('bulk update');
  await test('confirms the matching records, then updates each through the data source', async () => {
    const { rows, src, flow } = bulkSetup();
    const eng = FC.createEngine({ flows: [flow], dataSources: { apps: src } });
    let t = await eng.start('bulk', { cur_status: 'NEW' });
    t = await eng.input(t.sessionId, { value: 'JSMITH' });
    assert.strictEqual(t.await.type, 'confirm');
    assert.strictEqual(t.await.confirmLabel, 'Update 2');
    assert.match(texts(t), /set Status = CLOSED on 2 records/);
    const list = t.messages.find((m) => m.type === 'list');
    assert.deepStrictEqual(list.items.map((i) => i.title), ['App 1', 'App 2']);
    assert.ok(!JSON.stringify(t).includes('"keys"'), 'keys stay on the server');
    t = await eng.input(t.sessionId, { command: 'confirm' });
    assert.match(texts(t), /updated 2 of 2/);
    assert.deepStrictEqual(rows.map((r) => r.status), ['CLOSED', 'CLOSED', 'NEW', 'CLOSED']);
    assert.strictEqual(rows[0].version, 2);
    assert.strictEqual(rows[3].version, 1);                              // not matched, untouched
  });
  await test('bulk update: a row whose update throws fails alone, with its message', async () => {
    const { rows, src, flow } = bulkSetup();
    const update = src.update;
    src.update = (req) => {
      if (req.key === 2 || req.key === '2') {
        throw new Error('ORA-20001: App 2 has an open payment.\nORA-06512: at "LOANS.APP_BU", line 3\nORA-04088: error during execution of trigger');
      }
      return update(req);
    };
    const eng = FC.createEngine({ flows: [flow], dataSources: { apps: src } });
    let t = await eng.start('bulk', { cur_status: 'NEW' });
    t = await eng.input(t.sessionId, { value: 'JSMITH' });
    t = await eng.input(t.sessionId, { command: 'confirm' });
    assert.match(texts(t), /updated 1 of 2 records\. 1 could not be changed .* App 2 has an open payment\./);
    assert.ok(!/ORA-/.test(texts(t)), 'no Oracle error text');
    assert.strictEqual(t.status, 'completed');                            // took the done port
    assert.deepStrictEqual(rows.map((r) => r.status), ['CLOSED', 'NEW', 'NEW', 'CLOSED']);
  });
  await test('save changes: a throwing update takes the error port with a clean message', async () => {
    const rows = [{ id: 7, email: 'a@b.co', amount: 100, version: 1 }];
    const src = FC.createMemorySource({ rows, key: 'id', versionField: 'version',
      fields: { email: { searchable: true }, amount: { updatable: true } } });
    let fail = 'ORA-20001: The amount is fixed once approved.\nORA-06512: at "LOANS.TRG", line 4';
    const update = src.update;
    src.update = (req) => { if (fail) throw new Error(fail); return update(req); };
    const flow = {
      flowId: 'upd', start: 'ask',
      nodes: [
        { id: 'ask', type: 'ask', slot: 'email', prompt: 'Email?', input: { kind: 'email' }, next: 'find' },
        { id: 'find', type: 'findRecord', source: 'apps', as: 'app', criteria: [{ field: 'email', slot: 'email' }], found: 'change' },
        { id: 'change', type: 'changeFields', record: 'app', done: 'save',
          fields: [{ field: 'amount', label: 'Amount', input: { kind: 'number' } }] },
        { id: 'save', type: 'saveChanges', record: 'app', saved: 'done', error: 'oops' },
        { id: 'oops', type: 'end', text: 'Not saved.' },
        { id: 'done', type: 'end', text: 'Saved.' }
      ]
    };
    const eng = FC.createEngine({ flows: [flow], dataSources: { apps: src } });
    const edit = async () => {
      let t = await eng.start('upd');
      t = await eng.input(t.sessionId, { value: 'a@b.co' });
      t = await eng.input(t.sessionId, { field: 'amount' });
      t = await eng.input(t.sessionId, { value: '250' });
      return eng.input(t.sessionId, { command: 'done' });
    };
    let t = await edit();
    assert.ok(t.messages.some((m) => m.type === 'error' && m.text === 'The amount is fixed once approved.'));
    assert.match(texts(t), /Not saved\./);
    assert.strictEqual(rows[0].amount, 100);
    fail = 'ORA-01722: invalid number';                                   // not an application error: generic text
    t = await edit();
    assert.ok(t.messages.some((m) => m.type === 'error' && m.text === 'Sorry, the changes could not be saved.'));
    assert.ok(!/ORA-/.test(texts(t)));
    const err = new Error('HTTP 409'); err.userMessage = 'This loan is locked by the underwriter.';
    fail = null; src.update = (req) => { throw err; };
    t = await edit();
    assert.ok(t.messages.some((m) => m.text === 'This loan is locked by the underwriter.'));
  });
  await test('cancel changes nothing; too many matches is refused; not-updatable fields fail', async () => {
    const { rows, src, flow } = bulkSetup();
    const eng = FC.createEngine({ flows: [flow], dataSources: { apps: src } });
    let t = await eng.start('bulk', { cur_status: 'NEW' });
    t = await eng.input(t.sessionId, { value: 'JSMITH' });
    t = await eng.input(t.sessionId, { command: 'cancel' });
    assert.match(texts(t), /didn't change anything/);
    assert.ok(rows.every((r) => r.id === 4 || r.status === 'NEW'));

    const f2 = JSON.parse(JSON.stringify(flow));
    f2.flowId = 'bulk2'; f2.nodes[1].maxRows = 1;
    eng.registerFlow(f2);
    t = await eng.start('bulk2', { cur_status: 'NEW' });
    t = await eng.input(t.sessionId, { value: 'JSMITH' });
    assert.match(texts(t), /too many to change at once/);

    const f3 = JSON.parse(JSON.stringify(flow));
    f3.flowId = 'bulk3'; f3.nodes[1].set = { owner: { value: 'ME' } };
    eng.registerFlow(f3);
    t = await eng.start('bulk3', { cur_status: 'NEW' });
    t = await eng.input(t.sessionId, { value: 'JSMITH' });
    t = await eng.input(t.sessionId, { command: 'confirm' });
    assert.match(texts(t), /0 of 2 records\. 2 could not be changed/);
    assert.ok(rows.every((r) => r.owner !== 'ME'));
  });

  console.log('file answers');
  const fileFlow = {
    flowId: 'docs', start: 'doc',
    nodes: [
      { id: 'doc', type: 'ask', slot: 'doc', label: 'Payslip', prompt: 'Please attach your payslip.',
        input: { kind: 'file', accept: ['.pdf', 'image/*'], maxSizeKb: 1 }, next: 'review' },
      { id: 'review', type: 'summary', next: 'save' },
      { id: 'save', type: 'submit', connector: 'save', onSuccess: 'done' },
      { id: 'done', type: 'end', text: 'Got {{doc}}.' }
    ]
  };
  await test('checks type and size, stores the content apart, and gives connectors {id, name, size, mimeType}', async () => {
    let got = null;
    const eng = FC.createEngine({ flows: [fileFlow], connectors: { save: (p) => { got = p.slots.doc; return { ok: true }; } } });
    let t = await eng.start('docs', {});
    assert.strictEqual(t.await.input.kind, 'file');
    t = await eng.input(t.sessionId, { value: 'here it is' });
    assert.match(texts(t), /Please attach a file/);
    t = await eng.input(t.sessionId, { file: { name: 'evil.exe', mimeType: 'application/x-msdownload', data: b64('MZ') } });
    assert.match(texts(t), /\.pdf, image\/\*/);
    t = await eng.input(t.sessionId, { file: { name: 'big.pdf', mimeType: 'application/pdf', data: b64('x'.repeat(2000)) } });
    assert.match(texts(t), /too big/);
    t = await eng.input(t.sessionId, { file: { name: 'pay.pdf', mimeType: 'application/pdf', data: b64('%PDF-1.4 hello') } });
    assert.strictEqual(t.await.type, 'summary');
    assert.match(JSON.stringify(t.messages), /pay\.pdf \(1 KB\)/);
    const st = eng.getState(t.sessionId);
    assert.ok(!JSON.stringify(st).includes(b64('%PDF-1.4 hello')), 'content is not in the session state');
    t = await eng.input(t.sessionId, { value: 'confirm' });
    assert.match(texts(t), /Got pay\.pdf/);
    assert.deepStrictEqual(Object.keys(got).sort(), ['id', 'mimeType', 'name', 'size']);
    assert.strictEqual(Buffer.from(eng.getFile(t.sessionId, got.id).data, 'base64').toString(), '%PDF-1.4 hello');
    assert.strictEqual(eng.getFile('someone-else', got.id), null);
  });
  await test('a custom file store receives the upload, and a replaced file is removed', async () => {
    const store = new Map(); let n = 0;
    const files = { save: (f) => { const id = 'F' + (++n); store.set(id, f); return id; }, remove: ({ fileId }) => store.delete(fileId) };
    const events = [];
    const f = JSON.parse(JSON.stringify(fileFlow)); f.debug = true;
    const eng = FC.createEngine({ flows: [f], files, onDebug: (e) => events.push(e), connectors: { save: () => ({ ok: true }) } });
    let t = await eng.start('docs', {});
    t = await eng.input(t.sessionId, { file: { name: 'a.png', mimeType: 'image/png', data: b64('PNG1') } });
    t = await eng.input(t.sessionId, { command: 'edit', slot: 'doc' });
    t = await eng.input(t.sessionId, { file: { name: 'b.png', mimeType: 'image/png', data: b64('PNG2') } });
    assert.deepStrictEqual([...store.keys()], ['F2']);
    assert.ok(!JSON.stringify(events).includes(b64('PNG1')), 'file content never logged');
  });

  console.log(passed + ' passed');
})();
