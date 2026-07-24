export type AttachmentKind = "image" | "file";

export interface AttachmentReference {
  version: 1;
  id: string;
  kind: AttachmentKind;
  mediaType: string;
  byteSize: number;
  fileName?: string;
}

export function attachmentReferences(payload: unknown): AttachmentReference[] {
  if (!isObject(payload) || payload.attachments === undefined) return [];
  if (!Array.isArray(payload.attachments)) throw new Error("Input attachments must be an array");
  return payload.attachments.map((value, index) => parseAttachmentReference(value, `Attachment ${index + 1}`));
}

export function parseAttachmentReference(value: unknown, label = "Attachment"): AttachmentReference {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set(["version", "id", "kind", "mediaType", "byteSize", "fileName"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has unsupported field ${key}`);
  }
  if (value.version !== 1) throw new Error(`${label} requires version 1`);
  if (typeof value.id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.id)) {
    throw new Error(`${label} requires a sha256 id`);
  }
  if (value.kind !== "image" && value.kind !== "file") {
    throw new Error(`${label} requires a supported kind`);
  }
  if (typeof value.mediaType !== "string" || !value.mediaType.trim()) {
    throw new Error(`${label} requires a mediaType`);
  }
  if (!Number.isSafeInteger(value.byteSize) || (value.byteSize as number) < 0) {
    throw new Error(`${label} requires a valid byteSize`);
  }
  if (value.fileName !== undefined && (typeof value.fileName !== "string" || !value.fileName.trim())) {
    throw new Error(`${label} fileName must be non-empty when present`);
  }
  return {
    version: 1,
    id: value.id,
    kind: value.kind,
    mediaType: value.mediaType.trim(),
    byteSize: value.byteSize as number,
    ...(value.fileName !== undefined ? { fileName: value.fileName.trim() } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
