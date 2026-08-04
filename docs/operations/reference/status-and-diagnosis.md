# Status And Diagnosis

This guide covers live Instance status, bounded operational evidence and process
recovery. Read [Agent-guided Instance Operations](../agent-guided-instance-operations.md)
first.

## Choose Evidence For The Question

An Operator Agent works from small, independently checkable actions. It states
both the evidence obtained and the conclusion that evidence supports.

| Need | Current action | What it proves | What it does not prove |
| --- | --- | --- | --- |
| Is the Host supervised? | Inspect `loom@<instance>.service` with systemd. | The service process is active, inactive or failed. | That a model, Integration or Cognitive Organ is working. |
| What is the live Instance state? | Run `loom status`; use `--json` for structured output. | The running Host's current model, Runtime, Agent and stateful Integration state. | Why an unavailable Host stopped, what private activity contains or whether a stateless tool will succeed on its next request. |
| What happened during a period? | Run `loom status --since <ISO timestamp>` and, when needed, read the matching journal range. | Bounded Agent run history and emitted lifecycle events for that period. | A complete private history or facts that neither source records. |
| Can Local answer? | Run `loom chat` or `loom history` when Local is enabled. | The Local client reached the Host and received that result. | That another Integration is connected or Runtime has no pending work. |
| Is Raft connected? | Read the Raft entry in `loom status`, then run Raft acceptance checks when behavior must be proved. | Current bridge state and a bounded failure category. | That DM, thread, ambient and replay behavior all passed. |

Never open `runtime.db`, an Integration database or a Transcript as an operator
query interface. Never start another Host for the same Instance Root. If the
available evidence is insufficient, report `unknown` and ask whether the user
authorizes further investigation or interruption.

## Loom Status

`loom status` queries a Host-owned, read-only local socket. It does not open a
second Instance, connect an Integration or infer live state from files. The
default output is concise and human-readable; `loom status --json` returns the
same evidence with a versioned schema. `loom status --since <ISO timestamp>`
adds content-free Agent run summaries that overlap the requested period.

The snapshot distinguishes Host, Model Runtime, pending Runtime work, each
Agent's latest result, and Integrations with meaningful live or durable operating
state. It contains no message, prompt, tool trace, Workspace content, Effect
payload, credential, path, remote object id or raw provider error. A stopped or unreachable Host is
explicitly `unavailable`; use systemd and the service journal to determine why.

The Host version is the package version. When Loom runs from a Git checkout, it
also includes that checkout's short commit as build metadata, such as
`0.0.0+g0123456789ab`. A packaged build without Git metadata reports only its
package version.

`operational-events` is bounded diagnostic output, not a status fact source. A
service journal can explain emitted events in a selected time range, but it is
not a complete history and cannot replace `loom status`.

## Investigate An Incident

Preserve the smallest useful evidence first: Instance name, service state, time
window, status result and relevant content-free journal events. Do not put
credentials, message bodies, Transcripts, attachments or private Workspace
material in tickets or summaries.

When the Host is unavailable or an enabled Integration is degraded:

1. Inspect the matching systemd service without changing it.
2. Run `loom status` as the Instance account.
3. Read only the journal range needed to locate startup, model, Runtime or
   Integration failure.
4. Report the supported conclusion and what remains unknown.
5. Obtain authorization before restarting, changing configuration or inspecting
   additional private evidence.

A restart is a recovery action, not proof of the cause. `SIGTERM` is graceful:
the Host waits for active work and reconstructs durable pending Runtime work on
its next start. Do not delete a socket, database, replay state or Workspace file
to make a restart appear clean.

An Integration can fail while the Host remains active. A degraded Raft bridge,
for example, is recovered by the external supervisor restarting the Host; Loom
does not create a replacement bridge inside the existing process. Report any
interruption and verify the resulting live and Integration state afterward.
