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
 * `levels.default: 1` keeps error/warn/info and drops debug (per-step noise). `Logger.format` renders
 * the message body with cordis's own printf substitution (so `%o`/`%s` and Error stacks resolve);
 * `colors: 0` keeps the journal free of ANSI. The plane's own log calls avoid message bodies and
 * secrets, so this does not introduce a disclosure path.
 */

export const name = 'log'

export function apply(ctx: Context): void {
  const exporter: Exporter = {
    colors: 0,
    levels: { default: 1 },
    export: (message) =>
      void process.stderr.write(
        `${new Date(message.ts).toISOString()} ${message.type} [${message.name}] ${Logger.format(exporter, message)}\n`,
      ),
  }
  ctx.logger.exporter(exporter)
}
