import type { InteractionChannelFailureCategory } from "../channel.js";

/** Weixin `ret`/`errcode` for an expired bot session. */
export const WEIXIN_SESSION_EXPIRED_CODE = -14;

/**
 * A Weixin wire or ingress failure that already carries how recovery should
 * treat it. Classification happens where the failure is observed, so ingress
 * never has to parse error text: an unrepresentable message must not be
 * retried forever, while a transport or session failure is worth another
 * attempt.
 */
export class WeixinFailure extends Error {
  constructor(
    message: string,
    readonly category: InteractionChannelFailureCategory,
    /** Weixin `ret`/`errcode`, when the remote API rejected the call. */
    readonly code?: number,
  ) {
    super(message);
    this.name = "WeixinFailure";
  }
}

export function isWeixinSessionExpired(error: unknown): boolean {
  return error instanceof WeixinFailure && error.code === WEIXIN_SESSION_EXPIRED_CODE;
}
