import type { ReceiptLine } from "./protocol/receipt.js";
import type { ProtocolVersion } from "./protocol/tlv.js";

/** Terminal transport type. */
export type TransportType = "tcp" | "serial";

export interface NapsClientOptions {
  /** Transport: "tcp" (Sunmi P2/P3) or "serial" (Ingenico Lane). Default "tcp". */
  transport?: TransportType;

  // --- TCP (Sunmi P2/P3) ---
  tcpHost?: string;
  tcpPort?: number; // default 4444
  tcpConnectTimeoutMs?: number; // default 120_000

  // --- USB serial (Ingenico Lane) ---
  /** Serial port path (e.g. /dev/tty.usbmodem1201, COM3). */
  serialPath?: string;
  serialBaudRate?: number; // default 115200
  /**
   * NAPS TLV protocol generation for the serial terminal. v1 terminals terminate
   * responses with '?' and ignore the §4.2 confirmation extras; v2 (NapsPay v5.4.4+)
   * uses '!' and reads MT/NCAR/DAEX on the confirmation. Default "v2".
   */
  protocolVersion?: ProtocolVersion;

  // --- Common ---
  /** Register ID (2 digits) for the NCAI field. Default "01". */
  registerId?: string;
  /** Cashier ID (5 digits) for the NCAI field. Default "00001". */
  cashierId?: string;

  paymentTimeoutMs?: number; // default 120_000
  confirmationTimeoutMs?: number; // default 40_000 (protocol deadline)
  testTimeoutMs?: number; // default 30_000
  referencingTimeoutMs?: number; // default 60_000
}

export interface ResolvedOptions extends Required<Omit<NapsClientOptions, "tcpHost" | "serialPath">> {
  tcpHost?: string;
  serialPath?: string;
}

export const DEFAULTS: ResolvedOptions = {
  transport: "tcp",
  tcpPort: 4444,
  tcpConnectTimeoutMs: 120_000,
  serialBaudRate: 115200,
  protocolVersion: "v2", // overridden per-transport by resolveOptions()
  registerId: "01",
  cashierId: "00001",
  paymentTimeoutMs: 120_000,
  confirmationTimeoutMs: 40_000,
  testTimeoutMs: 30_000,
  referencingTimeoutMs: 60_000,
};

/**
 * Merge user options over defaults, choosing a transport-appropriate protocol
 * default when the caller didn't pin one:
 *   - TCP (Sunmi P2/P3)      → "v2" ('!' terminator, NapsPay v5.4.4+)
 *   - serial (Ingenico Lane) → "v1" ('?' terminator, legacy terminals)
 * An explicit `protocolVersion` always wins.
 */
export function resolveOptions(options: NapsClientOptions = {}): ResolvedOptions {
  const merged = { ...DEFAULTS, ...options };
  if (options.protocolVersion === undefined) {
    merged.protocolVersion = merged.transport === "serial" ? "v1" : "v2";
  }
  return merged;
}

export interface PaymentResult {
  isSuccess: boolean;
  isCancelled: boolean;
  responseCode?: string;
  responseMessage?: string;
  authorizationNumber?: string;
  cardNumber?: string;
  cardScheme?: string;
  stan?: string;
  approvalCode?: string;
  transactionDate?: string;
  transactionTime?: string;
  /** DATR (018) — original transaction date, on cancellation responses. */
  originalTransactionDate?: string;
  /** HETR (019) — original transaction time, on cancellation responses. */
  originalTransactionTime?: string;
  /** DAEX (017) — card expiry (YYMM). */
  cardExpiry?: string;
  receiptText?: string;
  receiptLines?: ReceiptLine[];
  cardholderName?: string;
}

export interface TestResult {
  isSuccess: boolean;
  responseCode?: string;
  message?: string;
}

export interface ReferencingResult {
  isSuccess: boolean;
  responseCode?: string;
  /** TIDE (020) echoed by the terminal: which parameter set was loaded. */
  parameterSet?: string;
  receiptText?: string;
}

export interface TotalsResult {
  isSuccess: boolean;
  responseCode?: string;
  receiptText?: string;
}
