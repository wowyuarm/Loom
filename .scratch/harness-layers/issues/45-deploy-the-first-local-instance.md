# 45 - Deploy the First Local Instance

Status: resolved
Type: deployment

## Goal

Run HaL as the first persistent local Loom Instance at `~/.loom`, using the
built-in Local Interaction Channel and the current repository build. This is a
real beginning, not another simulated scenario and not a continuation of the
source HaL project.

## Deployment Decisions

- During active Loom development, install the CLI as a link to this repository's
  built output. The live executable therefore changes only after a deliberate
  repository build; Loom is not presented as a released package yet.
- Initialize the default `~/.loom` Instance Root. Local is enabled; Weixin and
  nmem remain disabled for the first observation period.
- Decompose the read-only HaL definition into Stable Facts, Identity, Long-term
  Memory, Current Attention, and the two Behavior materials. Reuse the clean
  decomposition already validated by Ticket 36, but copy no simulated Runtime,
  Transcript, Daily, Episode, Thread, evaluation, or project history.
- Use built-in `deepseek/deepseek-v4-flash` for every model role. Main
  Background, Orientation, and Memory Reflector use `max`; Main Interaction,
  Life Recorder, Attention Maintainer, and Thread Maintainer use `high`; Tool
  Trace Compactor uses `off`.
- Copy the existing DeepSeek credential material without printing or recording
  its contents. Secrets remain mode `0600` under Instance Configuration.
- Do not fabricate the first human Input for startup verification. The first
  durable interaction belongs to the real relationship with the human.

## Acceptance

- `loom` resolves to the current repository build.
- `~/.loom` contains only the initialized scaffold, independent HaL materials,
  model policy, Pi credential material, and Runtime files created by opening the
  Host.
- The Host starts with Local listening and with model configuration admitted;
  nmem and Weixin perform no connection or capability exposure.
- A graceful stop leaves no live Host, stale ownership lock, or Local socket.
- The next real step is `loom run` followed by a human-authored `loom chat`.

## Result

- Installed `loom` as an npm link to this repository; the executable resolves to
  the current `dist/src/cli.js`.
- Initialized a fresh `~/.loom`, wrote the clean HaL material baseline and role
  model policy, and copied only the existing DeepSeek credential material.
- Started the real Host twice and stopped it gracefully. The public Host status
  reported `models: active`, Local `listening`, and no Weixin or nmem assembly.
- Verified the Instance Root and credential file are private, the Local socket is
  mode `0600` while running, and no socket remains after stop.
- Wrote no human Input, Transcript, Daily, Episode, Thread, or inherited Runtime
  history. The first durable interaction remains human-authored.

Validation:

- Passed `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check`
  before installation.
- Passed real `loom init` at the default root.
- Passed foreground start, Local socket and permission inspection, model revision
  admission, disabled Integration inspection, graceful stop, and reopen.
