// Generates a SQL script that publishes a flow JSON file through fc_engine.publish_flow.
//   node tools/build-seed.js flows/loan_application.json > db/05_seed_flow.sql
const fs = require('fs');
const file = process.argv[2];
if (!file) { console.error('usage: node tools/build-seed.js <flow.json>'); process.exit(1); }

const def = JSON.parse(fs.readFileSync(file, 'utf8'));   // validates JSON
const json = JSON.stringify(def, null, 2);
if (json.includes("~'")) throw new Error("Flow text contains the q-quote terminator ~'");

// Split into <= 4000-char pieces so no single literal hits SQL*Plus / PL/SQL limits.
const chunks = json.match(/[\s\S]{1,4000}/g);
const lines = chunks.map((c) => `  dbms_lob.append(l_def, q'~${c}~');`);

process.stdout.write(`-- Generated from ${file.replace(/\\/g, '/')} by tools/build-seed.js. Do not edit by hand.
set define off
declare
  l_def     clob;
  l_version number;
begin
  dbms_lob.createtemporary(l_def, true);
${lines.join('\n')}
  l_version := fc_engine.publish_flow(l_def);
  dbms_output.put_line('Published ${def.flowId} version ' || l_version);
  commit;
end;
/
`);
