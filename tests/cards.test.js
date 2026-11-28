// Run: node tests/cards.test.js
// Power Automate + Adaptive Cards (tools/flowchat-cards.js): the reference for FC_AUTOMATE in
// db/23_fc_automate.sql. A fake Power Automate loop posts each card and "clicks" its buttons.
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');
const C = require('../tools/flowchat-cards.js');
const helpdesk = require('../flows/it_helpdesk.json');
const trip = require('../flows/trip_booking.json');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}

const KEY = 'test-key-0123456789';

function setup(extra) {
  const tickets = [];
  let seq = 1000;
  const open = (u) => tickets.filter((t) => t.reporter === u && t.status === 'OPEN');
  const h = C.createAutomateHandler(Object.assign({
    engine: (appUser) => FC.createEngine({
      flows: [Object.assign({}, helpdesk, { debug: false }), Object.assign({}, trip, { debug: false })], appUser: appUser,
      connectors: {
        it_my_tickets: (p) => ({ found: true, slots: { open_tickets: open(p.appUser).length,
          ticket_list: open(p.appUser).map((t) => t.ticketNo + ' ' + t.title).join('\n') } }),
        it_create_ticket: (p) => { const no = 'IT-' + (++seq);
          tickets.push(Object.assign({ ticketNo: no, id: seq, reporter: p.appUser, status: 'OPEN' }, p.slots));
          return { ok: true, slots: { ticket_no: no, priority: 'P3' } }; },
        it_close_ticket: () => ({ found: false }),
        trip_get_profile: () => ({ found: true, slots: { editable_trips: 0, cancellable_trips: 0, emergency_contacts: [] } })
      },
      lovs: { it_my_open_tickets: (r) => open(r.appUser).map((t) => ({ value: String(t.id), label: t.ticketNo })),
              trip_my_editable: () => [], trip_my_cancellable: () => [] }
    }),
    clients: { helpdesk: { key: KEY, flows: ['it_helpdesk'], userMode: 'TABLE' } },
    users: { 'jane.doe@example.com': 'JDOE', 'bob@example.com': 'BSMITH' }
  }, extra || {}));

  // Power Automate: POST, then the person clicks a button (title) after filling inputs.
  let state = { sessionId: '', last: null };
  async function post(reply, o) {
    o = o || {};
    const r = await h.handle(o.key || KEY, JSON.stringify({ flowId: o.flowId || 'it_helpdesk', user: o.user || 'Jane.Doe@example.com',
                                                            sessionId: state.sessionId, reply: reply || null }));
    if (r.status === 200) { state.sessionId = r.body.sessionId || ''; state.last = r.body; }
    return r;
  }
  function click(title, inputs) {
    const card = state.last.card, a = card.actions.find((x) => x.title === title);
    assert.ok(a, 'no button "' + title + '" in ' + card.actions.map((x) => x.title).join(', '));
    const data = Object.assign({}, a.associatedInputs === 'none' ? {} : (inputs || {}), a.data);
    // Teams checks required inputs before it submits
    if (a.associatedInputs !== 'none') {
      card.body.filter((b) => /^Input\./.test(b.type) && b.isRequired).forEach((b) => {
        assert.ok(data[b.id] !== undefined && data[b.id] !== '', 'required input ' + b.id + ' missing');
      });
    }
    return post(data);
  }
  const bodyText = () => JSON.stringify(state.last.card.body);
  return { h, post, click, state: () => state, bodyText, tickets, reset: () => { state = { sessionId: '', last: null }; } };
}

(async () => {
  console.log('cards.test.js');

  await test('cardInput: every button maps to the engine input without state', async () => {
    assert.deepStrictEqual(C.cardInput({ action: 'answer', value: 'Y' }), { value: 'Y' });
    assert.deepStrictEqual(C.cardInput({ action: 'answer', answer: 'Paper jam' }), { value: 'Paper jam' });
    assert.deepStrictEqual(C.cardInput({ action: 'skip' }), { value: '' });
    assert.deepStrictEqual(C.cardInput({ action: 'back' }), { command: 'back' });
    assert.deepStrictEqual(C.cardInput({ action: 'editItem', item: '2' }), { command: 'editItem', index: 2 });
    assert.deepStrictEqual(C.cardInput({ action: 'remove' }), { command: 'remove', index: -1 });
    assert.deepStrictEqual(C.cardInput({ action: 'field', field: 'city' }), { field: 'city' });
    assert.deepStrictEqual(C.cardInput({ action: 'edit', editSlot: 'impact' }), { command: 'edit', slot: 'impact' });
    assert.deepStrictEqual(C.cardInput({ action: 'pick', pick: 'tk1' }), { pick: 'tk1' });
    assert.deepStrictEqual(C.cardInput({ action: 'none' }), { pick: null });
    assert.deepStrictEqual(C.cardInput(null), { command: 'resume' });
  });

  await test('refused: wrong key, a flow the key may not run, an unknown person', async () => {
    const { h, post } = setup();
    assert.strictEqual((await h.handle('nope', '{}')).status, 401);
    assert.strictEqual((await post(null, { flowId: 'trip_booking' })).status, 403);
    const r = await post(null, { user: 'stranger@example.com' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.done && /link stranger@example.com/.test(r.body.text), r.body.text);
    assert.strictEqual(r.body.card.actions.length, 0);
  });

  await test('the first card: messages, then the choice as buttons', async () => {
    const { post } = setup();
    const r = await post();
    const card = r.body.card;
    assert.strictEqual(card.type, 'AdaptiveCard');
    assert.strictEqual(card.version, '1.4');
    assert.ok(/Hi JDOE/.test(card.body[0].text), card.body[0].text);
    assert.strictEqual(r.body.done, false);
    assert.strictEqual(r.body.kind, 'choice');
    // 6 areas: more than 5, so a list and a Next button
    assert.strictEqual(card.body.find((b) => b.type === 'Input.ChoiceSet').choices.length, 6);
    assert.deepStrictEqual(card.actions.map((a) => a.title), ['Next']);
  });

  await test('a ticket logged through cards: inputs, the warning note, Skip, buttons, the summary', async () => {
    const s = setup();
    await s.post();
    let r = await s.click('Next', { answer: 'PRINTER' });
    const title = r.body.card.body.find((b) => b.type === 'Input.Text');
    assert.strictEqual(title.maxLength, 80);
    assert.ok(title.isRequired);
    r = await s.click('Next', { answer: 'Paper jams on the 3rd floor printer' });
    assert.ok(/Warning: Everyone in this channel/.test(s.bodyText()));
    assert.strictEqual(r.body.card.body.find((b) => b.type === 'Container').style, 'warning');
    const details = r.body.card.body.find((b) => b.type === 'Input.Text');
    assert.ok(details.isMultiline && !details.isRequired);
    r = await s.click('Next', { answer: '' });              // optional: left empty
    assert.deepStrictEqual(r.body.card.actions.map((a) => a.title), ['Just me', 'My team', 'Everyone in the office', 'Back']);
    r = await s.click('My team');
    r = await s.click('A little: it\'s annoying');
    r = await s.click('Yes');
    assert.strictEqual(r.body.kind, 'summary');
    const facts = r.body.card.body.find((b) => b.type === 'FactSet').facts;
    assert.ok(facts.some((f) => f.title === 'Area' && f.value === 'Printer'), JSON.stringify(facts));
    assert.deepStrictEqual(r.body.card.actions.map((a) => a.title), ['Log ticket', 'Change', 'Back']);

    r = await s.click('Change', { editSlot: 'impact' });
    assert.ok(/Who does it affect/.test(s.bodyText()));
    r = await s.click('Everyone in the office');
    assert.strictEqual(r.body.kind, 'summary');
    r = await s.click('Log ticket');
    assert.ok(r.body.done && r.body.status === 'completed');
    assert.ok(/Logged IT-1001/.test(s.bodyText()));
    assert.strictEqual(r.body.card.actions.length, 0);
    assert.strictEqual(s.tickets[0].impact, 'SITE');
    assert.strictEqual(s.tickets[0].reporter, 'JDOE');
  });

  await test('Back from a card goes to the previous question', async () => {
    const s = setup();
    await s.post();
    await s.click('Next', { answer: 'PRINTER' });
    const r = await s.click('Back');
    assert.ok(/What's the problem with/.test(s.bodyText()), s.bodyText());
    assert.strictEqual(r.body.card.body.find((b) => b.type === 'Input.ChoiceSet').value, 'PRINTER');
  });

  await test("a conversation can't be continued by someone else", async () => {
    const s = setup();
    await s.post();
    const r = await s.post({ action: 'answer', answer: 'PRINTER' }, { user: 'bob@example.com' });
    assert.strictEqual(r.status, 403);
  });

  await test('user modes: the UPN, or the part before the @, as the APEX user', async () => {
    const s = setup({ clients: { a: { key: KEY, flows: null, userMode: 'LOCAL' } } });
    let r = await s.post();
    assert.ok(/Hi JANE\.DOE/.test(r.body.card.body[0].text), r.body.card.body[0].text);
    const u = setup({ clients: { a: { key: KEY, userMode: 'UPN' } } });
    r = await u.post();
    assert.ok(/Hi JANE\.DOE@EXAMPLE\.COM/.test(r.body.card.body[0].text));
  });

  await test('a list (Repeat) as a card: items to choose, Add / Change / Remove / Done, then fields', async () => {
    const s = setup({ clients: { a: { key: KEY, userMode: 'TABLE' } } });
    let r = await s.post(null, { flowId: 'trip_booking' });
    r = await s.click('Next', { answer: 'Ana Doe' });
    r = await s.click('Next', { answer: 'SPOUSE' });            // 6 relationships: a list
    r = await s.click('Next', { answer: '+1 555 123 4567' });
    r = await s.click('Next', { answer: '' });                  // email is optional
    assert.strictEqual(r.body.kind, 'list');
    assert.deepStrictEqual(r.body.card.actions.map((a) => a.data.action), ['add', 'editItem', 'remove', 'done']);
    assert.ok(r.body.card.actions.find((a) => a.data.action === 'done').title === 'Contacts are up to date');
    const items = r.body.card.body.find((b) => b.id === 'item');
    assert.strictEqual(items.choices[0].title.indexOf('Ana Doe'), 0);
    r = await s.click(r.body.card.actions.find((a) => a.data.action === 'editItem').title, { item: '0' });
    assert.strictEqual(r.body.kind, 'fields');
    r = await s.click('Change', { field: 'phone' });
    assert.strictEqual(r.body.card.body.find((b) => b.type === 'Input.Text').value, '+1 555 123 4567');
    r = await s.click('Next', { answer: '+1 555 999 0000' });
    assert.strictEqual(r.body.kind, 'fields');
    r = await s.click(r.body.card.actions.find((a) => a.data.action === 'done').title);
    assert.strictEqual(r.body.kind, 'list');
    assert.ok(/555 999 0000|Ana Doe/.test(JSON.stringify(r.body.card)));
  });

  console.log(passed + ' passed');
})();
