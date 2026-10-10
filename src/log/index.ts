import type { Context } from '@deepseek-ai/cordis'
import { Logger, type Exporter } from '@deepseek-ai/cordis'

/**
 * A logger sink. cordis's `ctx.logger` collects messages into a bounded in-memory ring buffer by
 * default and nothing writes them out, so a long-lived headless deployment loses every warning and
 * error — a broken channel poll or a failed model turn leaves no trace. This registers one exporter
 * that writes each message to stderr, where the process supervisor (systemd journald) captures it:
 * `journalctl --user -u loom.service`. Retention and rotation are the supervisor's job, so nothing
 * lands inside the Instance Root.
 *
 * `levels.default: 2` keeps error, info and warn, and drops debug (per-step noise). The number is a
 * threshold cordis compares against the message's own level, numbered error=0, info=1, warn=2,
 * debug=3, and a message is dropped when its level exceeds it — so a warning only reaches the
 * journal at 2 or above. It was 1, which quietly discarded every warn this deployment ever logged:
 * three days of journal held 91 info lines and 869 errors, and not one warning.
 * `Logger.format` renders the message body with cordis's own printf substitution (so `%o`/`%s` and
 * Error stacks resolve); `colors: 0` keeps the journal free of ANSI. The plane's own log calls avoid
 * message bodies and secrets, so this does not introduce a disclosure path.
 */

export const name = 'log'

export function apply(ctx: Context): void {
  const exporter: Exporter = {
    colors: 0,
    levels: { default: 2 },
    export: (message) =>
      void process.stderr.write(
        `${new Date(message.ts).toISOString()} ${message.type} [${message.name}] ${Logger.format(exporter, message)}\n`,
      ),
  }
  ctx.logger.exporter(exporter)
}
