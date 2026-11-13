/*
 * In-memory stand-in for the "loan_apps" TABLE data source defined in db/07_data_sources.sql.
 * Works in the browser (window.FlowChatDemoData) and in Node (module.exports).
 */
(function (global) {
  'use strict';
  function rows() {
    return [
      { app_id: 1041, reference: 'LN-01041', email: 'jane.doe@example.com', purpose: 'Car', status: 'NEW',
        amount: 200000, phone: '+1 555 123 4567', start_date: '2026-12-31', contact_ok: 'Y', version: 1 },
      { app_id: 988, reference: 'LN-00988', email: 'jane.doe@example.com', purpose: 'Home improvement', status: 'APPROVED',
        amount: 15000, phone: '+1 555 123 4567', start_date: '2026-11-30', contact_ok: 'N', version: 3 },
      { app_id: 1050, reference: 'LN-01050', email: 'raj.kumar@example.com', purpose: 'Education', status: 'NEW',
        amount: 50000, phone: '+44 20 7946 0000', start_date: '2027-01-15', contact_ok: 'Y', version: 1 }
    ];
  }
  var fields = {
    reference:  { searchable: true,  updatable: false },
    email:      { searchable: true,  updatable: false },
    purpose:    { searchable: false, updatable: false },
    status:     { searchable: false, updatable: false },
    amount:     { searchable: false, updatable: true },
    phone:      { searchable: false, updatable: true, mask: 'last4' },
    start_date: { searchable: false, updatable: true },
    contact_ok: { searchable: false, updatable: true }
  };
  function create(engineApi) {
    return engineApi.createMemorySource({ rows: rows(), key: 'app_id', versionField: 'version', fields: fields });
  }
  var api = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.FlowChatDemoData = api;
})(typeof window !== 'undefined' ? window : globalThis);
