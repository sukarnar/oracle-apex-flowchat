// Builds apex/region_type_plugin_com_flowchat_designer.sql: an APEX 23.2 region plugin export that
// hosts the FlowChat designer. Every file the designer needs (designer.js/.css, the engine, the
// widget and the sample flows) is embedded as a plugin file, so importing this one script is enough.
//
// Run after changing any of those files:   node tools/build-apex-plugin.js
//
// The export contains no "/*" (SQL*Plus would treat it as a comment start) and no "&" outside
// hex: file contents are written as hex, like APEX's own exports.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'apex', 'region_type_plugin_com_flowchat_designer.sql');
const VERSION = '1.0.0';
const ID = (n) => 'wwv_flow_imp.id(' + (481516234200000 + n) + ')';   // fixed ids: re-imports replace the plugin

const FILES = [
  ['widget/flowchat-engine.js', 'flowchat-engine.js', 'text/javascript'],
  ['widget/flowchat.js', 'flowchat.js', 'text/javascript'],
  ['designer/designer.js', 'designer.js', 'text/javascript'],
  ['designer/designer.css', 'designer.css', 'text/css'],
  ['flows/loan_application.json', 'loan_application.json', 'application/json'],
  ['flows/leave_agent_demo.json', 'leave_agent_demo.json', 'application/json'],
  ['flows/update_application.json', 'update_application.json', 'application/json'],
  ['flows/update_application_public.json', 'update_application_public.json', 'application/json']
];

// The plugin's PL/SQL: render draws the mount point, ajax hands every designer call to FC_DESIGNER.
const PLSQL = `
-- FlowChat Designer region plugin. Needs FC_DESIGNER (db/09_fc_designer.sql) in the parsing schema.
function render (
  p_region              in apex_plugin.t_region,
  p_plugin              in apex_plugin.t_plugin,
  p_is_printer_friendly in boolean )
  return apex_plugin.t_region_render_result
is
  l_height varchar2(200) := nvl(trim(p_region.attribute_01), 'calc(100vh - 140px)');
  l_theme  varchar2(10)  := nvl(p_region.attribute_02, 'auto');
  l_mode   varchar2(10)  := nvl(p_region.attribute_03, 'database');
  l_result apex_plugin.t_region_render_result;
begin
  if apex_application.g_debug then
    apex_plugin_util.debug_region(p_plugin => p_plugin, p_region => p_region);
  end if;
  -- a CSS length only, so the value cannot leave the style attribute
  if not regexp_like(l_height, '^[-a-zA-Z0-9.%() +*]{1,100}$') then
    l_height := 'calc(100vh - 140px)';
  end if;
  sys.htp.p('<div id="fcd-root"'
    || case when l_mode = 'database'
            then ' data-backend="apex" data-ajax-identifier="' || apex_escape.html_attribute(apex_plugin.get_ajax_identifier) || '"'
            else ' data-backend="files"' end
    || ' data-flows-base="' || apex_escape.html_attribute(p_plugin.file_prefix) || '"'
    || case when l_theme in ('light', 'dark') then ' data-theme="' || l_theme || '"' end
    || ' style="--fcd-height: ' || l_height || '"></div>');
  return l_result;
end render;

function ajax (
  p_region in apex_plugin.t_region,
  p_plugin in apex_plugin.t_plugin )
  return apex_plugin.t_region_ajax_result
is
  l_result apex_plugin.t_region_ajax_result;
begin
  if nvl(p_region.attribute_03, 'database') <> 'database' then
    sys.htp.p('{"error":"This designer region works on files only (Mode = Files)."}');
    return l_result;
  end if;
  fc_designer.ajax;
  return l_result;
end ajax;
`.trim().split('\n');

const HELP = [
  'Hosts the FlowChat flow designer. In Database mode it opens, saves and publishes flows in FC_FLOW_VERSIONS',
  "and edits the data source, lookup list and AI registries through FC_DESIGNER, using this region's own AJAX",
  'callback (no page process needed). Anyone who can open the page can publish flows: protect the page or the',
  'region with an authorization scheme. Use one designer region per page.'
];

const ATTRS = [
  { seq: 1, prompt: 'Height', type: 'TEXT', def: 'calc(100vh - 140px)', req: false,
    help: 'Height of the designer, as a CSS length: e.g. calc(100vh - 140px), 800px or 90vh.' },
  { seq: 2, prompt: 'Theme', type: 'SELECT LIST', def: 'auto', req: true,
    help: 'Colours of the designer. Automatic follows the browser (light or dark).',
    values: [['Automatic', 'auto'], ['Light', 'light'], ['Dark', 'dark']] },
  { seq: 3, prompt: 'Mode', type: 'SELECT LIST', def: 'database', req: true,
    help: 'Database: open, save and publish flows in the database (needs FC_DESIGNER). Files: work on JSON files only, like the standalone designer.',
    values: [['Database', 'database'], ['Files', 'files']] }
];

// ------------------------------------------------------------------------------------------ helpers
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const join = (lines) => 'wwv_flow_string.join(wwv_flow_t_varchar2(\n' + lines.map(q).join(',\n') + '))';

function check(text, where) {
  if (text.indexOf('/*') >= 0) throw new Error('"/*" in ' + where + ': SQL*Plus would read it as a comment.');
}

const out = [];
const add = (s) => out.push(s);

add(`prompt --application/set_environment
set define off verify off feedback off
whenever sqlerror exit sql.sqlcode rollback
--------------------------------------------------------------------------------
--
-- Oracle APEX export file: region type plug-in COM.FLOWCHAT.DESIGNER (FlowChat Designer ${VERSION})
-- Generated by tools/build-apex-plugin.js. Do not edit by hand: change the source files and rebuild.
--
-- Import: App Builder > your application > Shared Components > Plug-ins > Import.
-- Requires APEX 23.2 or later, and FC_DESIGNER (db/09_fc_designer.sql) in the parsing schema.
--
--------------------------------------------------------------------------------
begin
wwv_flow_imp.import_begin (
 p_version_yyyy_mm_dd=>'2023.10.31'
,p_release=>'23.2.0'
,p_default_workspace_id=>1000000000000000
,p_default_application_id=>100
,p_default_id_offset=>0
,p_default_owner=>'FLOWCHAT'
);
end;
/
prompt --application/shared_components/plugins/region_type/com_flowchat_designer
begin
wwv_flow_imp_shared.create_plugin(
 p_id=>${ID(1)}
,p_plugin_type=>'REGION TYPE'
,p_name=>'COM.FLOWCHAT.DESIGNER'
,p_display_name=>'FlowChat Designer'
,p_supported_component_types=>'APEX_APPLICATION_PAGE_REGIONS'
,p_css_file_urls=>'#PLUGIN_FILES#designer.css'
,p_javascript_file_urls=>${join(['#PLUGIN_FILES#flowchat-engine.js', '#PLUGIN_FILES#flowchat.js', '#PLUGIN_FILES#designer.js'])}
,p_plsql_code=>${join(PLSQL)}
,p_api_version=>2
,p_render_function=>'render'
,p_ajax_function=>'ajax'
,p_substitute_attributes=>true
,p_subscribe_plugin_settings=>true
,p_help_text=>${join(HELP)}
,p_version_identifier=>'${VERSION}'
,p_files_version=>1
);`);

ATTRS.forEach((a) => {
  add(`wwv_flow_imp_shared.create_plugin_attribute(
 p_id=>${ID(10 + a.seq)}
,p_plugin_id=>${ID(1)}
,p_attribute_scope=>'COMPONENT'
,p_attribute_sequence=>${a.seq}
,p_display_sequence=>${a.seq * 10}
,p_prompt=>${q(a.prompt)}
,p_attribute_type=>${q(a.type)}
,p_is_required=>${a.req}
,p_default_value=>${q(a.def)}
,p_is_translatable=>false${a.values ? "\n,p_lov_type=>'STATIC'" : ''}
,p_help_text=>${q(a.help)}
);`);
  (a.values || []).forEach((v, i) => {
    add(`wwv_flow_imp_shared.create_plugin_attr_value(
 p_id=>${ID(100 + a.seq * 10 + i)}
,p_plugin_attribute_id=>${ID(10 + a.seq)}
,p_display_sequence=>${(i + 1) * 10}
,p_display_value=>${q(v[0])}
,p_return_value=>${q(v[1])}
);`);
  });
});
add('end;\n/');

FILES.forEach(([src, name, mime], fi) => {
  const buf = fs.readFileSync(path.join(ROOT, src));
  const hex = buf.toString('hex').toUpperCase();
  const chunks = [];
  for (let i = 0; i < hex.length; i += 400) chunks.push(hex.slice(i, i + 400));
  const PER_BLOCK = 500;
  for (let b = 0; b < chunks.length; b += PER_BLOCK) {
    const lines = ['begin'];
    if (b === 0) lines.push('wwv_flow_imp.g_varchar2_table := wwv_flow_imp.empty_varchar2_table;');
    chunks.slice(b, b + PER_BLOCK).forEach((c, i) => lines.push(`wwv_flow_imp.g_varchar2_table(${b + i + 1}) := '${c}';`));
    lines.push('end;', '/');
    add(lines.join('\n'));
  }
  add(`prompt --application/shared_components/plugins/region_type/com_flowchat_designer/${name.replace(/[^a-z0-9]/gi, '_')}
begin
wwv_flow_imp_shared.create_plugin_file(
 p_id=>${ID(1000 + fi)}
,p_plugin_id=>${ID(1)}
,p_file_name=>${q(name)}
,p_mime_type=>${q(mime)}
,p_file_charset=>'utf-8'
,p_file_content=>wwv_flow_imp.varchar2_to_blob(wwv_flow_imp.g_varchar2_table)
);
end;
/`);
});

add(`prompt --application/end_environment
begin
wwv_flow_imp.import_end(p_auto_install_sup_obj => nvl(wwv_flow_application_install.get_auto_install_sup_obj, false));
commit;
end;
/
set verify on feedback on define on
prompt  ...done`);

const text = out.join('\n') + '\n';
check(text, 'the export');
if (/&/.test(text)) throw new Error('"&" in the export: SQL*Plus could prompt for a substitution variable.');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, text);
console.log('wrote ' + path.relative(ROOT, OUT) + ' (' + Math.round(text.length / 1024) + ' KB, ' + FILES.length + ' files)');
