import crypto from "node:crypto";

import type {
  WeixinRemote,
  WeixinRemoteMessage,
  WeixinRemotePollResult,
} from "./weixin-adapter.js";
import type { AttachmentReference } from "../../attachments/index.js";

const CHANNEL_VERSION = "2.3.1";
const APP_ID = "bot";
const USER_MESSAGE = 1;
const BOT_MESSAGE = 2;
const FINISHED_MESSAGE = 2;
const TEXT_ITEM = 1;
const IMAGE_ITEM = 2;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

interface ApiResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

interface UpdatesResponse extends ApiResponse {
  get_updates_buf?: string;
  msgs?: RawMessage[];
}

interface UploadUrlResponse extends ApiResponse {
  upload_param?: string;
  upload_full_url?: string;
}

interface UploadedAttachment {
  encryptedQueryParam: string;
  aesKey: Buffer;
  plaintextSize: number;
  ciphertextSize: number;
}

interface RawMessage {
  message_id?: number | string;
  from_user_id?: string;
  create_time_ms?: number;
  message_type?: number;
  message_state?: number;
  context_token?: string;
  item_list?: Array<{
    type?: number;
    text_item?: { text?: string };
    image_item?: {
      media?: {
        encrypt_query_param?: string;
        aes_key?: string;
        full_url?: string;
      };
      aeskey?: string;
    };
  }>;
}

class HttpWeixinRemote implements WeixinRemote {
  async start(request: { baseUrl: string; token: string; signal: AbortSignal }): Promise<void> {
    const response = await post<ApiResponse>({
      ...request,
      endpoint: "ilink/bot/msg/notifystart",
      body: {},
      timeoutMs: 10_000,
    });
    assertApiSuccess("notifystart", response);
  }

  async poll(request: {
    baseUrl: string;
    token: string;
    cursor: string;
    signal: AbortSignal;
  }): Promise<WeixinRemotePollResult> {
    const response = await post<UpdatesResponse>({
      ...request,
      endpoint: "ilink/bot/getupdates",
      body: { get_updates_buf: request.cursor },
      timeoutMs: 40_000,
    });
    assertApiSuccess("getupdates", response);
    return {
      ...(response.get_updates_buf !== undefined ? { cursor: response.get_updates_buf } : {}),
      messages: (response.msgs ?? []).map(normalizeMessage),
    };
  }

  async sendText(request: {
    baseUrl: string;
    token: string;
    peerId: string;
    text: string;
    clientId: string;
    contextToken?: string;
  }): Promise<
    | { disposition: "sent"; remoteId: string }
    | { disposition: "rejected"; error: string; code?: number }
  > {
    const response = await post<ApiResponse>({
      ...request,
      endpoint: "ilink/bot/sendmessage",
      timeoutMs: 15_000,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: request.peerId,
          client_id: request.clientId,
          message_type: BOT_MESSAGE,
          message_state: FINISHED_MESSAGE,
          item_list: [{ type: TEXT_ITEM, text_item: { text: request.text } }],
          ...(request.contextToken ? { context_token: request.contextToken } : {}),
        },
      },
    });
    if (hasApiError(response)) {
      return {
        disposition: "rejected",
        error: apiErrorMessage("sendmessage", response),
        ...(response.errcode !== undefined
          ? { code: response.errcode }
          : response.ret !== undefined ? { code: response.ret } : {}),
      };
    }
    return { disposition: "sent", remoteId: request.clientId };
  }

  async downloadImage(request: {
    cdnBaseUrl: string;
    image: import("./weixin-adapter.js").WeixinRemoteImage;
    signal: AbortSignal;
  }): Promise<{ content: Uint8Array; mediaType: string; fileName: string }> {
    const url = imageDownloadUrl(request.cdnBaseUrl, request.image);
    const response = await fetch(url, { signal: request.signal });
    if (!response.ok) throw new Error(`Weixin image download returned HTTP ${response.status}`);
    const encrypted = Boolean(request.image.aesKey || request.image.aesKeyHex);
    const maximumDownloadedBytes = MAX_IMAGE_BYTES + (encrypted ? 16 : 0);
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > maximumDownloadedBytes) {
      throw new Error("Weixin image exceeds the 15 MiB inbound limit");
    }
    const downloaded = await readBoundedBody(response, maximumDownloadedBytes);
    const content = decryptImage(downloaded, request.image);
    if (content.length > MAX_IMAGE_BYTES) throw new Error("Weixin image exceeds the 15 MiB inbound limit");
    const detected = detectImage(content);
    return {
      content,
      mediaType: detected.mediaType,
      fileName: `weixin-image${detected.extension}`,
    };
  }

  async sendAttachment(request: {
    baseUrl: string;
    cdnBaseUrl: string;
    token: string;
    peerId: string;
    text: string;
    attachment: AttachmentReference;
    content: Uint8Array;
    clientId: string;
    contextToken?: string;
  }): Promise<
    | { disposition: "sent"; remoteId: string }
    | { disposition: "rejected"; error: string; code?: number }
  > {
    let uploaded: UploadedAttachment;
    try {
      uploaded = await uploadAttachment(request);
    } catch (error) {
      return { disposition: "rejected", error: errorMessage(error) };
    }

    let captionSent = false;
    if (request.text) {
      const caption = await this.sendText({
        baseUrl: request.baseUrl,
        token: request.token,
        peerId: request.peerId,
        text: request.text,
        clientId: `${request.clientId}:text`,
        ...(request.contextToken ? { contextToken: request.contextToken } : {}),
      });
      if (caption.disposition === "rejected") return caption;
      captionSent = true;
    }

    try {
      const result = await sendAttachmentItem(request, uploaded);
      if (result.disposition === "rejected" && captionSent) {
        throw new Error(`Weixin attachment was rejected after its caption was sent: ${result.error}`);
      }
      return result;
    } catch (error) {
      if (captionSent) {
        throw new Error(`Weixin attachment outcome is unknown after its caption was sent: ${errorMessage(error)}`);
      }
      throw error;
    }
  }

  async stop(request: { baseUrl: string; token: string }): Promise<void> {
    const response = await post<ApiResponse>({
      ...request,
      endpoint: "ilink/bot/msg/notifystop",
      body: {},
      timeoutMs: 10_000,
    });
    assertApiSuccess("notifystop", response);
  }
}

export function createWeixinHttpRemote(): WeixinRemote {
  return new HttpWeixinRemote();
}

function normalizeMessage(message: RawMessage): WeixinRemoteMessage {
  return {
    ...(message.message_id !== undefined ? { messageId: String(message.message_id) } : {}),
    ...(message.from_user_id !== undefined ? { from: message.from_user_id } : {}),
    ...(message.create_time_ms !== undefined ? { createTimeMs: message.create_time_ms } : {}),
    ...(message.message_type !== undefined
      ? { messageType: message.message_type === USER_MESSAGE ? "user" as const : "bot" as const }
      : {}),
    ...(message.message_state !== undefined
      ? { messageState: message.message_state === FINISHED_MESSAGE ? "finished" as const : "partial" as const }
      : {}),
    ...(message.context_token !== undefined ? { contextToken: message.context_token } : {}),
    items: (message.item_list ?? []).map(item => ({
      ...(item.type === TEXT_ITEM ? { type: "text" as const } : {}),
      ...(item.type === IMAGE_ITEM ? {
        type: "image" as const,
        image: {
          ...(item.image_item?.media?.encrypt_query_param
            ? { encryptedQueryParam: item.image_item.media.encrypt_query_param }
            : {}),
          ...(item.image_item?.media?.aes_key ? { aesKey: item.image_item.media.aes_key } : {}),
          ...(item.image_item?.aeskey ? { aesKeyHex: item.image_item.aeskey } : {}),
          ...(item.image_item?.media?.full_url ? { fullUrl: item.image_item.media.full_url } : {}),
        },
      } : {}),
      ...(item.text_item?.text !== undefined ? { text: item.text_item.text } : {}),
    })),
  };
}

function imageDownloadUrl(
  cdnBaseUrl: string,
  image: import("./weixin-adapter.js").WeixinRemoteImage,
): string {
  const source = image.fullUrl ?? (image.encryptedQueryParam
    ? `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(image.encryptedQueryParam)}`
    : undefined);
  if (!source) throw new Error("Weixin image has no download reference");
  const url = new URL(source);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Weixin image download URL must use HTTP");
  }
  return url.toString();
}

function decryptImage(
  downloaded: Buffer,
  image: import("./weixin-adapter.js").WeixinRemoteImage,
): Buffer {
  const key = image.aesKeyHex
    ? Buffer.from(image.aesKeyHex, "hex")
    : image.aesKey ? parseAesKey(image.aesKey) : undefined;
  if (!key) return downloaded;
  if (key.length !== 16) throw new Error("Weixin image AES key must contain 16 bytes");
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(downloaded), decipher.final()]);
}

function parseAesKey(source: string): Buffer {
  const decoded = Buffer.from(source, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[a-f0-9]{32}$/i.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error("Weixin image AES key is invalid");
}

function detectImage(content: Buffer): { mediaType: string; extension: string } {
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mediaType: "image/png", extension: ".png" };
  }
  if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    return { mediaType: "image/jpeg", extension: ".jpg" };
  }
  const signature = content.subarray(0, 6).toString("ascii");
  if (signature === "GIF87a" || signature === "GIF89a") {
    return { mediaType: "image/gif", extension: ".gif" };
  }
  if (content.subarray(0, 4).toString("ascii") === "RIFF"
    && content.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mediaType: "image/webp", extension: ".webp" };
  }
  throw new Error("Weixin image content is not a supported PNG, JPEG, GIF, or WebP image");
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let byteSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, byteSize);
      const chunk = Buffer.from(value);
      byteSize += chunk.length;
      if (byteSize > maximumBytes) {
        await reader.cancel();
        throw new Error("Weixin image exceeds the 15 MiB inbound limit");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
}

async function uploadAttachment(request: {
  baseUrl: string;
  cdnBaseUrl: string;
  token: string;
  peerId: string;
  attachment: AttachmentReference;
  content: Uint8Array;
}): Promise<UploadedAttachment> {
  const content = Buffer.from(request.content);
  if (content.length !== request.attachment.byteSize
    || `sha256:${crypto.createHash("sha256").update(content).digest("hex")}` !== request.attachment.id) {
    throw new Error(`Attachment ${request.attachment.id} failed upload integrity verification`);
  }
  const fileKey = crypto.randomBytes(16).toString("hex");
  const aesKey = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-128-ecb", aesKey, null);
  const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
  const upload = await post<UploadUrlResponse>({
    baseUrl: request.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    token: request.token,
    timeoutMs: 15_000,
    body: {
      filekey: fileKey,
      media_type: request.attachment.kind === "image" ? 1 : 3,
      to_user_id: request.peerId,
      rawsize: content.length,
      rawfilemd5: crypto.createHash("md5").update(content).digest("hex"),
      filesize: ciphertext.length,
      no_need_thumb: true,
      aeskey: aesKey.toString("hex"),
    },
  });
  assertApiSuccess("getuploadurl", upload);
  const uploadUrl = upload.upload_full_url?.trim() || (upload.upload_param
    ? `${request.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(fileKey)}`
    : undefined);
  if (!uploadUrl) throw new Error("getuploadurl returned no CDN upload location");
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Weixin CDN upload returned HTTP ${response.status}`);
  const encryptedQueryParam = response.headers.get("x-encrypted-param")?.trim();
  if (!encryptedQueryParam) throw new Error("Weixin CDN upload returned no encrypted download reference");
  return {
    encryptedQueryParam,
    aesKey,
    plaintextSize: content.length,
    ciphertextSize: ciphertext.length,
  };
}

async function sendAttachmentItem(
  request: {
    baseUrl: string;
    token: string;
    peerId: string;
    attachment: AttachmentReference;
    clientId: string;
    contextToken?: string;
  },
  uploaded: UploadedAttachment,
): Promise<
  | { disposition: "sent"; remoteId: string }
  | { disposition: "rejected"; error: string; code?: number }
> {
  const clientId = `${request.clientId}:attachment`;
  const media = {
    encrypt_query_param: uploaded.encryptedQueryParam,
    aes_key: uploaded.aesKey.toString("base64"),
    encrypt_type: 1,
  };
  const item = request.attachment.kind === "image"
    ? { type: IMAGE_ITEM, image_item: { media, mid_size: uploaded.ciphertextSize } }
    : {
        type: 4,
        file_item: {
          media,
          file_name: request.attachment.fileName ?? "attachment",
          len: String(uploaded.plaintextSize),
        },
      };
  const response = await post<ApiResponse>({
    baseUrl: request.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    token: request.token,
    timeoutMs: 15_000,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: request.peerId,
        client_id: clientId,
        message_type: BOT_MESSAGE,
        message_state: FINISHED_MESSAGE,
        item_list: [item],
        ...(request.contextToken ? { context_token: request.contextToken } : {}),
      },
    },
  });
  if (hasApiError(response)) {
    return {
      disposition: "rejected",
      error: apiErrorMessage("sendmessage", response),
      ...(response.errcode !== undefined
        ? { code: response.errcode }
        : response.ret !== undefined ? { code: response.ret } : {}),
    };
  }
  return { disposition: "sent", remoteId: clientId };
}

async function post<T>(options: {
  baseUrl: string;
  endpoint: string;
  token: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<T> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const url = new URL(options.endpoint, withTrailingSlash(options.baseUrl));
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.token}`,
      authorizationtype: "ilink_bot_token",
      "iLink-App-Id": APP_ID,
      "iLink-App-ClientVersion": String(buildClientVersion(CHANNEL_VERSION)),
      "X-WECHAT-UIN": randomWechatUin(),
    },
    body: JSON.stringify({
      ...options.body,
      base_info: {
        channel_version: CHANNEL_VERSION,
        bot_agent: "Loom",
      },
    }),
    signal,
  });
  const source = await response.text();
  if (!response.ok) throw new Error(`${options.endpoint} returned HTTP ${response.status}`);
  try {
    return JSON.parse(source) as T;
  } catch {
    throw new Error(`${options.endpoint} returned invalid JSON`);
  }
}

function assertApiSuccess(endpoint: string, response: ApiResponse): void {
  if (hasApiError(response)) throw new Error(apiErrorMessage(endpoint, response));
}

function hasApiError(response: ApiResponse): boolean {
  return (response.ret !== undefined && response.ret !== 0)
    || (response.errcode !== undefined && response.errcode !== 0);
}

function apiErrorMessage(endpoint: string, response: ApiResponse): string {
  const detail = [
    response.ret !== undefined ? `ret=${response.ret}` : undefined,
    response.errcode !== undefined ? `errcode=${response.errcode}` : undefined,
    response.errmsg,
  ].filter(Boolean).join(" ");
  return `${endpoint} rejected${detail ? `: ${detail}` : ""}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(part => Number(part) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function randomWechatUin(): string {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
}
