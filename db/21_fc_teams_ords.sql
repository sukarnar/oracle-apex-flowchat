--------------------------------------------------------------------------------
-- REST endpoint for Microsoft Teams outgoing webhooks (FC_TEAMS, 20_fc_teams.sql). Optional.
--   POST {schema-alias}/flowchat/teams/:webhook      (the "Callback URL" you give Teams)
--
-- The module has no ORDS privilege on purpose: Teams can't sign in. Instead every request must carry
-- Teams' HMAC signature, checked against the webhook's security token, so only that webhook's
-- messages are answered. Unknown webhooks get 404, bad signatures 401.
--
-- The URL must be public HTTPS. Teams waits 5 seconds for the answer.
--------------------------------------------------------------------------------
begin
  -- Run once per schema if REST isn't enabled yet:
  -- ords.enable_schema(p_enabled => true, p_url_mapping_type => 'BASE_PATH', p_url_mapping_pattern => 'myschema');

  ords.define_module(
    p_module_name    => 'flowchat_teams',
    p_base_path      => '/flowchat/teams/',
    p_items_per_page => 0,
    p_status         => 'PUBLISHED',
    p_comments       => 'FlowChat: Microsoft Teams outgoing webhooks');

  ords.define_template(p_module_name => 'flowchat_teams', p_pattern => ':webhook');
  ords.define_handler(
    p_module_name => 'flowchat_teams',
    p_pattern     => ':webhook',
    p_method      => 'POST',
    p_source_type => ords.source_type_plsql,
    p_source      => 'begin fc_teams.ords_handle(:webhook, :body, :teams_auth); end;');

  -- The Authorization header (HMAC <signature>) as the bind :teams_auth.
  ords.define_parameter(
    p_module_name        => 'flowchat_teams',
    p_pattern            => ':webhook',
    p_method             => 'POST',
    p_name               => 'Authorization',
    p_bind_variable_name => 'teams_auth',
    p_source_type        => 'HEADER',
    p_param_type         => 'STRING',
    p_access_method      => 'IN');

  commit;
end;
/
