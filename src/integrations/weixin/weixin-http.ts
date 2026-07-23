import crypto from "node:crypto";

import type {
  WeixinRemote,
  WeixinRemoteMessage,
  WeixinRemotePollResult,
} from "./weixin-adapter.js";

const CHANNEL_VERSION = "2.3.1";
const APP_ID = "bot";
const USER_MESSAGE = 1;
const BOT_MESSAGE = 2;
const FINISHED_MESSAGE = 2;
const TEXT_ITEM = 1;

interface ApiResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

interface UpdatesResponse extends ApiResponse {
  get_updates_buf?: string;
  msgs?: RawMessage[];
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
      ...(item.text_item?.text !== undefined ? { text: item.text_item.text } : {}),
    })),
  };
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
