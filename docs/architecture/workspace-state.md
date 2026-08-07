# Workspace State Model

Separated control-plane session and ephemeral executor state models.

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

- **D1 & Workspace Coordinator:** Store control-plane record & observed executor/process state.
- **GitHub:** Repository truth in all executor states.
- **Persistence Invariant:** Executor reap/destroy discards command-created files; `forge_edit` commits survive.
