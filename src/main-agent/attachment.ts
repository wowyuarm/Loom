import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import path from "node:path";

import type { AttachmentStore } from "../integrations/attachments/index.js";

interface AttachmentToolDetails {
  action: "copy_to_workspace";
  attachmentId: string;
  path: string;
}

export function createAttachmentTool(options: {
  store: AttachmentStore;
  workspaceRoot: string;
}): ToolDefinition {
  return defineTool({
    name: "attachment",
    label: "Attachment",
    description: [
      "Use attachment to deliberately copy durable content referenced in an Input into the Agent Workspace.",
      "copy_to_workspace copies the immutable bytes to the requested Workspace path; it does not parse, summarize, or alter the content.",
      "Use it when the content is worth keeping or working with as part of the Individual's own files.",
      "The destination must stay inside the Agent Workspace.",
    ].join(" "),
    parameters: Type.Object({
      action: Type.Literal("copy_to_workspace", {
        description: "Copy the referenced immutable content into the Agent Workspace.",
      }),
      attachment_id: Type.String({
        description: "Stable sha256 Attachment id shown in the Input metadata.",
      }),
      destination: Type.String({
        description: "Destination file path inside the Agent Workspace, usually relative to its root.",
      }),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params): Promise<AgentToolResult<AttachmentToolDetails>> => {
      const copied = await options.store.copyToWorkspace(params.attachment_id, {
        workspaceRoot: options.workspaceRoot,
        destination: params.destination,
      });
      const relative = path.relative(options.workspaceRoot, copied) || path.basename(copied);
      return {
        content: [{ type: "text", text: `Attachment copied to ${relative}.` }],
        details: {
          action: "copy_to_workspace",
          attachmentId: params.attachment_id,
          path: relative,
        },
      };
    },
  });
}
