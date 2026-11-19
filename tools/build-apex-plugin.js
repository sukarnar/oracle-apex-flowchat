// Builds the APEX 23.2 region plugin exports in apex/:
//   region_type_plugin_com_flowchat_designer.sql  FlowChat Designer (designer, engine, widget, sample flows)
//   region_type_plugin_com_flowchat_chat.sql      FlowChat Chat (the <flow-chat> widget)
// Every file a plugin needs is embedded as a plugin file, so importing its one script is enough.
//
// Run after changing any of those files:   node tools/build-apex-plugin.js
//
// The exports contain no "/*" (SQL*Plus would treat it as a comment start) and no "&" (it could
// prompt for a substitution variable): file contents are written as hex, like APEX's own exports.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VERSION = '1.1.0';

// ------------------------------------------------------------------------------------------ designer
const DESIGNER = {
  out: 'apex/region_type_plugin_com_flowchat_designer.sql',
  name: 'COM.FLOWCHAT.DESIGNER', display: 'FlowChat Designer', idBase: 481516234200000,
  css: ['designer.css'], js: ['flowchat-engine.js', 'flowchat.js', 'designer.js'],
  files: [
    ['widget/flowchat-engine.js', 'flowchat-engine.js', 'text/javascript'],
    ['widget/flowchat.js', 'flowchat.js', 'text/javascript'],
    ['designer/designer.js', 'designer.js', 'text/javascript'],
    ['designer/designer.css', 'designer.css', 'text/css'],
    ['flows/loan_application.json', 'loan_application.json', 'application/json'],
    ['flows/leave_agent_demo.json', 'leave_agent_demo.json', 'application/json'],
    ['flows/update_application.json', 'update_application.json', 'application/json'],
    ['flows/update_application_public.json', 'update_application_public.json', 'application/json']
  ],
  help: [
    'Hosts the FlowChat flow designer. In Database mode it opens, saves and publishes flows in FC_FLOW_VERSIONS',
    "and edits the data source, lookup list and AI registries through FC_DESIGNER, using this region's own AJAX",
    'callback (no page process needed). Anyone who can open the page can publish flows: protect the page or the',
    'region with an authorization scheme. Use one designer region per page.'
  ],
  attrs: [
    { seq: 1, prompt: 'Height', type: 'TEXT', def: 'calc(100vh - 140px)', req: false,
      help: 'Height of the designer, as a CSS length: e.g. calc(100vh - 140px), 800px or 90vh.' },
    { seq: 2, prompt: 'Theme', type: 'SELECT LIST', def: 'auto', req: true,
      help: 'Colours of the designer. Automatic follows the browser (light or dark).',
      values: [['Automatic', 'auto'], ['Light', 'light'], ['Dark', 'dark']] },
    { seq: 3, prompt: 'Mode', type: 'SELECT LIST', def: 'database', req: true,
      help: 'Database: open, save and publish flows in the database (needs FC_DESIGNER). Files: work on JSON files only, like the standalone designer.',
      values: [['Database', 'database'], ['Files', 'files']] }
  ],
  plsql: `
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
`
};

// ------------------------------------------------------------------------------------------ chat
const CHAT = {
  out: 'apex/region_type_plugin_com_flowchat_chat.sql',
  name: 'COM.FLOWCHAT.CHAT', display: 'FlowChat Chat', idBase: 481516234300000,
  css: [], js: ['flowchat.js'],
  files: [['widget/flowchat.js', 'flowchat.js', 'text/javascript']],
  help: [
    "A FlowChat conversation that fills the page items named in the flow's bindings. The flow runs in FC_ENGINE",
    "through this region's own AJAX callback (no FC_START / FC_INPUT processes needed). The region only starts",
    'the flow set in its attributes, and only continues conversations of that flow.'
  ],
  attrs: [
    { seq: 1, prompt: 'Flow', type: 'TEXT', def: '', req: true, translatable: false,
      help: 'The flow id (FC_FLOWS), e.g. loan_application. The latest published version runs unless Version is set.' },
    { seq: 2, prompt: 'Version', type: 'INTEGER', def: '', req: false,
      help: 'Pin a published version of the flow. Leave empty for the latest published version.' },
    { seq: 3, prompt: 'Heading', type: 'TEXT', def: 'Assistant', req: false, translatable: true,
      help: 'Title in the chat header.' },
    { seq: 4, prompt: 'Subheading', type: 'TEXT', def: "I'll fill in the form with you", req: false, translatable: true,
      help: 'Smaller text under the heading.' },
    { seq: 5, prompt: 'Context', type: 'TEXT', def: '', req: false,
      help: 'Values read from the page when the conversation starts: slot:ITEM pairs separated by commas, e.g. customer_id:P10_CUSTOMER_ID,dept:P10_DEPT. The flow sees them as context.<slot>.' },
    { seq: 6, prompt: 'When Finished', type: 'SELECT LIST', def: 'none', req: true,
      help: 'Nothing: the flow saved the record itself (Submit node). Submit Page: submits the page with the request below, so page processes save the filled items. Reload Page: reloads the page.',
      values: [['Nothing', 'none'], ['Submit Page', 'submit-page'], ['Reload Page', 'reload']] },
    { seq: 7, prompt: 'Submit Request', type: 'TEXT', def: 'FC_COMPLETE', req: false,
      help: 'The request value used by When Finished = Submit Page.' },
    { seq: 8, prompt: 'Keep Conversation', type: 'SELECT LIST', def: 'none', req: true,
      help: 'Across page reloads. Browser Tab: until the tab is closed (sessionStorage). Browser: until the conversation ends or expires (localStorage).',
      values: [['No', 'none'], ['Browser Tab', 'session'], ['Browser', 'local']] },
    { seq: 9, prompt: 'Theme', type: 'SELECT LIST', def: 'auto', req: true,
      help: 'Automatic follows the browser (light or dark). The accent colour follows the Universal Theme primary colour.',
      values: [['Automatic', 'auto'], ['Light', 'light'], ['Dark', 'dark']] },
    { seq: 10, prompt: 'Start Automatically', type: 'CHECKBOX', def: 'Y', req: false,
      help: 'Off: the chat waits until JavaScript calls apex.region(staticId).element[0].querySelector(\'flow-chat\').start() (or $(\'#staticId_chat\')[0].start()).' },
    { seq: 11, prompt: 'Height', type: 'TEXT', def: '560px', req: false,
      help: 'Height of the chat, as a CSS length: e.g. 560px or calc(100vh - 200px). Floating: the height of the open panel, never taller than the window.' },
    { seq: 12, prompt: 'Display', type: 'SELECT LIST', def: 'inline', req: true,
      help: 'Inline: the chat fills the region. Floating: a chat button in a corner of the page, a slim bar with the current question when minimized, and a floating panel when open (full screen on phones). The conversation starts when the chat is first opened. Use the Blank with Attributes region template, so the region adds no frame or space. JavaScript: $("#staticId_chat")[0].open() / .minimize() / .close() / .toggle(); events fc-open, fc-minimize, fc-close.',
      values: [['Inline', 'inline'], ['Floating', 'floating']] },
    { seq: 13, prompt: 'Position', type: 'SELECT LIST', def: 'bottom-right', req: true,
      help: 'Floating: the page corner for the chat button and panel.',
      values: [['Bottom Right', 'bottom-right'], ['Bottom Left', 'bottom-left']] },
    { seq: 14, prompt: 'Start As', type: 'SELECT LIST', def: 'launcher', req: true,
      help: 'Floating: how the chat first appears. Button: only the chat button (the conversation starts when opened). Minimized: the bar with the first question. Open: the panel (on phones the button is shown instead). A conversation kept across reloads (Keep Conversation) comes back the way the user left it.',
      values: [['Button', 'launcher'], ['Minimized', 'peek'], ['Open', 'open']] },
    { seq: 15, prompt: 'Teaser', type: 'TEXT', def: '', req: false, translatable: true,
      help: 'Floating: a short message shown beside the chat button after a few seconds, e.g. Need a hand with this form? Shown once per browser tab; leave empty for none.' }
  ],
  plsql: `
-- FlowChat Chat region plugin. Needs FC_ENGINE (db/04_fc_engine.pkb) in the parsing schema.
function render (
  p_region              in apex_plugin.t_region,
  p_plugin              in apex_plugin.t_plugin,
  p_is_printer_friendly in boolean )
  return apex_plugin.t_region_render_result
is
  l_height varchar2(200) := nvl(trim(p_region.attribute_11), '560px');
  l_result apex_plugin.t_region_render_result;

  procedure attr (p_name in varchar2, p_value in varchar2) is
  begin
    if p_value is not null then
      sys.htp.prn(' ' || p_name || '="' || apex_escape.html_attribute(p_value) || '"');
    end if;
  end attr;
begin
  if apex_application.g_debug then
    apex_plugin_util.debug_region(p_plugin => p_plugin, p_region => p_region);
  end if;
  -- a CSS length only, so the value cannot leave the style attribute
  if not regexp_like(l_height, '^[-a-zA-Z0-9.%() +*]{1,100}$') then
    l_height := '560px';
  end if;
  sys.htp.prn('<flow-chat');
  attr('id', nvl(p_region.static_id, 'R' || p_region.id) || '_chat');
  attr('flow', p_region.attribute_01);
  attr('version', p_region.attribute_02);
  attr('transport', 'apex');
  attr('adapter', 'apex');
  attr('ajax-identifier', apex_plugin.get_ajax_identifier);
  attr('heading', p_region.attribute_03);
  attr('subheading', p_region.attribute_04);
  attr('context', p_region.attribute_05);
  attr('on-complete', case when p_region.attribute_06 in ('submit-page', 'reload') then p_region.attribute_06 end);
  attr('submit-request', p_region.attribute_07);
  attr('resume', case when p_region.attribute_08 in ('session', 'local') then p_region.attribute_08 end);
  attr('theme', case when p_region.attribute_09 in ('light', 'dark') then p_region.attribute_09 end);
  if p_region.attribute_10 = 'N' then sys.htp.prn(' manual-start'); end if;
  if p_region.attribute_12 = 'floating' then
    attr('display', 'floating');
    attr('position', case when p_region.attribute_13 = 'bottom-left' then 'bottom-left' else 'bottom-right' end);
    attr('start-state', case when p_region.attribute_14 in ('peek', 'open') then p_region.attribute_14 else 'launcher' end);
    attr('teaser', p_region.attribute_15);
    attr('style', '--fc-height: min(' || l_height || ', calc(100vh - 110px))');
  else
    attr('style', '--fc-height: ' || l_height);
  end if;
  sys.htp.p('></flow-chat>');
  return l_result;
end render;

-- x04 = start: starts the region's flow (the flow id and version the browser sends are ignored).
-- x04 = input: continues a conversation, only one of the region's flow.
function ajax (
  p_region in apex_plugin.t_region,
  p_plugin in apex_plugin.t_plugin )
  return apex_plugin.t_region_ajax_result
is
  l_flow   varchar2(100) := p_region.attribute_01;
  l_n      pls_integer;
  l_result apex_plugin.t_region_ajax_result;
begin
  if apex_application.g_x04 = 'start' then
    apex_application.g_x01 := l_flow;
    apex_application.g_x03 := p_region.attribute_02;
    fc_engine.apex_start;
  else
    select count(*) into l_n
      from fc_sessions
     where session_id = substr(apex_application.g_x01, 1, 32)
       and flow_id = l_flow;
    if l_n = 0 then
      fc_engine.http_out('{"error":"This conversation does not belong to this chat region. Please start again."}');
    else
      fc_engine.apex_input;
    end if;
  end if;
  return l_result;
end ajax;
`
};

// ------------------------------------------------------------------------------------------ export
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const join = (lines) => 'wwv_flow_string.join(wwv_flow_t_varchar2(\n' + lines.map(q).join(',\n') + '))';

function build(def) {
  const ID = (n) => 'wwv_flow_imp.id(' + (def.idBase + n) + ')';   // fixed ids: re-imports replace the plugin
  const key = def.name.toLowerCase().replace(/\./g, '_');
  const out = [];
  const add = (s) => out.push(s);
  const urls = (list) => (list.length ? join(list.map((f) => '#PLUGIN_FILES#' + f)) : 'null');

  add(`prompt --application/set_environment
set define off verify off feedback off
whenever sqlerror exit sql.sqlcode rollback
--------------------------------------------------------------------------------
--
-- Oracle APEX export file: region type plug-in ${def.name} (${def.display} ${VERSION})
-- Generated by tools/build-apex-plugin.js. Do not edit by hand: change the source files and rebuild.
--
-- Import: App Builder > your application > Shared Components > Plug-ins > Import.
-- Requires APEX 23.2 or later.
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
prompt --application/shared_components/plugins/region_type/${key}
begin
wwv_flow_imp_shared.create_plugin(
 p_id=>${ID(1)}
,p_plugin_type=>'REGION TYPE'
,p_name=>${q(def.name)}
,p_display_name=>${q(def.display)}
,p_supported_component_types=>'APEX_APPLICATION_PAGE_REGIONS'
,p_css_file_urls=>${urls(def.css)}
,p_javascript_file_urls=>${urls(def.js)}
,p_plsql_code=>${join(def.plsql.trim().split('\n'))}
,p_api_version=>2
,p_render_function=>'render'
,p_ajax_function=>'ajax'
,p_substitute_attributes=>true
,p_subscribe_plugin_settings=>true
,p_help_text=>${join(def.help)}
,p_version_identifier=>'${VERSION}'
,p_files_version=>1
);`);

  def.attrs.forEach((a) => {
    add(`wwv_flow_imp_shared.create_plugin_attribute(
 p_id=>${ID(10 + a.seq)}
,p_plugin_id=>${ID(1)}
,p_attribute_scope=>'COMPONENT'
,p_attribute_sequence=>${a.seq}
,p_display_sequence=>${a.seq * 10}
,p_prompt=>${q(a.prompt)}
,p_attribute_type=>${q(a.type)}
,p_is_required=>${a.req}${a.def !== '' ? '\n,p_default_value=>' + q(a.def) : ''}
,p_is_translatable=>${!!a.translatable}${a.values ? "\n,p_lov_type=>'STATIC'" : ''}
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

  def.files.forEach(([src, name, mime], fi) => {
    const hex = fs.readFileSync(path.join(ROOT, src)).toString('hex').toUpperCase();
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
    add(`prompt --application/shared_components/plugins/region_type/${key}/${name.replace(/[^a-z0-9]/gi, '_')}
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
  if (text.indexOf('/*') >= 0) throw new Error(def.out + ': "/*" would be read as a comment by SQL*Plus.');
  if (text.indexOf('&') >= 0) throw new Error(def.out + ': "&" could prompt for a substitution variable.');
  const file = path.join(ROOT, def.out);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log('wrote ' + def.out + ' (' + Math.round(text.length / 1024) + ' KB, ' + def.files.length + ' files)');
}

[DESIGNER, CHAT].forEach(build);
