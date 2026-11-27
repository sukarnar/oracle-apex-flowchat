// Run: node tests/batch.test.js
// Batch mode (FlowChatEngine.runBatch, the reference for FC_CLIENT.RUN): every answer given up front.
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');
const trip = require('../flows/trip_booking.json');
const update = require('../flows/update_application.json');
const demoData = require('../demo/demo-data-sources.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}

function tripEngine() {
  const saved = [], started = [];
  let seq = 0;
  const eng = FC.createEngine({
    flows: [Object.assign({}, trip, { debug: false })], appUser: 'JDOE',
    connectors: {
      trip_get_profile: () => ({ found: true, slots: { editable_trips: 0, cancellable_trips: 0,
        emergency_contacts: [{ name: 'Ana Doe', relationship: 'SPOUSE', phone: '+1 555 123 4567', email: 'ana@example.com' }] } }),
      trip_save: (p) => { saved.push(JSON.parse(JSON.stringify(p.slots))); seq++;
        return { ok: true, slots: { trip_id: 100 + seq, itinerary_no: 'FY26-' + seq, trip_status: 'SAVED' } }; },
      trip_mark_pending: () => ({ found: true, slots: { trip_status: 'PENDING_APPROVAL' } })
    },
    lovs: { trip_my_editable: () => [], trip_my_cancellable: () => [] },
    startWorkflow: (r) => { started.push(r); return { workflowId: 9001 }; }
  });
  return { eng, saved, started };
}

const BERLIN = { city: 'Berlin', country: 'Germany', departure_date: '2027-03-01', arrival_date: '2027-03-02',
                 travel_medium: 'AIR', transport_name: 'LH 401' };
const PARIS = { city: 'Paris', country: 'France', departure_date: '2027-03-03', arrival_date: '2027-03-05',
                travel_medium: 'Train', transport_name: 'Eurostar 9012' };   // a choice given by its label
const OFFICIAL = {
  travel_type: 'OFFICIAL', business_purpose: 'Customer workshop',
  destinations: [BERLIN, PARIS],
  exp_devices: 'N', exp_tech_data: 'N', exp_sanctioned: 'N', exp_foreign_officials: 'N', exp_hardware: 'N', exp_encryption: 'N',
  clr_passport: 'Y', clr_visa: 'HAVE', clr_briefing: 'Y', clr_level: 'NONE'
};

(async () => {
  console.log('batch mode');

  await test('a whole trip is booked, saved and sent for approval from one set of answers', async () => {
    const { eng, saved, started } = tripEngine();
    const r = await FC.runBatch(eng, 'trip_booking', Object.assign({}, OFFICIAL, { ask_submit: 'submit' }));
    assert.strictEqual(r.status, 'completed', r.error || r.question);
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].destinations.length, 2);
    assert.strictEqual(saved[0].destinations[1].travel_medium, 'TRAIN', 'the label became the value');
    assert.strictEqual(saved[0].emergency_contacts.length, 1, 'a list not given keeps what was loaded');
    assert.strictEqual(started[0].workflow, 'TRIP_APPROVAL');
    assert.strictEqual(r.slots.itinerary_no, 'FY26-1', 'values returned by connectors are in the result');
    assert.strictEqual(r.slots.trip_status, 'PENDING_APPROVAL');
    assert.ok(r.transcript.some((m) => m.from === 'bot' && /pending approval/.test(m.text)));
    assert.ok(r.transcript.some((m) => m.from === 'user' && m.text === 'Berlin'));
  });

  await test('a missing answer stops with needs_input, the question and its slot', async () => {
    const { eng, saved } = tripEngine();
    const a = Object.assign({}, OFFICIAL); delete a.clr_level;
    const r = await FC.runBatch(eng, 'trip_booking', a);
    assert.strictEqual(r.status, 'needs_input');
    assert.strictEqual(r.slot, 'clr_level');
    assert.ok(r.question, 'the question text is returned');
    assert.strictEqual(saved.length, 0, 'nothing was saved');
    assert.ok(r.sessionId);
  });

  await test('a refused answer stops with refused and the engine\'s message', async () => {
    const { eng } = tripEngine();
    const r = await FC.runBatch(eng, 'trip_booking', Object.assign({}, OFFICIAL, { exp_devices: 'maybe' }));
    assert.strictEqual(r.status, 'refused');
    assert.strictEqual(r.slot, 'exp_devices');
    assert.match(r.error, /yes or no/i);
  });

  await test('a bad list item is refused at its field', async () => {
    const { eng } = tripEngine();
    const r = await FC.runBatch(eng, 'trip_booking', Object.assign({}, OFFICIAL,
      { destinations: [BERLIN, Object.assign({}, PARIS, { travel_medium: 'ROCKET' })] }));
    assert.strictEqual(r.status, 'refused');
    assert.strictEqual(r.slot, 'destinations.travel_medium');
  });

  await test('a list item without a required field stops with needs_input', async () => {
    const { eng } = tripEngine();
    const p = Object.assign({}, PARIS); delete p.country;
    const r = await FC.runBatch(eng, 'trip_booking', Object.assign({}, OFFICIAL, { destinations: [p] }));
    assert.strictEqual(r.status, 'needs_input');
    assert.match(r.error, /Item 1 of "destinations" has no "country"/);
  });

  await test('a given list replaces loaded items; lists: append keeps them', async () => {
    const contacts = [{ name: 'Bo Doe', relationship: 'PARENT', phone: '+1 555 000 1111' }];
    let x = tripEngine();
    let r = await FC.runBatch(x.eng, 'trip_booking', Object.assign({}, OFFICIAL, { emergency_contacts: contacts, next_action: 'later' }));
    assert.strictEqual(r.status, 'completed', r.error || r.question);
    assert.deepStrictEqual(x.saved[0].emergency_contacts.map((c) => c.name), ['Bo Doe']);
    x = tripEngine();
    r = await FC.runBatch(x.eng, 'trip_booking', Object.assign({}, OFFICIAL, { emergency_contacts: contacts, next_action: 'later' }), { lists: 'append' });
    assert.deepStrictEqual(x.saved[0].emergency_contacts.map((c) => c.name), ['Ana Doe', 'Bo Doe']);
  });

  await test('confirm: false stops at the summary without saving', async () => {
    const { eng, saved } = tripEngine();
    const r = await FC.runBatch(eng, 'trip_booking', OFFICIAL, { confirm: false });
    assert.strictEqual(r.status, 'needs_input');
    assert.strictEqual(saved.length, 0);
  });

  await test('maxTurns stops a run that would go on too long', async () => {
    const { eng } = tripEngine();
    const r = await FC.runBatch(eng, 'trip_booking', OFFICIAL, { maxTurns: 5 });
    assert.strictEqual(r.status, 'failed');
    assert.match(r.error, /Stopped after 5 turns/);
  });

  await test('search, pick and Change fields: a record is found, picked and updated', async () => {
    const src = demoData.create(FC);
    const eng = FC.createEngine({ flows: [update], dataSources: { loan_apps: src } });
    const before = src.rows.find((r) => r.app_id === 1041);
    const r = await FC.runBatch(eng, 'update_application', {
      email: 'jane.doe@example.com', find_app: before.reference, change: { phone: '+1 555 999 0000' } });
    assert.strictEqual(r.status, 'completed', r.error || r.question);
    assert.strictEqual(src.rows.find((x) => x.app_id === 1041).phone, '+1 555 999 0000');
  });

  console.log('\n' + passed + ' passed');
})();
