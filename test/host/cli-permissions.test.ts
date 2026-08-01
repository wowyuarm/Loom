import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("keeps the linked Loom CLI executable after build", async () => {
  const cli = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
  const mode = (await stat(cli)).mode;

  assert.notEqual(mode & 0o111, 0, "compiled CLI is not executable");
});
