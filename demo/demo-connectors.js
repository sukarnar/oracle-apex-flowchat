/*
 * In-browser stand-ins for the PL/SQL connectors in db/04_demo_connectors.sql.
 * Same contract: receive { slots, value, slot, nodeId, context }, return a plain object.
 */
(function (global) {
  'use strict';
  var customers = [
    { customer_id: 1001, email: 'jane.doe@example.com', applicant_name: 'Jane Doe' },
    { customer_id: 1002, email: 'raj.kumar@example.com', applicant_name: 'Raj Kumar' }
  ];
  var blockedDomains = ['mailinator.com', 'tempmail.com', '10minutemail.com'];
  var nextRef = 1041;
  var fmt = function (n) { return '$' + Number(n).toLocaleString('en-US'); };
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  global.FlowChatDemoConnectors = {
    check_email: async function (p) {
      await wait(150);
      var domain = String(p.value).split('@')[1];
      if (blockedDomains.indexOf(domain) >= 0)
        return { valid: false, message: "Please use a permanent email address. Disposable inboxes aren't accepted." };
      return { valid: true };
    },

    lookup_customer: async function (p) {
      await wait(200);
      var c = customers.find(function (x) { return x.email === p.slots.email; });
      if (!c) return { found: false };
      return { found: true, slots: { customer_id: c.customer_id, applicant_name: c.applicant_name },
               message: 'Welcome back, ' + c.applicant_name.split(' ')[0] + '! I found your customer record.' };
    },

    check_affordability: async function (p) {
      await wait(150);
      var maxLoan = Number(p.value) * 5;
      if (Number(p.slots.amount) > maxLoan)
        return { valid: false, message: 'With an income of ' + fmt(p.value) + ', the most we can lend is ' + fmt(maxLoan) +
                 ' (5x income). Check the figure, or use Back to change the amount.' };
      return { valid: true };
    },

    create_application: async function (p) {
      await wait(400);
      var ref = 'LN-' + String(nextRef++).padStart(5, '0');
      return { ok: true, slots: { reference: ref } };
    }
  };
})(window);
