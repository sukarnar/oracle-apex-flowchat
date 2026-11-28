// Run: node tests/turns.test.js
// Turn by turn without the widget (describeTurn / renderTurn / replyInput): the reference for
// FC_CLIENT.START / REPLY / RENDER in db/19_fc_client.sql.
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');
const trip = require('../flows/trip_booking.json');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}

function tripEngine() {
  return FC.createEngine({
    flows: [Object.assign({}, trip, { debug: false })], appUser: 'JDOE',
    connectors: {
      trip_get_profile: () => ({ found: true, slots: { editable_trips: 0, cancellable_trips: 0, emergency_contacts: [] } }),
      trip_save: () => ({ ok: true, slots: { trip_id: 101, itinerary_no: 'FY26-1', trip_status: 'SAVED' } }),
      trip_mark_pending: () => ({ found: true, slots: { trip_status: 'PENDING_APPROVAL' } })
    },
    lovs: { trip_my_editable: () => [], trip_my_cancellable: () => [] },
    startWorkflow: () => ({ workflowId: 1 })
  });
}

// Sends typed replies the way a chat channel would; returns the last turn described.
async function chat(eng, turn, replies) {
  for (const r of replies) {
    turn = await eng.input(turn.sessionId, FC.replyInput(FC.describeTurn(turn), r));
  }
  return turn;
}

const CONTACT = ['Ana Doe', '1', '+1 555 123 4567', 'ana@example.com'];

(async () => {
  console.log('turns.test.js');

  await test('the first question: kind, slot, question and progress', async () => {
    const eng = tripEngine();
    const t = FC.describeTurn(await eng.start('trip_booking', {}));
    assert.strictEqual(t.status, 'in_progress');
    assert.strictEqual(t.kind, 'text');
    assert.strictEqual(t.slot, 'emergency_contacts.name');
    assert.ok(/full name/.test(t.question), t.question);
    assert.ok(t.messages.length >= 2);
    assert.strictEqual(typeof t.progressTotal, 'number');
  });

  await test('a choice answered by its number, a label or a value', async () => {
    const eng = tripEngine();
    let turn = await chat(eng, await eng.start('trip_booking', {}), ['Ana Doe']);
    const t = FC.describeTurn(turn);
    assert.strictEqual(t.kind, 'choice');
    assert.strictEqual(t.options[0].label, 'Spouse / partner');
    assert.deepStrictEqual(FC.replyInput(t, '1'), { value: t.options[0].value });
    assert.deepStrictEqual(FC.replyInput(t, 'Parent'), { value: 'Parent' });
    assert.deepStrictEqual(FC.replyInput(t, ' back '), { command: 'back' });
    assert.ok(/^1\. Spouse \/ partner$/m.test(FC.renderTurn(t)));
    assert.ok(/Reply with a number\. BACK goes back\./.test(FC.renderTurn(t)));
    turn = await chat(eng, turn, ['2']);
    assert.strictEqual(FC.describeTurn(turn).slot, 'emergency_contacts.phone');
  });

  await test('a refused answer: error set, same question again', async () => {
    const eng = tripEngine();
    const turn = await chat(eng, await eng.start('trip_booking', {}), ['x']);
    const t = FC.describeTurn(turn);
    assert.strictEqual(t.slot, 'emergency_contacts.name');
    assert.ok(/at least 2/.test(t.error), t.error);
  });

  await test('a list: ADD / DONE / EDIT n / REMOVE n', async () => {
    const eng = tripEngine();
    const turn = await chat(eng, await eng.start('trip_booking', {}), CONTACT);
    const t = FC.describeTurn(turn);
    assert.strictEqual(t.kind, 'list');
    assert.strictEqual(t.options.length, 1);
    assert.ok(t.canAdd && t.canDone);
    assert.deepStrictEqual(FC.replyInput(t, 'add'), { command: 'add' });
    assert.deepStrictEqual(FC.replyInput(t, 'Done'), { command: 'done' });
    assert.deepStrictEqual(FC.replyInput(t, 'remove 1'), { command: 'remove', index: 0 });
    assert.deepStrictEqual(FC.replyInput(t, 'edit 1'), { command: 'editItem', index: 0 });
    const text = FC.renderTurn(t);
    assert.ok(/1\. Ana Doe/.test(text), text);
    assert.ok(/Reply ADD, .*REMOVE n, DONE\./.test(text), text);
  });

  await test('a whole conversation typed: change a destination in place', async () => {
    const eng = tripEngine();
    let turn = await chat(eng, await eng.start('trip_booking', {}), [
      ...CONTACT, 'done', '1',
      'Berlin', 'Germany', '2027-03-01', '2027-03-02', '1', 'LH 401']);
    let t = FC.describeTurn(turn);
    assert.strictEqual(t.kind, 'list');
    assert.strictEqual(t.slot, 'destinations');

    turn = await chat(eng, turn, ['change 1']);
    t = FC.describeTurn(turn);
    assert.strictEqual(t.kind, 'fields');
    assert.strictEqual(t.options[5].value, 'transport_name');
    assert.strictEqual(t.options[5].detail, 'LH 401');
    assert.deepStrictEqual(FC.replyInput(t, '6'), { field: 'transport_name' });

    turn = await chat(eng, turn, ['6']);
    t = FC.describeTurn(turn);
    assert.strictEqual(t.slot, 'destinations.transport_name');
    assert.strictEqual(t.value, 'LH 401');
    turn = await chat(eng, turn, ['LH 999', 'done']);
    t = FC.describeTurn(turn);
    assert.strictEqual(t.kind, 'list');
    assert.ok(/LH 999/.test(t.options[0].label), t.options[0].label);
    assert.strictEqual(eng.getState(turn.sessionId).slots.destinations[0].transport_name, 'LH 999');
  });

  await test('a note is rendered with its style', async () => {
    const eng = tripEngine();
    const turn = await chat(eng, await eng.start('trip_booking', {}), [
      ...CONTACT, 'done', '1', 'Berlin', 'Germany', '2027-03-01', '2027-03-02', '1']);
    const t = FC.describeTurn(turn);
    assert.strictEqual(t.noteStyle, 'tip');
    assert.ok(/^Tip: For a flight/m.test(FC.renderTurn(t)));
    assert.ok(!/BACK goes back/.test(FC.renderTurn(t, { hints: false })));
  });

  await test('synthetic turns: yes/no, a record pick, a summary, a bulk confirm, a code, a hidden answer', async () => {
    const base = { sessionId: 's1', status: 'in_progress', messages: [{ type: 'text', text: 'Q?' }], progress: { done: 1, total: 3 }, canGoBack: false };
    let t = FC.describeTurn(Object.assign({}, base, { await: { type: 'ask', nodeId: 'a', slot: 'ok', label: 'OK', input: { kind: 'yesno', required: false } } }));
    assert.deepStrictEqual(t.options.map(o => o.value), ['Y', 'N']);
    assert.ok(t.canSkip);
    assert.deepStrictEqual(FC.replyInput(t, '2'), { value: 'N' });
    assert.deepStrictEqual(FC.replyInput(t, 'yes'), { value: 'yes' });

    t = FC.describeTurn(Object.assign({}, base, { await: { type: 'pick', nodeId: 'f', allowNone: true, noneLabel: 'None of these',
      items: [{ token: 'tk1', title: 'APP-1', subtitle: 'Open' }, { token: 'tk2', title: 'APP-2' }] } }));
    assert.strictEqual(t.kind, 'pick');
    assert.deepStrictEqual(FC.replyInput(t, '2'), { pick: 'tk2' });
    assert.deepStrictEqual(FC.replyInput(t, 'none of these'), { pick: null });
    assert.deepStrictEqual(FC.replyInput(t, 'APP'), { value: 'APP' });
    assert.ok(/1\. APP-1 \(Open\)/.test(FC.renderTurn(t)));

    t = FC.describeTurn(Object.assign({}, base, {
      messages: [{ type: 'summary', text: 'Please check:', items: [
        { slot: 'name', label: 'Name', display: 'Ana', editable: true },
        { slot: 'calc', label: 'Total', display: '5', editable: false },
        { slot: 'city', label: 'City', display: 'Oslo', editable: true }] }],
      await: { type: 'summary', nodeId: 'sum', confirmLabel: 'Submit' } }));
    assert.deepStrictEqual(t.options.map(o => o.value), ['name', 'city']);
    assert.deepStrictEqual(FC.replyInput(t, 'edit 2'), { command: 'edit', slot: 'city' });
    assert.deepStrictEqual(FC.replyInput(t, 'confirm'), { value: 'confirm' });
    assert.ok(/- Total: 5/.test(FC.renderTurn(t)));
    assert.ok(/Reply CONFIRM, or EDIT n to change 1\. Name, 2\. City\./.test(FC.renderTurn(t)), FC.renderTurn(t));

    t = FC.describeTurn(Object.assign({}, base, { await: { type: 'confirm', nodeId: 'b', confirmLabel: 'Update 3', cancelLabel: 'Cancel' } }));
    assert.deepStrictEqual(FC.replyInput(t, 'update 3'), { command: 'confirm' });
    assert.deepStrictEqual(FC.replyInput(t, 'no'), { command: 'cancel' });

    t = FC.describeTurn(Object.assign({}, base, { await: { type: 'ask', nodeId: 'v', slot: '#code', secret: true, input: { kind: 'text' } } }));
    assert.strictEqual(t.kind, 'code');
    assert.ok(t.secret);
    assert.deepStrictEqual(FC.replyInput(t, 'RESEND'), { command: 'resend' });

    t = FC.describeTurn(Object.assign({}, base, { await: { type: 'ask', nodeId: 'p', slot: 'ssn', input: { kind: 'text' }, redact: 'full', value: null } }));
    assert.ok(t.secret);
  });

  await test('a finished flow: no question, no hints', async () => {
    const t = FC.describeTurn({ sessionId: 's', status: 'completed', messages: [{ type: 'success', text: 'Saved.' }], await: null });
    assert.strictEqual(t.kind, 'none');
    assert.strictEqual(FC.renderTurn(t), 'Saved.');
  });

  console.log(passed + ' passed');
})();
