# Local stdio proxy

A compatibility proxy belongs here for clients that cannot speak remote Streamable HTTP. It must read its Forge access token from the local environment, forward MCP messages unchanged, and never implement Forge policy locally. It is deliberately deferred until a real incompatible client requires it.
