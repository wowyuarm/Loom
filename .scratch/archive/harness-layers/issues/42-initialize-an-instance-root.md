# 42 - Initialize an Instance Root

Status: resolved
Type: Instance Preparation

## Problem

Loom can run one prepared Instance Root through its foreground Host, but creating that root still requires copying the setup hidden inside tests and the HaL validation fixture. The public product path therefore begins after a manual, undocumented file-construction step.

Initialization must not solve this by inventing an Agent Individual. Identity, relationship facts, Long-term Memory, and Current Attention belong to the deployment and later to the Individual; credentials and provider choices also remain external input.

## Confirmed Interface

- `initializeLoomInstance` and `loom init --root <path>` create the same small, repeatable Instance scaffold.
- Initialization writes only Harness-owned defaults into live Agent Workspace material: Interaction Behavior and Background Behavior.
- Individual-owned required materials are emitted as inactive templates outside the Agent Workspace, with explicit source and destination paths. Initialization never copies them into active material or claims the Instance is ready before they are supplied.
- A minimal valid `configuration/instance.yaml` establishes the configuration version and retains the existing machine-time and schedule defaults. Pi and optional Integration configuration remain absent until deliberately supplied.
- Repeating initialization preserves every existing file and reports what it created. It is safe for a partially prepared root, but it is not a migration or repair tool.
- `loom run` keeps its strict prepared-root contract. It does not auto-initialize or silently replace missing material.

## Test Seam

- Tests cross the public initialization Interface and observe its result plus the resulting Instance Root.
- CLI tests invoke the compiled `loom init` command and then use the existing `loom run` path after supplying Individual-owned material.
- Tests verify non-overwrite behavior and the absence of active Identity, Stable Facts, Long-term Memory, and Current Attention after initialization.

## Non-goals

- An interactive persona wizard, individual package, migration, import, or distribution format.
- Generating identity, relationship history, memory, attention, provider configuration, API keys, or Weixin credentials.
- Installing an OS service, choosing a deployment directory, managing multiple Instances, or adding a control plane.
- Validating model/provider connectivity or remote Integration health.

## Resolution

- `initializeLoomInstance` now owns one small scaffold Interface, and `loom init --root <path>` exposes the same behavior without duplicating setup policy in the CLI.
- A fresh root receives the two existing Harness-owned Behavior defaults, a minimal versioned Instance Configuration, a Pi configuration directory, and four inactive templates under `templates/workspace/`. Active Identity, Stable Facts, Long-term Memory, and Current Attention remain absent until the deployment supplies them.
- Initialization is repeatable and never overwrites an existing Behavior, configuration, or template file. Existing scaffold path components must remain real directories; symlinks cannot redirect writes outside the Instance Root.
- `loom run` still opens only a prepared root. The foreground CLI test now starts from the initializer, supplies only Individual-owned active material, and then crosses the existing Host start and graceful-stop path.
- README now describes the real init, Pi configuration, run, and Weixin entry points instead of claiming those completed capabilities are still absent.

Validated with `npm run typecheck`, a clean build, the full 264-test suite, and a real compiled-CLI smoke in which the first init reported seven `createdFiles` and the second reported none.

## Source References

- Loom Tickets 27, 36, and 37
- Xi source Tickets 04 and 06
- Xi OpenClaw/Hermes host, channel, and operations research
