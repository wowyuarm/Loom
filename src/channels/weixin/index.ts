export {
  openWeixinAdapter,
  openConfiguredWeixinAdapter,
  weixinOpaqueRef,
  type WeixinAdapter,
  type WeixinAdapterStatus,
  type WeixinRemote,
  type WeixinRemoteMedia,
  type WeixinRemoteMessage,
  type WeixinRemotePollResult,
  type WeixinRemoteVoice,
  type WeixinRetryTimings,
  type WeixinTypingTimings,
  type OpenWeixinAdapterOptions,
} from "./weixin-adapter.js";
export { createWeixinHttpRemote } from "./weixin-http.js";
export {
  isWeixinSessionExpired,
  WeixinFailure,
  WEIXIN_SESSION_EXPIRED_CODE,
} from "./weixin-failures.js";
