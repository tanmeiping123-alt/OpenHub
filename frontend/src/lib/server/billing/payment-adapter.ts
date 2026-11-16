import "server-only";
import { AccountError } from "../account-errors";

// Integration boundary for a future approved merchant product. It must implement
// official verification, durable events and query/refund reconciliation before
// becoming selectable. There is deliberately no simulated-success HTTP endpoint.
export interface MerchantPaymentAdapter {
  readonly channel: "ALIPAY_WEB" | "WECHAT_NATIVE";
  createOrder(order: {
    id: string;
    amountFen: number;
    currency: "CNY";
  }): Promise<{ checkoutUrl?: string; qrContent?: string }>;
  verifyNotification(rawBody: Uint8Array, headers: Headers): Promise<VerifiedMerchantEvent>;
  queryOrder(orderId: string): Promise<VerifiedMerchantEvent>;
  refundOrder(input: {
    orderId: string;
    refundRequestId: string;
    amountFen: number;
  }): Promise<{ status: "PROCESSING" | "SUCCESS" | "FAILED"; reference: string }>;
}
export type VerifiedMerchantEvent = {
  eventId: string;
  orderId: string;
  transactionId: string;
  appId: string;
  merchantId: string;
  amountFen: number;
  currency: "CNY";
  environment: "SANDBOX" | "PRODUCTION";
  status: "PAID" | "CLOSED" | "PENDING";
  verifiedAt: string;
};
export const automaticPaymentAdapter: MerchantPaymentAdapter = {
  channel: "ALIPAY_WEB",
  async createOrder() {
    throw new AccountError("AUTOMATIC_PAYMENT_NOT_CONFIGURED", 503);
  },
  async verifyNotification() {
    throw new AccountError("AUTOMATIC_PAYMENT_NOT_CONFIGURED", 503);
  },
  async queryOrder() {
    throw new AccountError("AUTOMATIC_PAYMENT_NOT_CONFIGURED", 503);
  },
  async refundOrder() {
    throw new AccountError("AUTOMATIC_PAYMENT_NOT_CONFIGURED", 503);
  },
};
