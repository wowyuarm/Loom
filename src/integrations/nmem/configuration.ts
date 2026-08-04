import { readFile } from "node:fs/promises";

export interface NmemConnectionConfiguration {
  endpoint: string;
  spaceId?: string;
  apiKey?: string;
}

export async function loadNmemConnectionConfiguration(options: {
  configurationFile: string;
  authFile: string;
}): Promise<NmemConnectionConfiguration> {
  const configuration = parseConfiguration(
    await readRequiredJson(options.configurationFile, "nmem configuration"),
  );
  const authDocument = await readOptionalJson(options.authFile, "nmem auth");
  const auth = authDocument === undefined ? undefined : parseAuth(authDocument);
  return {
    endpoint: configuration.endpoint,
    ...(configuration.spaceId ? { spaceId: configuration.spaceId } : {}),
    ...(auth ? { apiKey: auth.apiKey } : {}),
  };
}

function parseConfiguration(value: unknown): { endpoint: string; spaceId?: string } {
  assertObject(value, "nmem configuration");
  assertOnlyKeys(value, ["version", "endpoint", "spaceId"], "nmem configuration");
  if (value.version !== 1) throw new Error("nmem configuration requires version: 1");
  const endpoint = nonEmptyString(value.endpoint, "nmem configuration endpoint");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("nmem configuration endpoint must be a valid HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("nmem configuration endpoint must be a valid HTTP(S) URL");
  }
  const spaceId = value.spaceId === undefined
    ? undefined
    : nonEmptyString(value.spaceId, "nmem configuration spaceId");
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    ...(spaceId ? { spaceId } : {}),
  };
}

function parseAuth(value: unknown): { apiKey: string } {
  assertObject(value, "nmem auth");
  assertOnlyKeys(value, ["version", "apiKey"], "nmem auth");
  if (value.version !== 1) throw new Error("nmem auth requires version: 1");
  return { apiKey: nonEmptyString(value.apiKey, "nmem auth apiKey") };
}

async function readRequiredJson(file: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (isMissing(error)) throw new Error("Enabled nmem requires config.json");
    throw new Error(`${label} could not be read`);
  }
}

async function readOptionalJson(file: string, label: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new Error(`${label} could not be read`);
  }
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}`);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
