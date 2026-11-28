// Run: node tests/channel.test.js
// The "Post to Teams" node (type "teams") and the channel poster in tools/flowchat-cards.js: the
// reference for FC_CHANNEL (db/25_fc_channel.sql) and run_teams in FC_ENGINE.
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');
const C = require('../tools/flowchat-cards.js');
const helpdesk = require('../flows/it_helpdesk.json');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}
const texts = (t) => t.messages.map((m) => m.text || '').join(' | ');

// The post comes before the summary, so an Edit at the summary replays past it.
const flow = (post) => ({
  flowId: 'notify', start: 'ask_name',
  nodes: [
    { id: 'ask_name', type: 'ask', slot: 'name', label: 'Name', prompt: 'Your name?', next: 'ask_room' },
    { id: 'ask_room', type: 'ask', slot: 'room', label: 'Room', prompt: 'Room?', input: { required: false }, next: 'post' },
    Object.assign({ id: 'post', type: 'teams', channel: 'facilities', style: 'attention',
                    title: 'Request from {{name}}\r\nmore', text: 'Raised by {{app_user}}.',
                    facts: [{ title: 'Name', value: '{{name}}' }, { title: 'Room', value: '{{room}}' }],
                    link: 'https://apex.example.com/r/fac?who={{name}}', linkLabel: 'Open request',
                    message: 'I told the facilities channel.', next: 'review' }, post || {}),
    { id: 'review', type: 'summary', text: 'Check:', next: 'done' },
    { id: 'oops', type: 'end', text: 'Ended on the error path.' },
    { id: 'done', type: 'end', text: 'All done.' }
  ]
});
async function runTo(eng, name, room) {
  let t = await eng.start('notify', {});
  t = await eng.input(t.sessionId, { value: name });
  return eng.input(t.sessionId, { value: room });
}

(async () => {
  console.log('channel.test.js');

  await test('channelCard: title in a styled container, text, facts, an Open button, and no Submit buttons', async () => {
    const card = C.channelCard({ title: 'P1 ticket IT-1001', text: 'Printer on fire', style: 'attention',
                                 facts: [{ title: 'Ticket', value: 'IT-1001' }, { title: 'Empty', value: '' }],
                                 link: 'https://x.example.com/t/1001', linkLabel: 'Open the ticket' });
    assert.strictEqual(card.version, '1.4');
    assert.deepStrictEqual(card.body[0], { type: 'Container', style: 'attention', bleed: true,
      items: [{ type: 'TextBlock', text: 'P1 ticket IT-1001', wrap: true, weight: 'Bolder', size: 'Medium' }] });
    assert.strictEqual(card.body[1].text, 'Printer on fire');
    assert.deepStrictEqual(card.body[2], { type: 'FactSet', facts: [{ title: 'Ticket', value: 'IT-1001' }] });
    assert.deepStrictEqual(card.actions, [{ type: 'Action.OpenUrl', title: 'Open the ticket', url: 'https://x.example.com/t/1001' }]);
    const plain = C.channelCard({ title: 'Hi' });
    assert.strictEqual(plain.body[0].type, 'TextBlock');
    assert.deepStrictEqual(plain.actions, []);
  });

  await test('channelCard: a Markdown link in an answer is not made into a link', async () => {
    const card = C.channelCard({ title: 'x', text: 'see [here](https://evil.example)', facts: [{ title: 'a', value: '[b] (c)' }] });
    assert.strictEqual(card.body[1].text, 'see [here] (https://evil.example)');
  });

  await test('channelPayload: the body the Workflows webhook expects', async () => {
    const p = C.channelPayload({ title: 'Hi' });
    assert.strictEqual(p.type, 'message');
    assert.strictEqual(p.attachments.length, 1);
    assert.strictEqual(p.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
    assert.strictEqual(p.attachments[0].contentUrl, null);
    assert.strictEqual(p.attachments[0].content.type, 'AdaptiveCard');
  });

  await test('the node posts through options.postToTeams with templates filled in', async () => {
    const sent = [];
    const eng = FC.createEngine({ flows: [flow()], appUser: 'JSMITH', postToTeams: (m) => { sent.push(m); return { ok: true }; } });
    const t = await runTo(eng, 'Ann', '');
    assert.strictEqual(sent.length, 1);
    const m = sent[0];
    assert.strictEqual(m.channel, 'facilities');
    assert.strictEqual(m.title, 'Request from Ann more');            // one line
    assert.strictEqual(m.text, 'Raised by JSMITH.');
    assert.deepStrictEqual(m.facts, [{ title: 'Name', value: 'Ann' }]);   // the empty room is left out
    assert.strictEqual(m.link, 'https://apex.example.com/r/fac?who=Ann');
    assert.strictEqual(m.style, 'attention');
    assert.strictEqual(m.appUser, 'JSMITH');
    assert.match(texts(t), /I told the facilities channel\. \| Check:/);
  });

  await test('an Edit at the summary replays past the node without posting again', async () => {
    const sent = [];
    const eng = FC.createEngine({ flows: [flow()], postToTeams: (m) => { sent.push(m); return { ok: true }; } });
    let t = await runTo(eng, 'Ann', '12');
    t = await eng.input(t.sessionId, { command: 'edit', slot: 'room' });
    t = await eng.input(t.sessionId, { value: '14' });
    assert.match(texts(t), /Check:/);
    assert.strictEqual(sent.length, 1);
    t = await eng.input(t.sessionId, { value: 'confirm' });
    assert.strictEqual(t.status, 'completed');
    assert.strictEqual(sent.length, 1);
  });

  await test('a connector gets the message in its payload', async () => {
    const calls = [];
    const eng = FC.createEngine({ flows: [flow({ connector: 'poster' })], connectors: { poster: (p) => { calls.push(p); return { ok: true }; } } });
    await runTo(eng, 'Bo', '3');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].nodeId, 'post');
    assert.strictEqual(calls[0].channel, 'facilities');
    assert.strictEqual(calls[0].facts.length, 2);
    assert.strictEqual(calls[0].slots.name, 'Bo');
  });

  await test('failures show the error and go to onError, or carry on to next', async () => {
    let eng = FC.createEngine({ flows: [flow({ onError: 'oops', errorMessage: 'Teams is down, {{name}}.' })],
                                postToTeams: () => ({ ok: false, message: 'HTTP 500' }) });
    let t = await runTo(eng, 'Cy', '');
    assert.match(texts(t), /Teams is down, Cy\. \| Ended on the error path\./);
    eng = FC.createEngine({ flows: [flow()] });                               // no sender at all
    t = await runTo(eng, 'Cy', '');
    assert.match(texts(t), /Sorry, I couldn't post to Teams\. \| Check:/);
    const sent = [];
    eng = FC.createEngine({ flows: [flow({ link: 'javascript:alert(1)' })], postToTeams: (m) => { sent.push(m); return { ok: true }; } });
    t = await runTo(eng, 'Cy', '');
    assert.strictEqual(sent.length, 0);
    assert.match(texts(t), /couldn't post to Teams/);
    eng = FC.createEngine({ flows: [flow({ title: '', text: '' })], postToTeams: (m) => { sent.push(m); return { ok: true }; } });
    await runTo(eng, 'Cy', '');
    assert.strictEqual(sent.length, 0);
  });

  await test('createTeamsPoster: POSTs the payload to the channel URL; unknown channels and HTTP errors fail', async () => {
    const calls = [];
    const post = C.createTeamsPoster({ channels: { it_alerts: 'https://wf.example.com/hook?sig=secret' },
      fetch: async (url, init) => { calls.push({ url, init }); return { status: calls.length === 1 ? 202 : 500 }; } });
    assert.deepStrictEqual(await post({ channel: 'IT_Alerts', title: 'Hi' }), { ok: true });
    assert.strictEqual(calls[0].url, 'https://wf.example.com/hook?sig=secret');
    assert.strictEqual(calls[0].init.method, 'POST');
    assert.strictEqual(JSON.parse(calls[0].init.body).attachments[0].content.body[0].text, 'Hi');
    assert.deepStrictEqual(await post({ channel: 'it_alerts', title: 'Hi' }), { ok: false, message: 'Teams workflow returned HTTP 500' });
    assert.strictEqual((await post({ channel: 'nope', title: 'Hi' })).ok, false);
    assert.strictEqual(calls.length, 2);
  });

  await test('it_helpdesk: a P1 ticket alerts the it_alerts channel; P2 and P3 do not', async () => {
    const sent = [];
    let seq = 1000;
    const prio = (s) => (s.impact === 'SITE' && s.urgency === 'HIGH' ? 'P1' : s.impact === 'SITE' || s.urgency === 'HIGH' ? 'P2' : 'P3');
    const eng = FC.createEngine({
      flows: [Object.assign({}, helpdesk, { debug: false })], appUser: 'JDOE',
      postToTeams: C.createTeamsPoster({ channels: { it_alerts: 'https://wf.example.com/x' },
                                         fetch: async (u, i) => { sent.push(JSON.parse(i.body)); return { status: 202 }; } }),
      connectors: {
        it_my_tickets: () => ({ found: true, slots: { open_tickets: 0, ticket_list: '' } }),
        it_create_ticket: (p) => ({ ok: true, slots: { ticket_no: 'IT-' + (++seq), priority: prio(p.slots) } }),
        it_close_ticket: () => ({ found: false })
      },
      lovs: { it_my_open_tickets: () => [] }
    });
    async function ticket(category, impact, urgency) {
      let t = await eng.start('it_helpdesk', {});
      t = await eng.input(t.sessionId, { value: category });
      t = await eng.input(t.sessionId, { value: 'Nothing works at all' });
      t = await eng.input(t.sessionId, { value: '' });
      if (category === 'HARDWARE' || t.slot === 'asset_tag') t = await eng.input(t.sessionId, { value: '' });
      t = await eng.input(t.sessionId, { value: impact });
      t = await eng.input(t.sessionId, { value: urgency });
      t = await eng.input(t.sessionId, { value: 'Y' });
      return eng.input(t.sessionId, { value: 'confirm' });
    }
    let t = await ticket('NETWORK', 'SITE', 'HIGH');
    assert.match(texts(t), /alerted the IT channel in Teams\. \| Logged IT-1001 with priority P1/);
    assert.strictEqual(sent.length, 1);
    const card = sent[0].attachments[0].content;
    assert.strictEqual(card.body[0].style, 'attention');
    assert.match(card.body[0].items[0].text, /^P1 ticket IT-1001: Nothing works at all$/);
    assert.ok(card.body.find((b) => b.type === 'FactSet').facts.some((f) => f.title === 'Area' && f.value === 'NETWORK'));
    t = await ticket('NETWORK', 'SITE', 'LOW');
    assert.match(texts(t), /Logged IT-1002 with priority P2/);
    assert.strictEqual(sent.length, 1);
  });

  console.log(passed + ' passed');
})();
