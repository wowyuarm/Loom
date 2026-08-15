# Configuration And Credentials

This guide explains where Loom reads configuration and credentials for one
Runtime Instance. Read
[Agent-guided Instance Operations](../agent-guided-instance-operations.md) first.

## Configuration Layers

Keep assembly choices, credentials and runtime state separate:

| Material | Location | Purpose |
| --- | --- | --- |
| Instance assembly | `configuration/instance.yaml` | Time policy, model roles, schedules, enabled Channels, enabled Integrations, the default Interaction Route and optional Workspace Mirror. |
| Pi model credentials | `configuration/pi/auth.json` | API keys or OAuth credentials used by the configured model providers. |
| Pi custom model definitions | `configuration/pi/models.json` | Provider endpoints and models not supplied by Pi. |
| Channel configuration | `configuration/channels/<name>/config.json` | Non-secret route, endpoint and behavior settings owned by that Interaction Channel. |
| Channel credentials | `configuration/channels/<name>/auth.json` | Secrets owned by that Channel when Loom reads them directly. |
| Integration configuration | `configuration/integrations/<name>/config.json` | Non-secret route, endpoint and behavior settings owned by that Integration. |
| Integration credentials | `configuration/integrations/<name>/auth.json` | Secrets owned by that Integration when Loom reads them directly. |
| Runtime state | `runtime/` | Loom-owned recovery, Channel and Integration state; never edit it as configuration. |

`instance.yaml` accepts only `version`, `time`, `models`, `interaction`,
`channels`, `integrations`, `schedule`, `workspaceMirror` and `orientation`. Unknown fields are
rejected. `version` must be `1`. A Channel or Integration is assembled only when its `enabled` value is
true (all channels and integrations are off by default). At least one Interaction Channel must be enabled: a configuration with zero
enabled Channels is rejected when the Host opens. `workspaceMirror` is an
optional block (enabled/remote/branch); the mirror is only
assembled when configured (see
[Workspace Mirror Integration](../../integrations/workspace-mirror.md)).

## Time

The `time` block controls the Instance clock; every field is optional:

```yaml
time:
  timeZone: "Asia/Shanghai"   # optional; defaults to the machine time zone
  logicalDayStart: "03:00"    # optional; defaults to 03:00
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `time.timeZone` | IANA time zone name | machine time zone | Time zone used for all logical-day and schedule arithmetic. |
| `time.logicalDayStart` | `HH:MM` | `03:00` | Clock time at which the logical day starts (daily/episode files and Memory Reflector cycles follow it). |

## Schedule

The `schedule` block controls three built-in cycles; every field is optional
and falls back to its default:

```yaml
schedule:
  proactivePulse:
    intervalMinutes: 30          # default 30
    quietHours:
      start: "01:00"             # default 01:00
      end: "07:00"               # default 07:00
      intervalMinutes: 90        # default 90 (Pulse interval inside quiet hours)
  attentionMaintenance:
    intervalMinutes: 360         # default 360 (6 hours)
  memoryReflection:
    delayMinutes: 15             # default 15 (delay after logical day close)
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `schedule.proactivePulse.intervalMinutes` | positive integer | `30` | Pulse interval in minutes while idle. |
| `schedule.proactivePulse.quietHours.start` / `.end` | `HH:MM` | `01:00` / `07:00` | Quiet hours window (24-hour clock; start and end must differ). |
| `schedule.proactivePulse.quietHours.intervalMinutes` | positive integer | `90` | Pulse interval in minutes inside quiet hours. |
| `schedule.attentionMaintenance.intervalMinutes` | positive integer | `360` | Attention Maintainer interval in minutes. |
| `schedule.memoryReflection.delayMinutes` | non-negative integer | `15` | Memory Reflector delay after logical day close, in minutes. |

## Interaction

The `interaction` block controls proactive routing; optional:

```yaml
interaction:
  defaultRoute: raft          # optional; must name an enabled Channel when set
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `interaction.defaultRoute` | non-empty string | unset | Default Channel for proactive (Orientation-driven) messages; when set it must name an enabled Channel. |

## Orientation

The `orientation` block controls optional Orientation inputs, all off by
default:

```yaml
orientation:
  harnessConditions:
    enabled: false              # default false
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `orientation.harnessConditions.enabled` | boolean | `false` | When enabled, each normal Pulse shows Orientation a short summary of sustained degradation (an organ `blocked`, or a Channel with permanently failed ingress). It only adds evidence input: no new tools, wakeups or model calls. Effect and boundaries: [Cognitive Organs](../../cognitive-organs.md). |

## Models

Select providers and models in `instance.yaml` without putting a key there:

```yaml
version: 1
models:
  default:
    - provider: deepseek
      model: deepseek-chat
      thinkingLevel: medium
```

`models.default` supplies all eight model roles unless a role has its own
candidate list. The supported roles are `main-interaction`, `main-background`,
`tool-trace-compactor`, `orientation`, `life-recorder`, `attention-maintainer`,
`thread-maintainer` and `memory-reflector`.

Store built-in provider credentials in `configuration/pi/auth.json`:

```json
{
  "deepseek": { "type": "api_key", "key": "sk-..." }
}
```

Custom providers and model metadata belong in `configuration/pi/models.json`.
Prefer `auth.json` for their credentials as well. Pi also supports `$ENV_VAR`
and leading `!command` key resolution, but those forms work under systemd only
when the Instance account actually receives that environment or can run that
secret command. The supplied `loom@.service` does not load an EnvironmentFile.

## Channel Credentials

| Channel | Configuration | Credential rule |
| --- | --- | --- |
| Weixin | `configuration/channels/weixin/config.json` | Put the bot token only in `auth.json`. See [Weixin](../../channels/weixin.md). |
| Raft | `configuration/channels/raft/config.json` | The Raft CLI owns its profile credential under the Instance Unix account; never copy it into Loom configuration. See [Raft](../../channels/raft.md). |

## Integration Credentials

| Integration | Configuration | Credential rule |
| --- | --- | --- |
| Web Access | `configuration/integrations/web/config.json` | `auth.json` requires a Tavily key and may include a Jina key. See [Web Access](../../integrations/web.md). |
| nmem | `configuration/integrations/nmem/config.json` | `auth.json` is optional for a local server and contains the API key when required. See [nmem](../../integrations/nmem.md). |

Create every required Channel or Integration config and auth file before
setting `enabled: true`. A missing, partial or mismatched enabled Channel or
Integration prevents the Host from opening rather than silently running
without it.

## Secret Handling

- Keep the Instance Root and configuration directories owned by the Instance
  account with mode `0700`; keep credential files at `0600`.
- Do not put secrets in `instance.yaml`, ordinary Integration `config.json`,
  command arguments, source control, tickets, logs or completion reports.
- Prefer a user-authorized host secret mechanism when an Operator Agent's shell
  transcript would otherwise contain the literal value.
- Never print a credential to verify it. Verify ownership and mode, then use
  `loom status` for models and Integrations that own operational state.
- A complete Instance backup contains these credentials. Its destination and
  access controls must be treated accordingly.

After configuration, start the Host and run `loom status`. A running process is
not enough: the Model Runtime must not be blocked, and each stateful Integration
must report the expected operating state. Stateless capabilities such as Web
Access are verified through their real use, not a synthetic connected state.
