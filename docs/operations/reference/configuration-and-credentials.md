# Configuration And Credentials

This guide explains where Loom reads configuration and credentials for one
Runtime Instance. Read
[Agent-guided Instance Operations](../agent-guided-instance-operations.md) first.

## Configuration Layers

Keep assembly choices, credentials and runtime state separate:

| Material | Location | Purpose |
| --- | --- | --- |
| Instance assembly | `configuration/instance.yaml` | Time policy, model roles, schedules, enabled Channels, enabled Integrations and the default Interaction Route. |
| Pi model credentials | `configuration/pi/auth.json` | API keys or OAuth credentials used by the configured model providers. |
| Pi custom model definitions | `configuration/pi/models.json` | Provider endpoints and models not supplied by Pi. |
| Channel configuration | `configuration/channels/<name>/config.json` | Non-secret route, endpoint and behavior settings owned by that Interaction Channel. |
| Channel credentials | `configuration/channels/<name>/auth.json` | Secrets owned by that Channel when Loom reads them directly. |
| Integration configuration | `configuration/integrations/<name>/config.json` | Non-secret route, endpoint and behavior settings owned by that Integration. |
| Integration credentials | `configuration/integrations/<name>/auth.json` | Secrets owned by that Integration when Loom reads them directly. |
| Runtime state | `runtime/` | Loom-owned recovery, Channel and Integration state; never edit it as configuration. |

`instance.yaml` accepts only `version`, `time`, `models`, `interaction`,
`channels`, `integrations` and `schedule`. Unknown fields are rejected. A
Channel or Integration is assembled only when its `enabled` value is true.
At least one Interaction Channel must be enabled: a configuration with zero
enabled Channels is rejected when the Host opens.

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
| Weixin | `configuration/channels/weixin/config.json` | Put the bot token only in `auth.json`. See [Weixin](../../integrations/weixin.md). |
| Raft | `configuration/channels/raft/config.json` | The Raft CLI owns its profile credential under the Instance Unix account; never copy it into Loom configuration. See [Raft](../../integrations/raft.md). |

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
