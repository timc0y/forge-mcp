# MCP OAuth research

The MCP HTTP authorization specification uses OAuth 2.1, Protected Resource Metadata, authorization-server discovery and PKCE-capable client flows. Forge is the resource server; the authorization server may be separate.

The deployed private pilot exposes RFC 9728 resource metadata, dynamic client registration and Authorization Code with PKCE. Its single-owner approval page is intentionally not a public account system. The development bearer bypass remains restricted to non-production environments, and tokens are never passed through to workspace services.
