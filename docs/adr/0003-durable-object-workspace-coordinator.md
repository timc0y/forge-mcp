# ADR 0003: Durable Object workspace coordinator

**Status:** accepted

One coordinator Durable Object serializes workspace mutations, owns the monotonic revision, idempotency records, process/preview registry, leases and live events. MCP sessions remain separate protocol objects. Read-only calls may run concurrently; mutations are revision-checked.
