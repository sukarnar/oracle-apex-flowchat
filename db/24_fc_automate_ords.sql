--------------------------------------------------------------------------------
-- REST endpoint for Power Automate (FC_AUTOMATE, 23_fc_automate.sql). Optional.
--   POST {schema-alias}/flowchat/automate/turn
--     header X-FlowChat-Key: <the key fc_automate.add_client returned>
--     body   {"flowId", "user", "sessionId", "reply", "context"}
--
-- The module has no ORDS privilege: every request must carry a client's API key instead (401
-- without one). The key can run its flows as any person it names in "user", so keep it in the
-- Power Automate flow's secure inputs and limit who can edit that flow.
--
-- The URL must be reachable over HTTPS from Power Automate (Microsoft's cloud).
--------------------------------------------------------------------------------
begin
  -- Run once per schema if REST isn't enabled yet:
  -- ords.enable_schema(p_enabled => true, p_url_mapping_type => 'BASE_PATH', p_url_mapping_pattern => 'myschema');

  ords.define_module(
    p_module_name    => 'flowchat_automate',
    p_base_path      => '/flowchat/automate/',
    p_items_per_page => 0,
    p_status         => 'PUBLISHED',
    p_comments       => 'FlowChat: Power Automate and Adaptive Cards in Teams');

  ords.define_template(p_module_name => 'flowchat_automate', p_pattern => 'turn');
  ords.define_handler(
    p_module_name => 'flowchat_automate',
    p_pattern     => 'turn',
    p_method      => 'POST',
    p_source_type => ords.source_type_plsql,
    p_source      => 'begin fc_automate.ords_handle(:flowchat_key, :body_text); end;');

  ords.define_parameter(
    p_module_name        => 'flowchat_automate',
    p_pattern            => 'turn',
    p_method             => 'POST',
    p_name               => 'X-FlowChat-Key',
    p_bind_variable_name => 'flowchat_key',
    p_source_type        => 'HEADER',
    p_param_type         => 'STRING',
    p_access_method      => 'IN');

  commit;
end;
/
