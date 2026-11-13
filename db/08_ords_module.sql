--------------------------------------------------------------------------------
-- REST API for hosting <flow-chat> on non-APEX pages (or APEX pages using transport="rest").
--   POST {schema-alias}/flowchat/sessions               body: {"flowId": "...", "context": {...}}
--   POST {schema-alias}/flowchat/sessions/:sid/input    body: {"value": "..."} | {"command": "..."}
--
-- Optional step: run it only if you need the REST endpoints. Inside APEX, the Ajax Callback
-- transport (transport="apex") needs no ORDS module.
--
-- SECURITY: as written the module is public. Before exposing it, either
--   * protect it with an ORDS privilege + OAuth2 client credentials, or
--   * put it behind your own gateway that issues per-user tokens,
-- and restrict CORS with ords.set_module_origins_allowed.
--------------------------------------------------------------------------------
begin
  -- Run once per schema if REST isn't enabled yet:
  -- ords.enable_schema(p_enabled => true, p_url_mapping_type => 'BASE_PATH', p_url_mapping_pattern => 'myschema');

  ords.define_module(
    p_module_name    => 'flowchat',
    p_base_path      => '/flowchat/',
    p_items_per_page => 0,
    p_status         => 'PUBLISHED',
    p_comments       => 'FlowChat conversational form engine');

  ords.define_template(p_module_name => 'flowchat', p_pattern => 'sessions');
  ords.define_handler(
    p_module_name => 'flowchat',
    p_pattern     => 'sessions',
    p_method      => 'POST',
    p_source_type => ords.source_type_plsql,
    p_source      => 'begin fc_engine.ords_start(:body_text); end;');

  ords.define_template(p_module_name => 'flowchat', p_pattern => 'sessions/:sid/input');
  ords.define_handler(
    p_module_name => 'flowchat',
    p_pattern     => 'sessions/:sid/input',
    p_method      => 'POST',
    p_source_type => ords.source_type_plsql,
    p_source      => 'begin fc_engine.ords_input(:sid, :body_text); end;');

  -- Allow only the origins that embed the widget (adjust):
  -- ords.set_module_origins_allowed(p_module_name => 'flowchat', p_origins_allowed => 'https://www.example.com');

  commit;
end;
/
