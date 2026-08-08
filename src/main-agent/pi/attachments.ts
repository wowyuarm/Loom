import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExecutionInput } from "../../runtime/index.js";
import { attachmentReferences, type AttachmentReference } from "../../attachments/index.js";
import type { AttachmentStore } from "../../integrations/attachments/index.js";

export interface InputPresentation {
  text: string;
  images: ImageContent[];
}

export async function presentInputWithAttachments(options: {
  input: ExecutionInput;
  text: string;
  attachmentStore: AttachmentStore | undefined;
  supportsNativeImages: boolean;
}): Promise<InputPresentation> {
  const attachments = options.input.kind === "interaction" ? attachmentReferences(options.input.payload) : [];
  if (attachments.length === 0) return { text: options.text, images: [] };
  if (attachments.length > 1) throw new Error("This Loom version accepts one attachment per Input");
  if (!options.attachmentStore) throw new Error("Attachment Input requires an Attachment Store");
  const images: ImageContent[] = [];
  const descriptions: string[] = [];
  for (const attachment of attachments) {
    let representation: string;
    if (attachment.kind === "image" && options.supportsNativeImages) {
      const content = await options.attachmentStore.read(attachment);
      images.push({ type: "image", data: content.toString("base64"), mimeType: attachment.mediaType });
      representation = "native image included in this user message";
    } else if (attachment.kind === "image") {
      representation = "metadata only; image content was not shown because the current model does not declare image input support";
    } else representation = "metadata only; file content was not parsed or shown automatically";
    descriptions.push(attachmentDescription(attachment, representation));
  }
  return { text: [options.text, "", "<attachments>", ...descriptions, "</attachments>"].join("\n"), images };
}

function attachmentDescription(attachment: AttachmentReference, representation: string): string {
  return [`- id: ${attachment.id}`, `  kind: ${attachment.kind}`, `  media_type: ${attachment.mediaType}`,
    `  byte_size: ${attachment.byteSize}`, ...(attachment.fileName ? [`  file_name: ${JSON.stringify(attachment.fileName)}`] : []),
    `  representation: ${representation}`].join("\n");
}
