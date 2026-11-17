// Run: node tests/agent.test.js
// The Agent node, driven by a scripted mock model (no real LLM): dynamic questions, tools, skills,
// write tools behind a confirmation, finish -> fields -> Summary/Submit, handoff, failures, JSON mode.
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}
const texts = (t) => t.messages.map((m) => m.text || '').join(' | ');
const call = (name, args, id) => ({ id: id || name + '_' + Math.random().toString(36).slice(2, 7), type: 'function',
                                    function: { name, arguments: JSON.stringify(args) } });
// A provider that replays a script. Each step is an assistant message, or fn(req) -> message.
function scripted(steps, seen) {
  let i = 0;
  return (req) => {
    if (seen) seen.push(JSON.parse(JSON.stringify(req)));
    const s = steps[i++];
    if (!s) throw new Error('script exhausted');
    return typeof s === 'function' ? s(req) : s;
  };
}
const lastTool = (req) => JSON.parse([...req.messages].reverse().find((m) => m.role === 'tool').content);

const flow = (agent) => ({
  flowId: 'leave', start: 'agent',
  nodes: [
    Object.assign({ id: 'agent', type: 'agent', provider: 'llm', goal: 'Help {{app_user}} apply for leave.',
      inputs: ['context.emp_id'], tools: ['get_balance', 'book_leave'], skills: ['policy'],
      outputs: [{ name: 'leave_type', label: 'Leave type', kind: 'choice', options: ['annual', 'sick'] },
                { name: 'days', label: 'Days', kind: 'number', min: 1 }],
      exits: [{ name: 'payslip', description: 'payslip questions', next: 'payslip' }],
      next: 'review', onError: 'manual' }, agent || {}),
    { id: 'review', type: 'summary', text: 'Check:', next: 'submit' },
    { id: 'submit', type: 'submit', connector: 'save', onSuccess: 'done' },
    { id: 'payslip', type: 'end', text: 'Payslips are on the HR portal.' },
    { id: 'manual', type: 'end', text: 'Please use the leave form.' },
    { id: 'done', type: 'end', text: 'Submitted.' }
  ]
});
function engine(steps, extra, seen) {
  const log = { calls: [], saved: null };
  const eng = FC.createEngine(Object.assign({
    flows: [flow(extra && extra.agent)], appUser: 'JSMITH',
    aiProviders: { llm: scripted(steps, seen) },
    aiTools: {
      get_balance: { description: 'Leave balance of an employee', type: 'connector', target: 'balance',
                     parameters: { type: 'object', properties: { emp_id: { type: 'string' } }, required: ['emp_id'] } },
      book_leave: { description: 'Book the leave', type: 'connector', target: 'book', write: true,
                    parameters: { type: 'object', properties: { days: { type: 'number' } } } }
    },
    aiSkills: { policy: { name: 'Leave policy', description: 'Rules for leave', content: 'Annual leave needs 2 weeks notice.' } },
    connectors: {
      balance: (p) => { log.calls.push(p); return { annual: 12, sick: 5 }; },
      book: (p) => { log.calls.push(p); return { ok: true, ref: 'LV-1' }; },
      save: (p) => { log.saved = p.slots; return { ok: true, message: 'Saved.' }; }
    }
  }, extra && extra.opts));
  return { eng, log };
}

(async () => {
  console.log('agent node');
  await test('asks dynamic questions, uses a tool and a skill, finishes into fields, then Summary and Submit run', async () => {
    const seen = [];
    const { eng, log } = engine([
      { content: null, tool_calls: [call('load_skill', { id: 'policy' }), call('get_balance', { emp_id: 'E1' })] },
      (req) => { assert.deepStrictEqual(lastTool(req), { annual: 12, sick: 5 });
                 return { content: 'You have 12 annual days.', tool_calls: [call('ask_user', { question: 'Which type?', field: 'leave_type' })] }; },
      (req) => { assert.deepStrictEqual(lastTool(req), { answer: 'annual' });
                 return { tool_calls: [call('ask_user', { question: 'How many days?', field: 'days' })] }; },
      { tool_calls: [call('finish', { fields: { leave_type: 'annual' }, message: 'Thanks, all set.' })] }
    ], null, seen);
    let t = await eng.start('leave', { emp_id: 'E1' });
    assert.match(texts(t), /You have 12 annual days\. \| Which type\?/);
    assert.strictEqual(t.await.input.kind, 'choice');
    assert.strictEqual(t.await.input.display, 'buttons');
    assert.strictEqual(t.await.slot, 'leave_type');
    assert.strictEqual(log.calls[0].tool, 'get_balance');
    assert.strictEqual(log.calls[0].appUser, 'JSMITH');
    const sys = seen[0].messages[0].content;
    assert.match(sys, /Help JSMITH apply for leave/);
    assert.match(sys, /"context.emp_id":"E1"/);
    assert.ok(seen[0].tools.some((x) => x.function.name === 'handoff'));
    t = await eng.input(t.sessionId, { value: 'annual' });
    t = await eng.input(t.sessionId, { value: 'ten' });                       // checked by the engine, not the model
    assert.strictEqual(t.messages[0].type, 'error');
    t = await eng.input(t.sessionId, { value: '3' });
    assert.match(texts(t), /Thanks, all set\. \| Check:/);
    const sum = t.messages.find((m) => m.type === 'summary');
    assert.deepStrictEqual(sum.items.map((i) => [i.label, i.display]), [['Leave type', 'annual'], ['Days', '3']]);
    t = await eng.input(t.sessionId, { value: 'confirm' });
    assert.deepStrictEqual(log.saved, { leave_type: 'annual', days: 3 });
    assert.strictEqual(t.status, 'completed');
  });
  await test('a write tool waits for the user to confirm; Cancel tells the model it was declined', async () => {
    const { eng, log } = engine([
      { tool_calls: [call('book_leave', { days: 2 }, 'b1')] },
      (req) => { assert.deepStrictEqual(lastTool(req), { ok: true, ref: 'LV-1' }); return { tool_calls: [call('book_leave', { days: 4 }, 'b2')] }; },
      (req) => { assert.strictEqual(lastTool(req).cancelled, true); return { tool_calls: [call('finish', { fields: { leave_type: 'sick', days: 2 } })] }; }
    ]);
    let t = await eng.start('leave', {});
    assert.match(texts(t), /Please confirm: Book the leave\ndays: 2/);
    assert.deepStrictEqual(t.await.input.options.map((o) => o.value), ['confirm', 'cancel']);
    assert.strictEqual(log.calls.length, 0);                                  // nothing written before Confirm
    t = await eng.input(t.sessionId, { value: 'confirm' });
    assert.strictEqual(log.calls.length, 1);
    assert.deepStrictEqual(log.calls[0].args, { days: 2 });
    t = await eng.input(t.sessionId, { value: 'cancel' });
    assert.strictEqual(log.calls.length, 1);
    assert.strictEqual(t.await.nodeId, 'review');
  });
  await test('finish with a missing or invalid field goes back to the model to fix', async () => {
    const { eng } = engine([
      { tool_calls: [call('finish', { fields: { leave_type: 'holiday', days: 0 } })] },
      (req) => { assert.match(lastTool(req).error, /leave_type: .*days: /); return { tool_calls: [call('finish', { fields: { leave_type: 'sick', days: 1 } })] }; }
    ]);
    const t = await eng.start('leave', {});
    assert.strictEqual(t.await.nodeId, 'review');
    assert.strictEqual(eng.getState(t.sessionId).slots.days, 1);
  });
  await test('handoff follows the exit; give_up and provider errors go to onError', async () => {
    let r = engine([{ tool_calls: [call('handoff', { exit: 'payslip' })] }]);
    let t = await r.eng.start('leave', {});
    assert.match(texts(t), /Payslips are on the HR portal/);
    r = engine([{ tool_calls: [call('give_up', { reason: 'no data' })] }]);
    t = await r.eng.start('leave', {});
    assert.match(texts(t), /Sorry, I couldn't complete this\. \| Please use the leave form\./);
    r = engine([() => { throw new Error('HTTP 503'); }]);
    t = await r.eng.start('leave', {});
    assert.match(texts(t), /Please use the leave form/);
  });
  await test('a plain reply waits for free text; limits stop runaway loops', async () => {
    let r = engine([{ content: 'Which dates do you have in mind?' },
                    (req) => { assert.strictEqual(req.messages[req.messages.length - 1].content, 'next week'); return { tool_calls: [call('finish', { fields: { leave_type: 'annual', days: 5 } })] }; }]);
    let t = await r.eng.start('leave', {});
    assert.strictEqual(t.await.slot, '#agent');
    t = await r.eng.input(t.sessionId, { value: 'next week' });
    assert.strictEqual(t.await.nodeId, 'review');
    const loop = Array.from({ length: 10 }, () => ({ tool_calls: [call('get_balance', { emp_id: 'E1' })] }));
    r = engine(loop, { agent: { limits: { maxSteps: 6, maxCallsPerTurn: 3 } } });
    t = await r.eng.start('leave', {});
    assert.match(texts(t), /still working on it/);
    assert.deepStrictEqual(t.await.input.options.map((o) => o.value), ['continue']);
    t = await r.eng.input(t.sessionId, { value: 'continue' });
    assert.match(texts(t), /Please use the leave form/);                     // step limit -> onError
  });
  await test('Edit of an agent field asks for it directly and does not rerun the agent', async () => {
    const { eng } = engine([{ tool_calls: [call('finish', { fields: { leave_type: 'annual', days: 2 } })] }]);
    let t = await eng.start('leave', {});
    t = await eng.input(t.sessionId, { command: 'edit', slot: 'days' });
    assert.match(texts(t), /What should Days be\?/);
    assert.strictEqual(t.await.input.kind, 'number');
    t = await eng.input(t.sessionId, { value: '4' });
    assert.strictEqual(t.await.nodeId, 'review');                            // replay skipped the finished agent
    assert.strictEqual(eng.getState(t.sessionId).slots.days, 4);
  });
  await test('JSON tool mode for models without native tool calling', async () => {
    const seen = [];
    const steps = [
      { content: '```json\n{"tool": "ask_user", "args": {"question": "How many days?", "field": "days"}}\n```' },
      (req) => { assert.match(req.messages[req.messages.length - 1].content, /^Result of ask_user: \{"answer":2\}/);
                 return { content: '{"tool": "finish", "args": {"fields": {"leave_type": "sick", "days": 2}}}' }; }
    ];
    const { eng } = engine([], { opts: { aiProviders: { llm: { toolMode: 'json', call: scripted(steps, seen) } } } });
    let t = await eng.start('leave', {});
    assert.strictEqual(seen[0].tools, undefined);
    assert.match(seen[0].messages[0].content, /Reply with exactly one JSON object/);
    t = await eng.input(t.sessionId, { value: '2' });
    assert.strictEqual(t.await.nodeId, 'review');
  });
  await test('tools the node does not list are refused', async () => {
    const { eng, log } = engine([
      { tool_calls: [call('save', {})] },
      (req) => { assert.match(lastTool(req).error, /Unknown tool/); return { tool_calls: [call('finish', { fields: { leave_type: 'sick', days: 1 } })] }; }
    ], { agent: { tools: [] } });
    await eng.start('leave', {});
    assert.strictEqual(log.saved, null);
  });
  console.log('agent node, phase 2');
  const pickTools = { find_emp: { description: 'Find employees', type: 'connector', target: 'emps', pick: true,
                                  title: '{{name}}', subtitle: '{{dept}}' } };
  const emps = () => ({ rows: [{ emp_id: 'E7', name: 'Ann Lee', dept: 'Sales' }, { emp_id: 'E9', name: 'Bo Chan', dept: 'IT' }] });
  await test('pick_record shows the found records as cards; the picked record goes back to the model', async () => {
    const { eng } = engine([
      { tool_calls: [call('pick_record', { tool: 'find_emp', args: { name: 'a' }, question: 'Who is covering?' })] },
      (req) => { assert.deepStrictEqual(lastTool(req), { picked: { emp_id: 'E9', name: 'Bo Chan', dept: 'IT' } });
                 return { tool_calls: [call('pick_record', { tool: 'find_emp', args: {} })] }; },
      (req) => { assert.strictEqual(lastTool(req).picked, null);
                 return { tool_calls: [call('finish', { fields: { leave_type: 'sick', days: 1 } })] }; }
    ], { agent: { tools: ['find_emp'] }, opts: { aiTools: pickTools, connectors: { emps, save: () => ({ ok: true }) } } });
    let t = await eng.start('leave', {});
    assert.strictEqual(t.await.type, 'pick');
    assert.deepStrictEqual(t.await.items.map((i) => [i.title, i.subtitle]), [['Ann Lee', 'Sales'], ['Bo Chan', 'IT']]);
    assert.strictEqual(t.await.items[0].values, undefined);            // row values stay on the server
    assert.match(texts(t), /Who is covering\?/);
    t = await eng.input(t.sessionId, { pick: 'nope' });
    assert.match(texts(t), /choose one of the records/);
    t = await eng.input(t.sessionId, { pick: t.await.items[1].token });
    assert.strictEqual(t.await.type, 'pick');
    t = await eng.input(t.sessionId, { pick: null });
    assert.strictEqual(t.await.nodeId, 'review');
  });
  await test('pick_record refuses tools that are not searches, and reports no rows', async () => {
    const { eng } = engine([
      { tool_calls: [call('pick_record', { tool: 'get_balance', args: {} })] },
      (req) => { assert.match(lastTool(req).error, /needs one of these tools: find_emp/);
                 return { tool_calls: [call('pick_record', { tool: 'find_emp', args: {} })] }; },
      (req) => { assert.deepStrictEqual(lastTool(req).rows, []); return { tool_calls: [call('give_up', { reason: 'nobody' })] }; }
    ], { agent: { tools: ['find_emp', 'get_balance'] },
         opts: { aiTools: Object.assign({ get_balance: { description: 'b', type: 'connector', target: 'balance' } }, pickTools),
                 connectors: { emps: () => ({ rows: [] }), balance: () => ({}) } } });
    const t = await eng.start('leave', {});
    assert.match(texts(t), /Please use the leave form/);
  });
  await test('ask_user can ask for a file; a file output is filled only by the upload', async () => {
    const seen = [];
    const { eng } = engine([
      { tool_calls: [call('finish', { fields: { leave_type: 'sick', days: 2, note: 'x' } })] },
      (req) => { assert.match(lastTool(req).error, /note is required \(ask the user to attach it/);
                 return { tool_calls: [call('ask_user', { question: 'Please attach the sick note.', field: 'note' })] }; },
      (req) => { const a = lastTool(req).answer; assert.strictEqual(a.name, 'note.pdf'); assert.ok(a.id);
                 return { tool_calls: [call('finish', { fields: { leave_type: 'sick', days: 2 } })] }; }
    ], { agent: { tools: [], outputs: [{ name: 'leave_type', kind: 'choice', options: ['annual', 'sick'] }, { name: 'days', kind: 'number' },
                                       { name: 'note', label: 'Sick note', kind: 'file', accept: '.pdf' }] } }, seen);
    let t = await eng.start('leave', {});
    assert.ok(!('note' in seen[0].tools.find((d) => d.function.name === 'finish').function.parameters.properties.fields.properties));
    assert.deepStrictEqual(t.await.input, { kind: 'file', accept: '.pdf' });
    t = await eng.input(t.sessionId, { file: { name: 'note.png', mimeType: 'image/png', data: 'aGVsbG8=' } });
    assert.strictEqual(t.await.slot, 'note');                           // wrong type: asked again
    t = await eng.input(t.sessionId, { file: { name: 'note.pdf', mimeType: 'application/pdf', data: 'aGVsbG8=' } });
    assert.strictEqual(t.await.nodeId, 'review');
    assert.strictEqual(eng.getState(t.sessionId).slots.note.name, 'note.pdf');
  });
  await test('PII is sent as placeholders and put back in tool arguments, fields and messages', async () => {
    const seen = [], log = [];
    const agent = { tools: ['get_balance'],
                    outputs: [{ name: 'leave_type', kind: 'choice', options: ['annual', 'sick'] }, { name: 'days', kind: 'number' },
                              { name: 'phone', kind: 'text', pii: true }] };
    const { eng } = engine([
      (req) => { assert.match(req.messages[0].content, /"context.emp_id":"\[PII_1\]"/);
                 assert.ok(!JSON.stringify(req.messages).includes('E12345'));
                 return { tool_calls: [call('get_balance', { emp_id: '[PII_1]' })] }; },
      (req) => { assert.deepStrictEqual(lastTool(req), { owner: '[PII_1]', annual: 12 });
                 return { tool_calls: [call('ask_user', { question: 'Your phone?', sensitive: true })] }; },
      (req) => { assert.deepStrictEqual(lastTool(req), { answer: '[PII_2]' });
                 return { content: 'I will text [PII_2] for [PII_1].', tool_calls: [call('set_field', { field: 'phone', value: '[PII_2]' })] }; },
      (req) => { assert.deepStrictEqual(lastTool(req), { ok: true });
                 return { tool_calls: [call('finish', { fields: { leave_type: 'sick', days: 1 } })] }; }
    ], { agent, opts: { flows: [Object.assign(flow(agent), { piiSlots: ['context.emp_id'], bindings: {} })],
                        connectors: { balance: (p) => { log.push(p.args); return { owner: p.args.emp_id, annual: 12 }; }, save: () => ({ ok: true }) } } }, seen);
    let t = await eng.start('leave', { emp_id: 'E12345' });
    assert.deepStrictEqual(log, [{ emp_id: 'E12345' }]);
    t = await eng.input(t.sessionId, { value: '0412 555 123' });
    assert.match(texts(t), /I will text 0412 555 123 for E12345\./);
    assert.ok(t.fieldUpdates.some((u) => u.slot === 'phone'));
    assert.strictEqual(t.await.nodeId, 'review');
    assert.ok(!JSON.stringify(seen.map((r) => r.messages)).includes('0412 555 123'));
  });
  await test('a REST tool: GET fills the request from the arguments and returns mapped data; a POST waits for Confirm', async () => {
    const reqs = [];
    const tools = {
      holidays: { description: 'Public holidays in a year', type: 'rest', target: 'hr_api',
                  request: { method: 'GET', path: '/holidays/{{year}}', query: { region: '{{region}}', user: '{{app_user}}' },
                             map: { count: '$.items.length', first: '$.items[0].name' } },
                  parameters: { type: 'object', properties: { year: { type: 'string' }, region: { type: 'string' } } } },
      raw: { description: 'Raw', type: 'rest', target: 'hr_api', request: { path: '/raw' } },
      file_leave: { description: 'File the leave in HR', type: 'rest', target: 'hr_api',
                    request: { method: 'POST', path: '/leave', body: { days: '{{days}}', note: 'by {{app_user}}' }, map: { ref: '$.id' } } }
    };
    const rest = (req) => {
      reqs.push(req);
      if (req.path === '/raw') return { status: 200, body: JSON.stringify({ big: 'x'.repeat(9000) }) };
      if (req.method === 'POST') return { status: 201, body: '{"id": "HR-9"}' };
      if (req.path.indexOf('/holidays/1999') === 0) return { status: 404, body: '' };
      return { status: 200, body: { items: [{ name: 'New Year' }, { name: 'Easter' }] } };
    };
    const { eng } = engine([
      { tool_calls: [call('holidays', { year: '2026/../admin', region: 'NSW' })] },
      (req) => { assert.deepStrictEqual(lastTool(req), { status: 200, data: { count: null, first: 'New Year' } });
                 return { tool_calls: [call('holidays', { year: '1999', region: 'NSW' })] }; },
      (req) => { assert.deepStrictEqual(lastTool(req), { status: 404, found: false });
                 return { tool_calls: [call('raw', {})] }; },
      (req) => { const r = lastTool(req); assert.strictEqual(r.truncated, true); assert.strictEqual(r.data.length, 6000);
                 return { tool_calls: [call('file_leave', { days: 3 }, 'f1')] }; },
      (req) => { assert.deepStrictEqual(lastTool(req), { status: 201, data: { ref: 'HR-9' } });
                 return { tool_calls: [call('finish', { fields: { leave_type: 'annual', days: 3 } })] }; }
    ], { agent: { tools: ['holidays', 'raw', 'file_leave'] }, opts: { aiTools: tools, rest } });
    let t = await eng.start('leave', {});
    assert.strictEqual(reqs[0].endpoint, 'hr_api');
    assert.strictEqual(reqs[0].path, '/holidays/2026%2F%2E%2E%2Fadmin?region=NSW&user=JSMITH');
    assert.strictEqual(reqs[0].tool, 'holidays');
    assert.match(texts(t), /Please confirm: File the leave in HR\ndays: 3/);   // not a GET: confirmed first
    assert.strictEqual(reqs.length, 3);
    t = await eng.input(t.sessionId, { value: 'confirm' });
    assert.deepStrictEqual(reqs[3].body, { days: 3, note: 'by JSMITH' });
    assert.strictEqual(t.await.nodeId, 'review');
  });
  await test('a REST tool error reaches the model as {error}, and the endpoint registry still applies', async () => {
    const tools = { del: { description: 'Delete', type: 'rest', target: 'hr_api', confirm: false, request: { method: 'DELETE', path: '/x' } },
                    bad: { description: 'Bad', type: 'rest', target: 'hr_api', request: { path: 'https://evil.example.com/' } } };
    const { eng } = engine([
      { tool_calls: [call('del', {})] },
      (req) => { assert.deepStrictEqual(lastTool(req), { error: 'endpoint "hr_api" does not allow DELETE' });
                 return { tool_calls: [call('bad', {})] }; },
      (req) => { assert.deepStrictEqual(lastTool(req), { error: 'the path must start with / or ?' });
                 return { tool_calls: [call('give_up', { reason: 'done testing' })] }; }
    ], { agent: { tools: ['del', 'bad'] }, opts: { aiTools: tools, restEndpoints: { hr_api: { baseUrl: 'https://hr.example.com', methods: ['GET'] } },
                                                    fetch: () => { throw new Error('must not be called'); } } });
    const t = await eng.start('leave', {});
    assert.match(texts(t), /Please use the leave form/);
  });
  console.log(passed + ' passed');
})();
