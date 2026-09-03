import assert from "node:assert/strict";

import { createFauxCore } from "@earendil-works/pi-ai";
import type { FauxResponseFactory, FauxResponseStep } from "@earendil-works/pi-ai";

type FauxCore = ReturnType<typeof createFauxCore>;

/**
 * The suite scripts Pi responses through the faux provider and asserts on the
 * prompt context inside the scripted handlers. Anything a handler throws is
 * absorbed by the faux provider as a stopReason:"error" assistant message, so a
 * failing handler assertion would vanish into the Turn and the test could pass
 * vacuously through later scripted responses. createTestFauxCore wraps the
 * scripted handlers so an AssertionError also escapes to the test runner and
 * fails the test with the real assertion; other throws keep their
 * provider-error semantics for scripted provider failures.
 */
export function createTestFauxCore(options: Parameters<typeof createFauxCore>[0]): FauxCore {
  const faux = createFauxCore(options);
  const guarded = (step: FauxResponseStep): FauxResponseStep => {
    if (typeof step !== "function") return step;
    return async (...args: Parameters<FauxResponseFactory>) => {
      try {
        return await step(...args);
      } catch (error) {
        if (error instanceof assert.AssertionError) {
          process.nextTick(() => {
            throw error;
          });
        }
        throw error;
      }
    };
  };
  const originalSetResponses = faux.setResponses.bind(faux);
  const originalAppendResponses = faux.appendResponses.bind(faux);
  faux.setResponses = responses => originalSetResponses(responses.map(guarded));
  faux.appendResponses = responses => originalAppendResponses(responses.map(guarded));
  return faux;
}
