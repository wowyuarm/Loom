# nmem Integration

nmem is an optional external memory Integration. It gives the Main Agent bounded
memory recall and projects authorized Loom evidence without making nmem a
Runtime recovery source. Local Loom activity continues when nmem is unavailable.

## Files

Enable nmem in `configuration/instance.yaml`:

```yaml
version: 1
integrations:
  nmem:
    enabled: true
```

Create `configuration/integrations/nmem/config.json`:

```json
{
  "version": 1,
  "endpoint": "http://127.0.0.1:14242",
  "spaceId": "default"
}
```

`endpoint` must be an HTTP(S) URL. `spaceId` is optional. When the nmem server
requires authentication, also create
`configuration/integrations/nmem/auth.json`:

```json
{
  "version": 1,
  "apiKey": "NMEM_API_KEY"
}
```

The auth file is optional for a local server without authentication. Keep it at
mode `0600`; do not put its value in `instance.yaml`, `config.json`, source
control, tickets or logs. When nmem is disabled, Loom does not read either file
or perform nmem I/O. Configuration changes take effect after Host restart.

## Runtime Behavior

- `nmem_recall` searches bounded historical Memory evidence for the Main Agent.
- Life Recorder receipts authorize Episode projection; completed Frozen
  Activities authorize conversation Thread projection.
- Working Memory is optional evidence for Memory Reflector. A previously fetched
  value may remain explicitly marked stale while nmem is unavailable.
- Projection failures remain pending or blocked for later reconciliation and do
  not stop local Runtime work.
- `loom status` reports nmem's durable projection state because it can accumulate
  pending or failed work. It does not expose recalled or projected content.
