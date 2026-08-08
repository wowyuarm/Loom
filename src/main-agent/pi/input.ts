import type { InteractionDestination, ExecutionInput } from "../../runtime/index.js";
import type { AttachmentStore } from "../../integrations/attachments/index.js";
import { presentInputWithAttachments, type InputPresentation } from "./attachments.js";

export interface InputTextOptions {
  structureHumanInput?: boolean;
  includeMessageReminder?: boolean;
  humanArrivedDuringNonInteraction?: boolean;
  channelDestinations?: InteractionDestination[];
}

export async function presentInput(
  input: ExecutionInput,
  options: InputTextOptions,
  attachmentStore: AttachmentStore | undefined,
  supportsNativeImages: boolean,
): Promise<InputPresentation> {
  return presentInputWithAttachments({
    input,
    text: inputText(input, options),
    attachmentStore,
    supportsNativeImages,
  });
}

function inputText(input: ExecutionInput, options: InputTextOptions = {}): string {
  if (input.kind === "opportunity") return opportunityInputText(input);
  if (input.kind === "continuation") return afterChatContinuationInputText(input);
  if (input.interaction) return interactionInputText(input, options);
  if (input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)) {
    const text = input.payload.text;
    if (typeof text === "string" || Array.isArray(input.payload.attachments)) {
      const visibleText = typeof text === "string" ? text : "";
      if (!options.structureHumanInput && !options.humanArrivedDuringNonInteraction) return visibleText;
      const lines = options.humanArrivedDuringNonInteraction ? [
        "A human message arrived while the non-interaction Turn was still running.",
        "Treat it as a real current interaction, not as part of the earlier proactivity opportunity or continuation.",
        "",
      ] : [];
      lines.push("<human_input>", visibleText, "</human_input>");
      if (options.includeMessageReminder) {
        lines.push(
          "",
          "To make a reply visible to the human, use message.send; ordinary assistant text is not delivered.",
          "If this interaction can naturally end without another message, use message.no_reply.",
          "This interaction must end with one of those decisions.",
        );
      }
      return lines.join("\n");
    }
  }
  return JSON.stringify(input.payload);
}

function interactionInputText(input: ExecutionInput, options: InputTextOptions): string {
  const interaction = input.interaction!;
  const payloadText = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
    && typeof input.payload.text === "string" ? input.payload.text : JSON.stringify(input.payload);
  const actorLabel = interaction.actor.label ? ` (${interaction.actor.label})` : "";
  const placeLabel = interaction.place.label ? ` (${interaction.place.label})` : "";
  const lines = options.humanArrivedDuringNonInteraction ? [
    "An Interaction arrived while the non-interaction Turn was still running.",
    "Treat it as a real current Interaction, not as part of the earlier proactivity opportunity or continuation.",
    "",
  ] : [];
  if (input.lateSteered) {
    lines.push("This message arrived after your previous user message but before the final reply was committed.", "Re-evaluate the current reply with this message included.", "");
  } else if (input.lateArriving) {
    lines.push("This message arrived after your previous reply of this conversation was committed but before its delivery was confirmed.", "At that moment the delivery was not yet confirmed, so the human may not have seen the previous reply; treat this as the continuation of the previous exchange, not as a fresh message.", "");
  }
  lines.push(
    "<interaction_context>", `Route: ${interaction.routeRef}`, `Signal: ${interaction.signal}`,
    `Actor: ${interaction.actor.kind}${actorLabel}`, `Actor ref: ${interaction.actor.actorRef}`,
    `Place: ${interaction.place.kind}${placeLabel}`, `Place ref: ${interaction.place.placeRef}`,
    `Visibility: ${interaction.place.visibility}`, `Audience: ${interaction.audience.visibility}; ${interaction.audience.description}`,
  );
  if (interaction.audience.actorRefs?.length) lines.push(`Audience actor refs: ${interaction.audience.actorRefs.join(", ")}`);
  lines.push("References:", ...(interaction.references.length > 0 ? interaction.references.map(reference => `- ${reference.kind}: ${reference.ref}`) : ["- none"]), "Available destinations:");
  lines.push(...interaction.destinations.map(destination => {
    const label = destination.label ? ` (${destination.label})` : "";
    const selected = destination.destinationRef === interaction.defaultDestinationRef ? "; default" : "";
    return `- ${destination.kind}${label}: ${destination.destinationRef}; route ${destination.routeRef}${selected}`;
  }));
  const knownRefs = new Set(interaction.destinations.map(destination => destination.destinationRef));
  const otherChannelDestinations = (options.channelDestinations ?? []).filter(destination => !knownRefs.has(destination.destinationRef));
  if (otherChannelDestinations.length > 0) {
    lines.push("", "Other Interaction Channel destinations:", "A Turn that arrived through one Channel may still answer through another when that is the right place. Choose one by its ref above only through message.send destination_ref; never guess or alter a ref.");
    lines.push(...otherChannelDestinations.map(destination => {
      const label = destination.label ? ` (${destination.label})` : "";
      return `- ${destination.kind}${label}: ${destination.destinationRef}; route ${destination.routeRef}`;
    }));
  }
  lines.push("Content:", payloadText, "</interaction_context>");
  if (options.includeMessageReminder) {
    lines.push("", "To make a reply or another message visible in an Interaction Channel, use message.send; ordinary assistant text is not delivered.", "message.send can use only an available Destination shown above. If this interaction can naturally end without another message, use message.no_reply.", "This interaction must end with one of those decisions.");
  }
  return lines.join("\n");
}

function afterChatContinuationInputText(input: ExecutionInput): string {
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) throw new Error("Continuation Input requires a structured payload");
  const observedAt = input.payload.observedAt;
  const deliveredAt = input.payload.deliveredAt;
  if (typeof observedAt !== "string" || Number.isNaN(Date.parse(observedAt))) throw new Error("Continuation Input requires observedAt");
  if (typeof deliveredAt !== "string" || Number.isNaN(Date.parse(deliveredAt))) throw new Error("Continuation Input requires deliveredAt");
  return ["<after_chat_continuation>", `Observed at: ${observedAt}`, `A message from the current activity was confirmed delivered ${elapsedTime(observedAt, deliveredAt)} ago.`, "No new human Input has been accepted since that delivery.", "</after_chat_continuation>", "", "This is not a human message or a task. The recent exchange may simply still be present.", "", "If something genuinely remains, you may look into it, continue private work, or say it through message. If nothing does, use message.no_reply and let it pass.", "", "Do not manufacture a follow-up merely because this continuation occurred."].join("\n");
}

function opportunityInputText(input: ExecutionInput): string {
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) throw new Error("Opportunity Input requires a structured payload");
  const { narrative, observedAt, localTime, lastHumanInputAt } = input.payload;
  if (typeof narrative !== "string" || !narrative.trim()) throw new Error("Opportunity Input requires a narrative");
  if (typeof observedAt !== "string" || Number.isNaN(Date.parse(observedAt))) throw new Error("Opportunity Input requires observedAt");
  const timing = typeof lastHumanInputAt === "string" && !Number.isNaN(Date.parse(lastHumanInputAt)) ? [`Time since the latest human Input: ${elapsedTime(observedAt, lastHumanInputAt)}`] : [];
  return ["<proactive_opportunity>", `Observed at: ${observedAt}`, ...(typeof localTime === "string" && localTime.trim() ? [`Local time: ${localTime.trim()}`] : []), ...timing, "", "A possible point of attention was found:", "", narrative.trim(), "</proactive_opportunity>", "", "This is not a human message and it is not a task assignment. Treat it as a possible point of attention.", "You may let it pass, inspect or change Workspace material, continue private work, change direction, or reach out through the available interaction tools when something is genuinely worth sending.", "Do not report this wrapper or its internal fields to the human."].join("\n");
}

function elapsedTime(later: string, earlier: string): string {
  const minutes = Math.max(0, Math.floor((Date.parse(later) - Date.parse(earlier)) / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} hours ${minutes % 60} minutes` : `${minutes} minutes`;
}
