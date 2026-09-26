#!/usr/bin/env node
// Launch Loom on the dsh runtime this repo pins and carries — never an ambient/global
// `dsh` install, whose version drifts independently and, once it no longer matches the
// exact-pinned plugin peerDependencies, gets the whole stack disabled at load.
// Forwards all args (e.g. --profile loom) and signals so it is safe as a service main process.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dshBin = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../node_modules/@deepseek-ai/dsh/lib/bin.js',
);

const child = spawn(process.execPath, [dshBin, ...process.argv.slice(2)], { stdio: 'inherit' });

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code, signal) =>
  signal ? process.kill(process.pid, signal) : process.exit(code ?? 0),
);
