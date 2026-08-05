import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { InteractionDestination, TurnControl } from "../runtime/index.js";
import type { AttachmentStore } from "../integrations/attachments/index.js";

export interface MessageTurnDecision {
  sent: number;
  noReply: boolean;
}

interface MessageToolDetails {
  action: "send" | "no_reply";
  reason?: string;
  effectId?: string;
  deliveryStatus?: "pending";
  afterSend?: "end_turn" | "continue";
  attachmentId?: string;
}

export function createMessageTool(options: {
  control: TurnControl;
  routeRef: string;
  destinations?: () => InteractionDestination[];
  interactionDefaultDestination?: () => InteractionDestination | undefined;
  defaultDestination?: InteractionDestination;
  decision: MessageTurnDecision;
  attachmentStore?: AttachmentStore;
  workspaceRoot: string;
}): ToolDefinition {
  return defineTool({
    name: "message",
    label: "Message",
    description: [
      "Use message to make text or one Agent Workspace attachment visible to the human through the configured Interaction Route, or to let the current interaction end naturally.",
      "Assistant output outside this tool is private and is not delivered.",
      "send creates one durable outbound Effect. Tool success means the Harness accepted it; it does not mean Delivery succeeded or the human received it.",
      "When attachment_path is present, Loom snapshots that Workspace file before accepting the Effect. Later edits cannot change the accepted attachment.",
      "Call message more than once when several separate messages are natural.",
      "send ends the Turn by default. Use after_send=continue when another message, tool action, or further work should follow in the same Turn.",
      "no_reply creates no outbound Effect and ends the Turn. It means the current interaction can naturally stop without forcing another response.",
      "A proactive Turn that simply lets an opportunity pass does not need to call no_reply.",
    ].join(" "),
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal("send"),
        Type.Literal("no_reply"),
      ], {
        description: "send creates an outbound Effect; no_reply lets the current interaction end naturally without one.",
        default: "send",
      })),
      text: Type.Optional(Type.String({
        description: "Optional text to make visible to the human. send requires non-blank text, attachment_path, or both; omit for no_reply.",
      })),
      attachment_path: Type.Optional(Type.String({
        description: "Optional existing file inside the Agent Workspace. Loom snapshots it before accepting the outbound Effect.",
      })),
      reason: Type.Optional(Type.String({
        description: "Optional private reason for no_reply. The human does not receive it.",
      })),
      after_send: Type.Optional(Type.Union([
        Type.Literal("end_turn"),
        Type.Literal("continue"),
      ], {
        description: "End after this send, or continue the same Turn for another message, tool action, or further work.",
        default: "end_turn",
      })),
      destination_ref: Type.Optional(Type.String({
        description: "Select one available Interaction Destination. Omit only when the current Turn has one default or one available Destination.",
      })),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params): Promise<AgentToolResult<MessageToolDetails>> => {
      const action = params.action ?? "send";
      if (action === "no_reply") {
        if (params.text?.trim()) throw new Error("message no_reply does not accept text");
        if (params.attachment_path?.trim()) throw new Error("message no_reply does not accept attachment_path");
        if (params.after_send === "continue") {
          throw new Error("message no_reply cannot continue the Turn");
        }
        await options.control.commitInteractionDecision?.({ outcome: "no_reply" });
        options.decision.noReply = true;
        return {
          content: [{ type: "text" as const, text: "No outbound Effect was created." }],
          details: {
            action,
            ...(params.reason?.trim() ? { reason: params.reason.trim() } : {}),
          },
          terminate: true,
        };
      }

      const text = params.text?.trim() ?? "";
      const attachmentPath = params.attachment_path?.trim() ?? "";
      if (!text && !attachmentPath) throw new Error("message send requires non-blank text or attachment_path");
      if (attachmentPath && !options.attachmentStore) {
        throw new Error("message attachment_path requires an Attachment Store");
      }
      const attachment = attachmentPath
        ? await options.attachmentStore!.snapshotWorkspaceFile({
            workspaceRoot: options.workspaceRoot,
            source: attachmentPath,
          })
        : undefined;
      const destination = selectDestination(
        options.destinations?.() ?? [],
        params.destination_ref,
        options.interactionDefaultDestination?.(),
        options.defaultDestination,
      );
      const effect = {
        kind: "message",
        payload: {
          ...(text ? { text } : {}),
          ...(attachment ? { attachments: [JSON.parse(JSON.stringify(attachment))] } : {}),
        },
        routeRef: destination?.routeRef ?? options.routeRef,
        ...(destination ? { destinationRef: destination.destinationRef } : {}),
      };
      const committed = options.control.commitInteractionDecision
        ? await options.control.commitInteractionDecision({ outcome: "send", effect })
        : { outcome: "send" as const, effect: options.control.prepareEffect(effect) };
      if (committed.outcome !== "send") throw new Error("Message send was not committed");
      const receipt = committed.effect;
      options.decision.sent += 1;
      const afterSend = params.after_send ?? "end_turn";
      return {
        content: [{
          type: "text" as const,
          text: `Outbound Effect ${receipt.effectId} was accepted for Delivery.`,
        }],
        details: {
          action,
          effectId: receipt.effectId,
          deliveryStatus: "pending",
          afterSend,
          ...(attachment ? { attachmentId: attachment.id } : {}),
        },
        terminate: afterSend === "end_turn",
      };
    },
  });
}

function selectDestination(
  destinations: InteractionDestination[],
  requested: string | undefined,
  interactionDefaultDestination: InteractionDestination | undefined,
  defaultDestination: InteractionDestination | undefined,
): InteractionDestination | undefined {
  const unique = [...new Map(destinations.map(destination => [destination.destinationRef, destination])).values()];
  if (requested?.trim()) {
    const selected = unique.find(destination => destination.destinationRef === requested.trim());
    if (!selected) throw new Error("message destination_ref is not available in the current Interaction Context");
    return selected;
  }
  if (interactionDefaultDestination) return interactionDefaultDestination;
  if (unique.length === 0) return defaultDestination;
  if (unique.length === 1) return unique[0];
  throw new Error("message send requires destination_ref when more than one Interaction Destination is available");
}
