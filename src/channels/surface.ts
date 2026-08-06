import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { EffectReceipt, EffectRequest, InteractionDestination } from "../runtime/index.js";

export interface ExternalAttentionEvidence {
  source: string;
  revision: string;
  observedAt: string;
  evidence: Record<string, unknown>;
}

export interface InteractionChannelAttentionSource {
  capture(): Promise<ExternalAttentionEvidence | undefined>;
  markPresented(revision: string): Promise<void>;
}

export interface InteractionChannelEffectControl {
  prepareEffect(effect: EffectRequest): EffectReceipt;
}

export interface InteractionChannelTools {
  names: readonly string[];
  create(control: InteractionChannelEffectControl): ToolDefinition[];
}

/**
 * The model-facing part of an enabled Interaction Channel. Protocol, ingress,
 * delivery and recovery stay behind the channel adapter; Main Agent only sees
 * the stable guidance, bounded tools and explicitly configured fallback place.
 */
export interface InteractionChannelAgentSurface {
  guidance: string;
  tools: InteractionChannelTools;
  defaultDestination?: InteractionDestination;
  attentionSource?: InteractionChannelAttentionSource;
}
