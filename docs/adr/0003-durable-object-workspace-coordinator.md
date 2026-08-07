# ADR 0003: Durable Object workspace coordinator

- **Status:** accepted
- **State Management:** Single coordinator Durable Object serializes workspace mutations, owns monotonic revision, idempotency records, process/preview registry, leases, and live events.
- **Protocol:** MCP sessions remain separate protocol objects.
- **Concurrency:** Read-only calls run concurrently; mutations require revision checks.
