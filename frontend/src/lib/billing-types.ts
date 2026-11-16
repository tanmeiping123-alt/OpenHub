import type { PaymentChannel } from "./billing-policy";

export type BillingOrder = {
  id: string;
  status: string;
  channel: PaymentChannel;
  amountFen: number;
  currency: string;
  expiresAt: string;
  createdAt: string;
  receiverHint: string;
  refundContact: string;
  qrPath: string;
  claimTransaction: string | null;
  claimPaidAt: string | null;
  entitlementStart: string | null;
  entitlementEnd: string | null;
  grantStatus: string;
  refundStatus: string | null;
  issueCode: string | null;
  receiverAccount?: string;
  ownerEmail?: string;
  verifiedTransaction?: string;
  refundReason?: string;
};
export type BillingData = {
  role: "ADMIN" | "USER";
  modelQuotaUnlimited?: boolean;
  payment: {
    ready: boolean;
    methods: Array<{ channel: PaymentChannel; ready: boolean }>;
  };
  eligibility: boolean;
  offerUsed: boolean;
  entitlement: { code: string; tier: string; start: string; end: string; frozen: boolean };
  capacity: {
    promptCount: number;
    promptLimit: number;
    privateSkillCount: number;
    privateSkillLimit: number;
  };
  orders: BillingOrder[];
};
