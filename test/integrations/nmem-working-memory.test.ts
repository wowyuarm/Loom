import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createNmemWorkingMemoryReader } from "../../src/integrations/nmem/index.js";

test("returns cached Working Memory as stale evidence after restart and fetch failure", async t => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "loom-nmem-working-memory-"));
  let mode: "available" | "temporary" = "available";
  const fetch: typeof globalThis.fetch = async input => {
    const resource = new URL(String(input)).pathname;
    if (resource === "/capabilities") {
      return Response.json({ version: "0.10.31", features: { ai_agent: true } });
    }
    if (mode === "temporary") {
      return Response.json({ error: "temporarily unavailable" }, { status: 503 });
    }
    return Response.json({
      exists: true,
      content: "# Working Memory -- 2026-07-21\n\n- 继续梳理一条尚未完成的线。",
      date: "2026-07-21",
      space_id: "default",
    });
  };
  let now = new Date("2026-07-21T15:00:00.000Z");
  const options = {
    stateRoot,
    endpoint: "http://nmem.test",
    spaceId: "default",
    fetch,
    now: () => now,
  };
  const first = createNmemWorkingMemoryReader(options);
  assert.deepEqual(await first.read(), {
    status: "available",
    source: "nmem",
    exists: true,
    content: "# Working Memory -- 2026-07-21\n\n- 继续梳理一条尚未完成的线。",
    sourceDate: "2026-07-21",
    fetchedAt: "2026-07-21T15:00:00.000Z",
  });
  first.close();

  mode = "temporary";
  now = new Date("2026-07-21T15:10:00.000Z");
  const recovered = createNmemWorkingMemoryReader(options);
  t.after(() => recovered.close());
  assert.deepEqual(await recovered.read(), {
    status: "stale",
    source: "nmem",
    exists: true,
    content: "# Working Memory -- 2026-07-21\n\n- 继续梳理一条尚未完成的线。",
    sourceDate: "2026-07-21",
    fetchedAt: "2026-07-21T15:00:00.000Z",
    failedAt: "2026-07-21T15:10:00.000Z",
    reason: "temporary",
  });
});

test("does not reuse cached Working Memory for a different nmem connection", async t => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "loom-nmem-working-memory-"));
  const now = () => new Date("2026-07-21T16:00:00.000Z");
  const availableFetch: typeof globalThis.fetch = async input => {
    const resource = new URL(String(input)).pathname;
    if (resource === "/capabilities") {
      return Response.json({ version: "0.10.31", features: { ai_agent: true } });
    }
    return Response.json({
      exists: true,
      content: "# Working Memory -- 2026-07-21\n\n- 保留这一版证据。",
      date: "2026-07-21",
      space_id: "first-space",
    });
  };
  const first = createNmemWorkingMemoryReader({
    stateRoot,
    endpoint: "http://first-nmem.test",
    spaceId: "first-space",
    fetch: availableFetch,
    now,
  });
  await first.read();
  first.close();

  const incompatibleFetch: typeof globalThis.fetch = async input => {
    const resource = new URL(String(input)).pathname;
    if (resource === "/capabilities") {
      return Response.json({ version: "0.10.31", features: { ai_agent: true } });
    }
    return Response.json({ exists: "yes", content: ["invalid"] });
  };
  const changed = createNmemWorkingMemoryReader({
    stateRoot,
    endpoint: "http://second-nmem.test",
    spaceId: "second-space",
    fetch: incompatibleFetch,
    now,
  });
  t.after(() => changed.close());

  assert.deepEqual(await changed.read(), {
    status: "unavailable",
    source: "nmem",
    failedAt: "2026-07-21T16:00:00.000Z",
    reason: "incompatible",
  });
});
