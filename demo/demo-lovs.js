/*
 * In-browser stand-ins for the lookup lists in db/12_lovs.sql (FC_LOVS).
 * Same contract as the engine's options.lovs: fn({lov, params, context, verified}) -> [{value, label}].
 * Works in the browser (window.FlowChatDemoLovs) and in Node (module.exports).
 */
(function (global) {
  'use strict';
  // Mirrors the rows of FC_DEMO_BRANCHES.
  var branches = [
    ['AU', 'Australia', 101, 'Sydney CBD'], ['AU', 'Australia', 102, 'Melbourne Collins St'],
    ['BR', 'Brazil', 111, 'São Paulo Paulista'],
    ['CA', 'Canada', 121, 'Toronto Bay St'], ['CA', 'Canada', 122, 'Vancouver Burrard'], ['CA', 'Canada', 123, 'Montréal Centre-Ville'],
    ['DE', 'Germany', 131, 'Berlin Mitte'], ['DE', 'Germany', 132, 'Frankfurt Zeil'],
    ['FR', 'France', 141, 'Paris Opéra'],
    ['IN', 'India', 151, 'Mumbai Fort'], ['IN', 'India', 152, 'Bengaluru MG Road'], ['IN', 'India', 153, 'Delhi Connaught Place'],
    ['IE', 'Ireland', 161, 'Dublin Grafton St'],
    ['JP', 'Japan', 171, 'Tokyo Marunouchi'],
    ['MX', 'Mexico', 181, 'Mexico City Reforma'],
    ['NZ', 'New Zealand', 191, 'Auckland Queen St'],
    ['SG', 'Singapore', 201, 'Singapore Raffles Place'],
    ['GB', 'United Kingdom', 211, 'London City'], ['GB', 'United Kingdom', 212, 'Manchester Spinningfields'],
    ['US', 'United States', 221, 'New York Midtown'], ['US', 'United States', 222, 'Chicago Loop'], ['US', 'United States', 223, 'San Francisco FiDi']
  ];
  function byLabel(a, b) { return a.label.localeCompare(b.label); }

  var lovs = {
    // select distinct country_code, country_name from fc_demo_branches order by 2
    countries: function () {
      var seen = {}, out = [];
      branches.forEach(function (b) { if (!seen[b[0]]) { seen[b[0]] = true; out.push({ value: b[0], label: b[1] }); } });
      return out.sort(byLabel);
    },
    // select branch_id, branch_name from fc_demo_branches where country_code = :COUNTRY order by 2
    branches: function (req) {
      var c = String((req.params || {}).country || '');
      return branches.filter(function (b) { return b[0] === c; })
        .map(function (b) { return { value: String(b[2]), label: b[3] }; }).sort(byLabel);
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = lovs;
  else global.FlowChatDemoLovs = lovs;
})(typeof window !== 'undefined' ? window : globalThis);
