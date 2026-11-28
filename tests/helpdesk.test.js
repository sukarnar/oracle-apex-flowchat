// Run: node tests/helpdesk.test.js
// The it_helpdesk sample flow (Teams sample), driven through the Teams handler as people would type
// in a channel. The connectors below behave like FC_DEMO_HELPDESK in db/22_seed_helpdesk_flow.sql.
const assert = require('assert');
const FC = require('../widget/flowchat-engine.js');
const T = require('../tools/flowchat-teams.js');
const flow = require('../flows/it_helpdesk.json');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}

const TOKEN = Buffer.from('a-test-security-token-of-32bytes').toString('base64');
const ANA = '6b1f3c1e-2a4d-4f2b-9b1a-0a1b2c3d4e5f', BOB = '9c2e4d6f-0000-4f2b-9b1a-0a1b2c3d4e5f';

// Same rules as fc_demo_helpdesk.priority_of: P1 = everyone and can't work, P2 = either, P3 = the rest.
function priorityOf(impact, urgency) {
  if (impact === 'SITE' && urgency === 'HIGH') return 'P1';
  if (impact === 'SITE' || urgency === 'HIGH') return 'P2';
  return 'P3';
}

function setup() {
  const tickets = [];
  let seq = 1040;
  const open = (u) => tickets.filter((t) => t.reporter === u && t.status === 'OPEN');
  const teams = T.createTeamsHandler({
    engine: (appUser) => FC.createEngine({
      flows: [Object.assign({}, flow, { debug: false })], appUser: appUser,
      connectors: {
        it_my_tickets: (p) => {
          const mine = open(p.appUser);
          return { found: true, slots: { open_tickets: mine.length,
            ticket_list: mine.map((t) => t.ticketNo + ' ' + t.title + ' (' + t.priority + ')').join('\n') } };
        },
        it_create_ticket: (p) => {
          const s = p.slots, no = 'IT-' + (++seq);
          tickets.push({ ticketNo: no, id: seq, reporter: p.appUser, status: 'OPEN', title: s.title, category: s.category,
                         details: s.details || null, assetTag: s.asset_tag || null, remoteOk: s.remote_ok,
                         priority: priorityOf(s.impact, s.urgency) });
          return { ok: true, slots: { ticket_no: no, priority: priorityOf(s.impact, s.urgency) } };
        },
        it_close_ticket: (p) => {
          const t = open(p.appUser).find((x) => String(x.id) === String(p.slots.close_ticket_id));
          if (!t) return { found: false };
          t.status = 'CLOSED'; t.closeNote = p.slots.close_note || null;
          return { found: true, slots: { close_ticket_no: t.ticketNo } };
        }
      },
      lovs: { it_my_open_tickets: (req) => open(req.appUser).map((t) => ({ value: String(t.id), label: t.ticketNo + ' - ' + t.title })) }
    }),
    webhooks: { helpdesk: { securityToken: TOKEN, flowId: 'it_helpdesk' } },
    users: { [ANA]: 'JDOE', [BOB]: 'BSMITH' }
  });
  let n = 0;
  async function say(text, o) {
    o = o || {};
    const body = JSON.stringify(T.activity({ aadObjectId: o.user || ANA, text: text, id: 'a' + (++n),
                                             conversationId: '19:hd@thread.skype;messageid=' + (o.thread || '1') }));
    const r = await teams.handle('helpdesk', body, T.signBody(body, TOKEN));
    assert.strictEqual(r.status, 200);
    return r.body.text.replace(/<br>/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  return { say, tickets };
}

async function logPrinterTicket(say, thread) {
  let r = await say('hi', { thread });
  r = await say('5', { thread });                          // Printer
  r = await say('Paper jams on the 3rd floor printer', { thread });
  r = await say('skip', { thread });
  r = await say('2', { thread });                          // My team
  r = await say('2', { thread });                          // Some
  r = await say('yes', { thread });
  return say('confirm', { thread });
}

(async () => {
  console.log('helpdesk.test.js');

  await test('first time: no menu, straight to the questions, with numbered choices', async () => {
    const { say } = setup();
    const r = await say('hi');
    assert.ok(/Hi JDOE, I'm the IT help desk/.test(r), r);
    assert.ok(/What's the problem with\?/.test(r), r);
    assert.ok(/5\. Printer/.test(r), r);
    assert.ok(!/You have \d+ open/.test(r), r);
  });

  await test('the details question warns about passwords; SKIP leaves it empty', async () => {
    const { say, tickets } = setup();
    await say('hi');
    await say('5');
    const r = await say('Paper jams on the 3rd floor printer');
    assert.ok(/^Warning: Everyone in this channel can read your answers/m.test(r), r);
    assert.ok(/Reply SKIP to leave it empty/.test(r), r);
    await say('skip');
    await say('1'); await say('1'); await say('no');
    await say('confirm');
    assert.strictEqual(tickets[0].details, null);
  });

  await test('a printer ticket end to end: summary, then logged with its priority', async () => {
    const { say, tickets } = setup();
    await say('hi'); await say('5'); await say('Paper jams on the 3rd floor printer'); await say('skip');
    await say('2'); await say('2');
    const sum = await say('yes');
    assert.ok(/Here's the ticket I'll log:/.test(sum), sum);
    assert.ok(/- Area: Printer/.test(sum), sum);
    assert.ok(/- Who's affected: My team/.test(sum), sum);
    assert.ok(/Reply CONFIRM, or EDIT n to change 1\. Area/.test(sum), sum);
    const r = await say('confirm');
    assert.ok(/Logged IT-1041 with priority P3/.test(r), r);
    assert.ok(/Mention me again to start over/.test(r), r);
    assert.deepStrictEqual([tickets[0].reporter, tickets[0].category, tickets[0].remoteOk], ['JDOE', 'PRINTER', 'Y']);
  });

  await test('a laptop asks for the asset tag (with a tip); a blocking problem is flagged', async () => {
    const { say, tickets } = setup();
    await say('hi'); await say('1'); await say('Laptop will not start');
    let r = await say('It beeps three times');
    assert.ok(/asset tag/.test(r) && /^Tip: It's on a sticker/m.test(r), r);
    await say('AT-20931');
    await say('1');
    r = await say('3');                                     // can't do my job
    assert.ok(/mark this as a priority/.test(r), r);
    await say('no');
    r = await say('confirm');
    assert.ok(/priority P2/.test(r), r);
    assert.strictEqual(tickets[0].assetTag, 'AT-20931');
  });

  await test('EDIT n at the summary changes an answer, then back to the summary', async () => {
    const { say, tickets } = setup();
    await say('hi'); await say('5'); await say('Paper jams on the 3rd floor printer'); await say('skip');
    await say('2'); await say('2');
    let r = await say('yes');
    const m = /(\d+)\. Who's affected/.exec(r.split('\n').pop());
    assert.ok(m, r);
    r = await say('edit ' + m[1]);
    assert.ok(/Who does it affect\?/.test(r), r);
    r = await say('3');                                     // everyone; the skipped Details question isn't asked again
    assert.ok(/Here's the ticket I'll log:/.test(r), r);
    assert.ok(/- Who's affected: Everyone in the office/.test(r), r);
    r = await say('confirm');
    assert.ok(/priority P2/.test(r), r);
    assert.strictEqual(tickets.length, 1);
  });

  await test('with open tickets: the menu, the list, and closing one', async () => {
    const { say, tickets } = setup();
    await logPrinterTicket(say, '1');
    let r = await say('hi', { thread: '2' });
    assert.ok(/You have 1 open ticket\(s\)/.test(r), r);
    r = await say('2', { thread: '2' });                     // Show my open tickets
    assert.ok(/Your open tickets:\nIT-1041 Paper jams on the 3rd floor printer \(P3\)/.test(r), r);

    r = await say('hi', { thread: '3' });
    r = await say('3', { thread: '3' });                     // Close a ticket
    assert.ok(/1\. IT-1041 - Paper jams/.test(r), r);
    await say('1', { thread: '3' });
    r = await say('The facilities team cleared it', { thread: '3' });
    assert.ok(/Ticket IT-1041 is closed/.test(r), r);
    assert.strictEqual(tickets[0].status, 'CLOSED');
    assert.strictEqual(tickets[0].closeNote, 'The facilities team cleared it');
  });

  await test("people only see and close their own tickets", async () => {
    const { say } = setup();
    await logPrinterTicket(say, '1');
    const r = await say('hi', { user: BOB, thread: '1' });
    assert.ok(/Hi BSMITH/.test(r) && !/You have \d+ open/.test(r), r);
  });

  console.log(passed + ' passed');
})();
