import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { TurnControl } from "../runtime/index.js";

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
}

export function createMessageTool(options: {
  control: TurnControl;
  routeRef: string;
  decision: MessageTurnDecision;
}): ToolDefinition {
  return defineTool({
    name: "message",
    label: "Message",
    description: [
      "Send text through the Runtime Instance's configured Interaction Route, or explicitly end without sending.",
      "A successful send means the Harness durably accepted the outbound Effect; it does not mean Delivery succeeded.",
    ].join(" "),
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal("send"),
        Type.Literal("no_reply"),
      ], {
        description: "send creates an outbound Effect; no_reply ends without an outbound Effect.",
        default: "send",
      })),
      text: Type.Optional(Type.String({
        description: "Text to send. Required and non-blank for send; omitted for no_reply.",
      })),
      reason: Type.Optional(Type.String({
        description: "Optional private reason for no_reply. It is not delivered.",
      })),
      after_send: Type.Optional(Type.Union([
        Type.Literal("end_turn"),
        Type.Literal("continue"),
      ], {
        description: "End after this send, or continue the same Turn for more work.",
        default: "end_turn",
      })),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params): Promise<AgentToolResult<MessageToolDetails>> => {
      const action = params.action ?? "send";
      if (action === "no_reply") {
        if (params.text?.trim()) throw new Error("message no_reply does not accept text");
        if (params.after_send === "continue") {
          throw new Error("message no_reply cannot continue the Turn");
        }
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
      if (!text) throw new Error("message send requires non-blank text");
      const receipt = options.control.prepareEffect({
        kind: "message",
        payload: { text },
        routeRef: options.routeRef,
      });
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
        },
        terminate: afterSend === "end_turn",
      };
    },
  });
}
