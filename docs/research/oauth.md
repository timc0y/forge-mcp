# MCP OAuth research

The MCP HTTP authorization specification uses OAuth 2.1, Protected Resource Metadata, authorization-server discovery and PKCE-capable client flows. Forge is the resource server; the authorization server may be separate.

Phase 1 keeps an explicit development bearer bypass only in non-production environments. Production deployment must expose RFC 9728 resource metadata, a correct `WWW-Authenticate` challenge, issuer discovery, audience/scope validation and no token passthrough to upstream services.
