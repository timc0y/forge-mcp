# Workspace state model

The durable control-plane session and ephemeral executor have separate state.

```mermaid
stateDiagram-v2
  state "Control-plane session" as C {
    [*] --> active
    active --> destroying
    destroying --> destroyed
    destroyed --> [*]
  }

  state "Ephemeral executor" as E {
    [*] --> absent
    absent --> starting: first execution call
    starting --> ready
    starting --> failed
    ready --> busy
    busy --> ready
    ready --> sleeping
    sleeping --> starting: next execution call
    ready --> absent: reap/destroy
    sleeping --> absent: reap/destroy
    failed --> starting: retry
  }
```

D1 and the Workspace Coordinator store the control-plane record and observed
executor/process state. GitHub remains repository truth in every executor
state. Recreating or destroying an executor may discard command-created files;
it never discards a `forge_edit` commit.
