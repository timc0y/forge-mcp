# Workspace state machine

```mermaid
stateDiagram-v2
  [*] --> requested
  requested --> provisioning
  provisioning --> bootstrapping
  bootstrapping --> ready
  ready --> busy
  busy --> ready
  ready --> suspending
  busy --> suspending
  suspending --> suspended
  suspended --> restoring
  restoring --> ready
  requested --> failed
  provisioning --> failed
  bootstrapping --> failed
  ready --> failed
  busy --> failed
  restoring --> failed
  failed --> restoring
  requested --> destroying
  provisioning --> destroying
  bootstrapping --> destroying
  ready --> destroying
  busy --> destroying
  suspended --> destroying
  failed --> destroying
  destroying --> destroyed
  destroyed --> [*]
```

The Durable Object stores the live revision and serialized mutation sequence. D1 stores the globally queryable copy. A provider responding does not by itself define the Forge lifecycle state.
