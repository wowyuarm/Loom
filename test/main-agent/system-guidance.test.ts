import assert from "node:assert/strict";
import test from "node:test";

import { HARNESS_SYSTEM_GUIDANCE } from "../../src/main-agent/system-guidance.js";

test("guides natural continuity reads without a mandatory file ladder", () => {
  assert.match(HARNESS_SYSTEM_GUIDANCE, /A Thread is a continuity that reaches beyond the present/);
  assert.match(HARNESS_SYSTEM_GUIDANCE, /A person is not a Thread, and a relationship is not a project/);
  assert.match(HARNESS_SYSTEM_GUIDANCE, /Read a known path directly/);
  assert.match(HARNESS_SYSTEM_GUIDANCE, /If you know the subject but not the path, grep for it/);
  assert.match(HARNESS_SYSTEM_GUIDANCE, /This is a clarity rule, not a style template/);
  assert.match(HARNESS_SYSTEM_GUIDANCE, /Identity and lived evidence determine the Individual's voice/);
  assert.match(HARNESS_SYSTEM_GUIDANCE, /Write prose that can be understood on one reading/);
  assert.match(HARNESS_SYSTEM_GUIDANCE, /Do not imitate English metaphors from Harness instructions/);
});
