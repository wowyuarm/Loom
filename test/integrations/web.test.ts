import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openConfiguredWebAccess } from "../../src/integrations/web/index.js";

test("Web Access exposes only the bounded Main Agent tools", async t => {
  const root = await configuredWebRoot();
  const access = await openConfiguredWebAccess({ configurationFile: path.join(root, "config.json"), authFile: path.join(root, "auth.json") });
  assert.deepEqual(access.tools().map(tool => tool.name), ["web_search", "web_fetch"]);
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.tavily.com/search");
    assert.match(String((init?.headers as Record<string, string>).authorization), /^Bearer /);
    return new Response(JSON.stringify({ results: [{ title: "Loom", url: "https://example.com", content: "Result" }] }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = priorFetch; });
  const search = access.tools().find(tool => tool.name === "web_search");
  assert.ok(search);
  const result = await search.execute("search", { query: "loom", max_results: 1 }, undefined, undefined, undefined as never);
  const text = result.content.find(item => item.type === "text")?.text ?? "";
  assert.match(text, /Untrusted web search evidence/);
  assert.match(text, /https:\/\/example\.com/);
});

test("Web Access rejects incomplete and unknown configuration", async () => {
  const root = await configuredWebRoot();
  const config = path.join(root, "config.json");
  await writeFile(config, JSON.stringify({ version: 1, search: { maxResults: 5, timeoutMs: 1 }, fetch: { provider: "direct", maxChars: 1000, timeoutMs: 1, allowDirectFallback: true }, extra: true }));
  await assert.rejects(openConfiguredWebAccess({ configurationFile: config, authFile: path.join(root, "auth.json") }), /unknown fields: extra/);
});

async function configuredWebRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "loom-web-"));
  await writeFile(path.join(root, "config.json"), JSON.stringify({ version: 1, search: { maxResults: 5, timeoutMs: 10_000 }, fetch: { provider: "auto", maxChars: 50_000, timeoutMs: 10_000, allowDirectFallback: true } }));
  await writeFile(path.join(root, "auth.json"), JSON.stringify({ tavily: "test-key" }));
  return root;
}
