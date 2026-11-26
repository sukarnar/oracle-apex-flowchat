// Run: node tests/trip.test.js
// The trip_booking sample flow, end to end, with mock connectors.
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');
const flow = require('../flows/trip_booking.json');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}
const texts = (t) => t.messages.map((m) => m.text || '').join(' | ');
const quiet = Object.assign({}, flow, { debug: false });

function setup(opts) {
  opts = opts || {};
  const saved = [], started = [], cancelled = [], emails = [];
  let seq = 0;
  const eng = FC.createEngine({
    flows: [quiet], appUser: 'JDOE',
    connectors: {
      trip_cancel: (p) => {
        const c = (opts.cancellable || {})[p.slots.cancel_trip_id];
        cancelled.push(p.slots);
        if (!c) return { found: false, message: 'Trip has already started, so it can\'t be cancelled here.' };
        return { found: true, slots: Object.assign({ itinerary_no: c.itinerary_no, trip_status: 'CANCELLED' },
          c.pending ? { cancel_note: 'The approval request has been withdrawn.' } : {},
          c.pending ? { approver_email: 'maria.boss@example.com', approver_name: 'Maria Boss', trip_summary: 'Berlin, 1 Mar 2027 to 2 Mar 2027 (official)',
                        previous_status: 'Pending Approval', approval_task_note: 'The approval request has been withdrawn, so no action is needed.' } : {}) };
      },
      trip_get_profile: () => ({ found: true, slots: { editable_trips: opts.trips ? 1 : 0,
        cancellable_trips: Object.keys(opts.cancellable || {}).length, emergency_contacts: opts.contacts || [
        { name: 'Ana Doe', relationship: 'SPOUSE', phone: '+1 555 123 4567', email: 'ana@example.com' }] } }),
      trip_load: (p) => (opts.trips && opts.trips[p.slots.edit_trip_id]
        ? { found: true, slots: JSON.parse(JSON.stringify(opts.trips[p.slots.edit_trip_id])) } : { found: false }),
      trip_save: (p) => {
        if (!(p.slots.destinations || []).length) return { ok: false, message: 'Add at least one destination.' };
        saved.push(p.slots);
        if (p.slots.trip_id) return { ok: true, slots: { trip_status: 'SAVED', trip_updated_at: 'v2' } };   // update keeps its number
        seq++;
        return { ok: true, slots: { trip_id: 100 + seq, itinerary_no: 'FY26-' + seq, trip_status: 'SAVED' } };
      },
      trip_mark_pending: () => ({ found: true, slots: { trip_status: 'PENDING_APPROVAL' } })
    },
    lovs: { trip_my_editable: () => Object.keys(opts.trips || {}).map((id) => ({ value: id, label: opts.trips[id].itinerary_no + ' - trip' })),
            trip_my_cancellable: () => Object.keys(opts.cancellable || {}).concat(opts.extraCancel || [])
              .map((id) => ({ value: id, label: 'trip ' + id })) },
    startWorkflow: (r) => { started.push(r); return { workflowId: 9001 }; },
    sendEmail: (m) => { emails.push(m); return opts.mailFails ? { ok: false, message: 'SMTP down' } : { ok: true }; }
  });
  return { eng, saved, started, cancelled, emails };
}

async function answer(eng, sid, list) {
  let t;
  for (const p of list) t = await eng.input(sid, typeof p === 'string' ? { value: p } : p);
  return t;
}

(async () => {
  console.log('trip booking');
  await test('official trip: contacts kept, two destinations, export review flagged, saved and sent for approval', async () => {
    const { eng, saved, started } = setup();
    let t = await eng.start('trip_booking', {});
    assert.match(texts(t), /emergency contacts/);
    assert.strictEqual(t.await.type, 'listMenu');
    assert.strictEqual(t.await.items.length, 1, 'existing contact is listed');
    t = await answer(eng, t.sessionId, [{ command: 'done' }, 'OFFICIAL', 'Customer workshop in Berlin',
      // destination 1
      'Berlin', 'Germany', '2027-03-01', '2027-03-02', 'AIR', 'Lufthansa LH 401']);
    assert.strictEqual(t.await.type, 'listMenu');
    t = await answer(eng, t.sessionId, [{ command: 'add' },
      'Paris', 'France', '2027-03-05', '2027-03-05', 'TRAIN', 'Eurostar 9012', { command: 'done' },
      // export: devices yes + list, tech data yes, others no
      'yes', 'Laptop SN-123', 'yes', 'no', 'no', 'no', 'no']);
    assert.match(texts(t), /Export Compliance will review/);
    t = await answer(eng, t.sessionId, ['yes', 'HAVE', 'yes', 'SECRET', 'no']);
    assert.match(texts(t), /notify your Facility Security Officer/);
    assert.strictEqual(t.await.type, 'summary');
    t = await eng.input(t.sessionId, { value: 'confirm' });
    assert.match(texts(t), /Trip FY26-1 is saved/);
    const s = saved[0];
    assert.strictEqual(s.travel_type, 'OFFICIAL');
    assert.strictEqual(s.destinations.length, 2);
    assert.strictEqual(s.destinations[1].travel_medium, 'TRAIN');
    assert.strictEqual(s.export_review, 'Y');
    assert.strictEqual(s.exp_device_list, 'Laptop SN-123');
    assert.strictEqual(s.emergency_contacts.length, 1);
    t = await eng.input(t.sessionId, { value: 'submit' });
    assert.strictEqual(started[0].workflow, 'TRIP_APPROVAL');
    assert.strictEqual(started[0].detailKey, '101');
    assert.match(texts(t), /FY26-1 is pending approval/);
    assert.strictEqual(t.status, 'completed');
  });

  await test('personal trip: no purpose asked, new contact added, no export review, saved for later', async () => {
    const { eng, saved, started } = setup({ contacts: [] });
    let t = await eng.start('trip_booking', {});
    // no contacts on file: the first contact is asked straight away
    t = await answer(eng, t.sessionId, ['Bo Doe', 'SIBLING', '+44 20 7946 0000', '', { command: 'done' }, 'PERSONAL']);
    assert.match(texts(t), /Destination 1: which city/);
    t = await answer(eng, t.sessionId, ['Lisbon', 'Portugal', '2027-06-10', '2027-06-10', 'AIR', 'TAP TP 1351', { command: 'done' },
      'no', 'no', 'no', 'no', 'no', 'no', 'yes', 'NOT_NEEDED', 'yes', 'NONE']);
    assert.strictEqual(t.await.type, 'summary');
    t = await eng.input(t.sessionId, { value: 'confirm' });
    t = await eng.input(t.sessionId, { value: 'later' });
    assert.match(texts(t), /is saved\. Open it from My Trips/);
    assert.strictEqual(saved[0].business_purpose, undefined);
    assert.strictEqual(saved[0].export_review, 'N');
    assert.strictEqual(saved[0].emergency_contacts[0].name, 'Bo Doe');
    assert.strictEqual(started.length, 0);
  });

  await test('Done is refused until there is at least one destination', async () => {
    const { eng } = setup();
    let t = await eng.start('trip_booking', {});
    t = await answer(eng, t.sessionId, [{ command: 'done' }, 'PERSONAL']);
    assert.match(texts(t), /Destination 1/);
    t = await answer(eng, t.sessionId, ['Rome', 'Italy', '2027-01-10', '2027-01-10', 'CAR', 'Hertz']);
    t = await eng.input(t.sessionId, { command: 'remove', index: 0 });
    t = await eng.input(t.sessionId, { command: 'done' });
    assert.match(texts(t), /at least one destination/);
  });

  const savedTrip = {
    trip_id: 101, itinerary_no: 'FY26-7', trip_status: 'SAVED', trip_updated_at: 'v1',
    travel_type: 'BOTH', business_purpose: 'Customer workshop',
    destinations: [{ city: 'Berlin', country: 'Germany', departure_date: '2027-03-01', arrival_date: '2027-03-02', travel_medium: 'AIR', transport_name: 'LH 401' }],
    exp_devices: 'Y', exp_device_list: 'Laptop', exp_tech_data: 'N', exp_sanctioned: 'N', exp_foreign_officials: 'N', exp_hardware: 'N', exp_encryption: 'N',
    clr_passport: 'Y', clr_visa: 'NOT_NEEDED', clr_briefing: 'Y', clr_level: 'SECRET', clr_fso_notified: 'Y'
  };

  console.log('change a saved trip');
  await test('a saved trip loads, skips every answered question, and goes to the summary', async () => {
    const { eng } = setup({ trips: { 101: savedTrip } });
    let t = await eng.start('trip_booking', {});
    assert.strictEqual(t.await.type, 'ask');
    assert.deepStrictEqual(t.await.input.options.map((o) => o.value), ['NEW', 'EDIT']);
    t = await eng.input(t.sessionId, { value: 'EDIT' });
    assert.match(texts(t), /Which trip/);
    t = await eng.input(t.sessionId, { value: '101' });
    assert.match(texts(t), /opened trip FY26-7/);
    assert.strictEqual(t.await.type, 'listMenu', 'contacts are always reviewed');
    t = await eng.input(t.sessionId, { command: 'done' });
    assert.strictEqual(t.await.type, 'summary');
    assert.ok(!/export-control|clearance questions/.test(texts(t)), 'no intro messages when changing a trip');
    const sum = t.messages.find((m) => m.type === 'summary');
    assert.ok(!sum.items.some((i) => i.slot === 'edit_trip_id'), 'the trip picker is not in the summary');
    assert.ok(sum.items.some((i) => i.slot === 'destinations'));
  });

  await test('editing from the summary updates the same trip (same number, version sent) and clears stale answers', async () => {
    const { eng, saved } = setup({ trips: { 101: savedTrip } });
    let t = await eng.start('trip_booking', {});
    t = await answer(eng, t.sessionId, ['EDIT', '101', { command: 'done' }]);
    t = await eng.input(t.sessionId, { command: 'edit', slot: 'travel_type' });
    t = await eng.input(t.sessionId, { value: 'PERSONAL' });
    assert.strictEqual(t.await.type, 'summary');
    let sum = t.messages.find((m) => m.type === 'summary');
    assert.ok(!sum.items.some((i) => i.slot === 'business_purpose'), 'purpose cleared for a personal trip');
    t = await eng.input(t.sessionId, { command: 'edit', slot: 'exp_devices' });
    t = await eng.input(t.sessionId, { value: 'no' });
    assert.strictEqual(t.await.type, 'summary');
    t = await eng.input(t.sessionId, { value: 'confirm' });
    assert.match(texts(t), /Trip FY26-7 is saved/);
    const s = saved[0];
    assert.strictEqual(s.trip_id, 101);
    assert.strictEqual(s.trip_updated_at, 'v1');
    assert.strictEqual(s.travel_type, 'PERSONAL');
    assert.strictEqual(s.business_purpose, undefined);
    assert.strictEqual(s.exp_devices, 'N');
    assert.strictEqual(s.exp_device_list, undefined);
  });

  await test('a destination of a saved trip is changed in place (Change → field → Save destination) and saved', async () => {
    const twoStops = Object.assign({}, savedTrip, { destinations: savedTrip.destinations.concat([
      { city: 'Paris', country: 'France', departure_date: '2027-03-03', arrival_date: '2027-03-05', travel_medium: 'TRAIN', transport_name: 'Eurostar 9012' }]) });
    const { eng, saved } = setup({ trips: { 101: twoStops } });
    let t = await eng.start('trip_booking', {});
    t = await answer(eng, t.sessionId, ['EDIT', '101', { command: 'done' }]);
    assert.strictEqual(t.await.type, 'summary');
    t = await eng.input(t.sessionId, { command: 'edit', slot: 'destinations' });
    assert.strictEqual(t.await.type, 'listMenu');
    assert.strictEqual(t.await.canEdit, true);
    assert.strictEqual(t.await.editLabel, 'Change');
    t = await eng.input(t.sessionId, { command: 'editItem', index: 1 });
    assert.match(texts(t), /Changing Paris, France .* then Save destination\./);
    assert.strictEqual(t.await.type, 'fieldMenu');
    assert.strictEqual(t.await.doneLabel, 'Save destination');
    t = await eng.input(t.sessionId, { field: 'transport_name' });
    assert.match(texts(t), /The transport to Paris is Eurostar 9012\. What should it be\?/);
    assert.strictEqual(t.await.value, 'Eurostar 9012');
    t = await eng.input(t.sessionId, { value: 'TGV 6201' });
    t = await eng.input(t.sessionId, { field: 'arrival_date' });
    assert.match(texts(t), /Arrival date is currently .*2027.*What should it be\?/);
    t = await eng.input(t.sessionId, { value: '2027-03-06' });
    t = await eng.input(t.sessionId, { command: 'done' });
    assert.match(texts(t), /Updated: Paris, France .*TGV 6201/);
    t = await eng.input(t.sessionId, { command: 'done' });
    assert.strictEqual(t.await.type, 'summary', 'back to the summary after the list');
    t = await eng.input(t.sessionId, { value: 'confirm' });
    assert.match(texts(t), /Trip FY26-7 is saved/);
    const d = saved[0].destinations;
    assert.strictEqual(d.length, 2, 'no destination added or lost');
    assert.strictEqual(d[0].city, 'Berlin');
    assert.strictEqual(d[1].transport_name, 'TGV 6201');
    assert.strictEqual(d[1].arrival_date, '2027-03-06');
    assert.strictEqual(d[1].departure_date, '2027-03-03');
  });

  await test('a rejected trip opens with the approver\'s reason, is fixed, saved and sent for approval again', async () => {
    const rejected = Object.assign({}, savedTrip, { trip_status: 'REJECTED', rejection_note: 'Please fly economy' });
    const { eng, saved, started } = setup({ trips: { 101: rejected } });
    let t = await eng.start('trip_booking', {});
    t = await answer(eng, t.sessionId, ['EDIT', '101']);
    assert.match(texts(t), /FY26-7\. It was rejected: Please fly economy/);
    assert.ok(!/I've opened trip FY26-7\. Check/.test(texts(t)), 'the plain intro is not shown as well');
    t = await eng.input(t.sessionId, { command: 'done' });
    assert.strictEqual(t.await.type, 'summary');
    t = await eng.input(t.sessionId, { value: 'confirm' });
    assert.match(texts(t), /Trip FY26-7 is saved/);
    assert.strictEqual(saved[0].trip_id, 101);
    t = await eng.input(t.sessionId, { value: 'submit' });
    assert.strictEqual(started[0].detailKey, '101');
    assert.match(texts(t), /FY26-7 is pending approval/);
  });

  await test('a saved (not rejected) trip shows the plain intro', async () => {
    const { eng } = setup({ trips: { 101: savedTrip } });
    let t = await eng.start('trip_booking', {});
    t = await answer(eng, t.sessionId, ['EDIT', '101']);
    assert.ok(!/rejected/.test(texts(t)));
  });

  await test('a NEW draft with missing answers asks only what is missing', async () => {
    const draft = { trip_id: 102, itinerary_no: 'FY26-8', trip_status: 'NEW', trip_updated_at: 'v1', travel_type: 'PERSONAL',
      destinations: [{ city: 'Oslo', country: 'Norway', departure_date: '2027-02-01', arrival_date: '2027-02-01', travel_medium: 'AIR', transport_name: 'SK 4402' }] };
    const { eng } = setup({ trips: { 102: draft } });
    let t = await eng.start('trip_booking', {});
    t = await answer(eng, t.sessionId, ['EDIT', '102', { command: 'done' }]);
    assert.match(texts(t), /1\/6: Will you take any company-issued devices/);
    t = await answer(eng, t.sessionId, ['no', 'no', 'no', 'no', 'no', 'no', 'yes', 'NOT_NEEDED', 'yes', 'NONE']);
    assert.strictEqual(t.await.type, 'summary');
  });

  await test('with no saved trips the menu is skipped', async () => {
    const { eng } = setup();
    const t = await eng.start('trip_booking', {});
    assert.strictEqual(t.await.type, 'listMenu');
  });

  console.log('cancel a trip');
  await test('cancel: pick, reason, confirm; a pending approval is withdrawn', async () => {
    const { eng, cancelled } = setup({ cancellable: { 105: { itinerary_no: 'FY26-9', pending: true } } });
    let t = await eng.start('trip_booking', {});
    assert.deepStrictEqual(t.await.input.options.map((o) => o.value), ['NEW', 'CANCEL'], 'Change is hidden with nothing to change');
    t = await answer(eng, t.sessionId, ['CANCEL', '105', 'Customer postponed the workshop']);
    assert.match(texts(t), /can't be reopened/);
    t = await eng.input(t.sessionId, { value: 'yes' });
    assert.match(texts(t), /Trip FY26-9 is cancelled\. The approval request has been withdrawn\./);
    assert.strictEqual(t.status, 'completed');
    assert.strictEqual(cancelled[0].cancel_reason, 'Customer postponed the workshop');
    assert.strictEqual(cancelled[0].cancel_trip_id, '105');
  });

  await test('cancel: the approver of a pending trip is emailed with the trip, reason and what to do', async () => {
    const { eng, emails } = setup({ cancellable: { 105: { itinerary_no: 'FY26-9', pending: true } } });
    let t = await eng.start('trip_booking', {});
    t = await answer(eng, t.sessionId, ['CANCEL', '105', 'Customer postponed the workshop', 'yes']);
    assert.strictEqual(emails.length, 1);
    const m = emails[0];
    assert.deepStrictEqual(m.to, ['maria.boss@example.com']);
    assert.strictEqual(m.subject, 'Trip FY26-9 cancelled by JDOE');
    assert.match(m.body, /Hello Maria Boss/);
    assert.match(m.body, /Berlin, 1 Mar 2027/);
    assert.match(m.body, /Reason: Customer postponed the workshop/);
    assert.match(m.body, /no action is needed/);
    assert.match(texts(t), /emailed your approver, Maria Boss/);
    assert.match(texts(t), /That's all done\./);
  });

  await test('cancel: a trip no approver has seen sends no email', async () => {
    const { eng, emails } = setup({ cancellable: { 105: { itinerary_no: 'FY26-9' } } });
    let t = await eng.start('trip_booking', {});
    t = await answer(eng, t.sessionId, ['CANCEL', '105', 'Not needed', 'yes']);
    assert.match(texts(t), /Trip FY26-9 is cancelled/);
    assert.strictEqual(emails.length, 0);
  });

  await test('cancel: if the email fails the trip is still cancelled and the user is told', async () => {
    const { eng } = setup({ cancellable: { 105: { itinerary_no: 'FY26-9', pending: true } }, mailFails: true });
    let t = await eng.start('trip_booking', {});
    t = await answer(eng, t.sessionId, ['CANCEL', '105', 'Not needed', 'yes']);
    assert.match(texts(t), /Trip FY26-9 is cancelled/);
    assert.match(texts(t), /couldn't email your approver\. Please let Maria Boss know/);
    assert.strictEqual(t.status, 'completed');
  });

  await test('cancel: answering no cancels nothing', async () => {
    const { eng, cancelled } = setup({ cancellable: { 105: { itinerary_no: 'FY26-9' } } });
    let t = await eng.start('trip_booking', {});
    t = await answer(eng, t.sessionId, ['CANCEL', '105', 'Changed my mind', 'no']);
    assert.match(texts(t), /haven't cancelled anything/);
    assert.strictEqual(cancelled.length, 0);
  });

  await test('cancel: a trip the server refuses shows its reason', async () => {
    const { eng } = setup({ cancellable: { 105: { itinerary_no: 'FY26-9' } }, extraCancel: ['106'] });
    let t = await eng.start('trip_booking', {});
    t = await answer(eng, t.sessionId, ['CANCEL', '106', 'Trip moved', 'yes']);
    assert.match(texts(t), /already started/);
    assert.match(texts(t), /was not cancelled/);
  });

  await test('both change and cancel offered when both are possible', async () => {
    const { eng } = setup({ trips: { 101: savedTrip }, cancellable: { 101: { itinerary_no: 'FY26-7' } } });
    const t = await eng.start('trip_booking', {});
    assert.deepStrictEqual(t.await.input.options.map((o) => o.value), ['NEW', 'EDIT', 'CANCEL']);
  });

  console.log('\n' + passed + ' passed');
})();
