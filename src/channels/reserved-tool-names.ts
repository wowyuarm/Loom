/**
 * The single authoritative set of tool names maintained by the Harness.
 * Interaction Channels must not supply any of these names. It lives here so
 * Channel surface composition never depends on a Main Agent implementation;
 * the Harness enforces the same set when it assembles agent tools.
 */
export const RESERVED_LOOM_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "expand_tool_result",
  "attachment",
  "message",
]);
