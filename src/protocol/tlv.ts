/**
 * NAPS Pay M2M ASCII TLV protocol (Ingenico Lane, Sunmi P2/P3).
 *
 * Wire format: each element is TAG(3 ASCII digits) + LENGTH(3 ASCII digits) + VALUE.
 * Port of the Aslan.Naps C# SDK `LtvProtocol`, conformant with the NapsPay ECR↔Terminal
 * TLV Protocol Specification v2.0.
 */

/** NAPS protocol generation. v1 and v2 differ in the response terminator and the
 * confirmation field set (§4.2); select per transport via NapsClientOptions. */
export type ProtocolVersion = "v1" | "v2";

/** Field tags (v2 §3.3). */
export const TAG = {
  TM: "001",
  MT: "002",
  NCAI: "003",
  NS: "004",
  NSA: "005", // original sequence number to cancel (TM 003)
  NHC: "006", // hostess number
  NCAR: "007",
  STAN: "008",
  NA: "009", // authorization number (legacy/vendor tag; not in v2 §3.3 but emitted)
  DP: "010",
  CB: "011", // barcode value
  DE: "012", // currency code
  CR: "013",
  DA: "014",
  HE: "015",
  NPRT: "016",
  DAEX: "017",
  DATR: "018", // original transaction date
  HETR: "019", // original transaction time
  TIDE: "020", // parameter set: 01=Merchant, 02=Recharge
  TYPA: "021", // transaction type
  RE: "022", // receipt data
  RECB: "023", // receipt copy
  REQU: "024", // request type
  RESE: "025", // response message
  RECO: "026", // receipt confirmation
  RERA: "027", // response reason
  MDLC: "028", // model code
  EM: "040", // entry mode
} as const;

/** Receipt sub-tags inside the DP (010) print block (v2 §5). */
export const RECEIPT_TAG = { LINE_NUMBER: "030", FORMAT: "031", ALIGNMENT: "032", CONTENT: "033" } as const;

/** Message types (v2 §3.4). */
export const TM = {
  PAYMENT: "001",
  CONFIRMATION: "002",
  CANCELLATION: "003",
  CANCELLATION_CONFIRMATION: "004", // phase 2 of a void, same connection as TM 003
  DUPLICATE: "008",
  NETWORK_TEST: "009",
  TOTALS: "010",
  SETTLEMENT: "010", // telecollecte — shares TM 010 with totals
  RESET_PINPAD: "012",
  REFERENCING: "013",
  // Terminal → ECR responses (request TM + 100).
  PAYMENT_RESPONSE: "101",
  CONFIRMATION_RESPONSE: "102",
  CANCELLATION_RESPONSE: "103",
  CANCELLATION_CONFIRMATION_RESPONSE: "104",
  /** @deprecated 104 is the reply to TM 004; use CANCELLATION_CONFIRMATION_RESPONSE. */
  CANCELLATION_CORRECTION: "104",
  DUPLICATE_RESPONSE: "108",
  NETWORK_TEST_RESPONSE: "109",
  TOTALS_RESPONSE: "110",
  RESET_PINPAD_RESPONSE: "112",
  REFERENCING_RESPONSE: "113",
} as const;

/** TIDE parameter sets (TM 013 Referencing). */
export const TIDE = { MERCHANT: "01", RECHARGE: "02" } as const;

/** CR codes that mean the payment was approved. */
export const APPROVED_CODES = new Set(["000", "001", "003", "007"]);

/** CR (013) response codes from v2 §6. */
export const RESPONSE_CODES: Record<string, string> = {
  "000": "Approved",
  "001": "Approved with identification",
  "003": "Approved (VIP)",
  "007": "Approved, microchip update required",
  "100": "Do not honour",
  "101": "Card expired",
  "102": "Fraud suspected",
  "104": "Restricted card use",
  "106": "Allowed PIN tries exceeded",
  "107": "Refer to card issuer",
  "108": "Refer to issuer special conditions",
  "109": "Invalid merchant",
  "110": "Invalid amount",
  "111": "Invalid card number",
  "112": "PIN information required",
  "114": "No account of requested type",
  "115": "Requested function not supported",
  "116": "Insufficient funds",
  "117": "Incorrect PIN",
  "118": "Card not registered",
  "119": "Transaction not permitted to cardholder",
  "120": "Transaction not permitted at terminal",
  "121": "Withdrawal limit exceeded",
  "122": "Security violation",
  "123": "Withdrawal frequency exceeded",
  "125": "Card not in service",
  "126": "Invalid PIN format",
  "127": "PIN length error",
  "128": "PIN key sync error",
  "129": "Card counterfeiting suspected",
  "180": "Credit account does not exist",
  "181": "Cheque account does not exist",
  "182": "Savings account does not exist",
  "183": "Invalid CVV",
  "184": "Invalid date",
  "200": "Do not honour — capture card",
  "201": "Card expired — capture card",
  "202": "Fraud suspected — capture card",
  "204": "Restricted card — capture card",
  "205": "Security service — capture card",
  "206": "PIN tries exceeded — capture card",
  "207": "Special conditions — capture card",
  "208": "Lost card — capture card",
  "209": "Stolen card — capture card",
  "210": "Counterfeiting suspected — capture card",
  "280": "Alternative amount cancelled",
  "299": "Capture card",
  "300": "Processing completed",
  "301": "Not supported by recipient",
  "302": "Record not found on file",
  "303": "Duplicate record, old record replaced",
  "304": "Field edit error",
  "305": "File locked",
  "306": "Processing failure",
  "307": "Format error",
  "308": "Duplicate processing, new record rejected",
  "309": "File unknown",
  "381": "Record not found. Account unsettled. Withdrawal not processed",
  "382": "Balance record deleted",
  "383": "Balance enquiry",
  "480": "Reversal accepted",
  "481": "Reversal incorrect",
  "482": "Transaction already cancelled",
  "501": "Reversal amount incorrect",
  "503": "Totals not available",
  "581": "Reconciliation complete",
  "582": "Reconciliation procedure not available",
  "700": "Top-ups fully reserved",
  "701": "Top-ups partially reserved",
  "702": "Top-ups not reserved",
  "750": "Message or ECR request not authorised by centre",
  "800": "Cut-off in progress",
  "880": "Connection not accepted",
  "902": "Invalid transaction",
  "908": "Transaction recipient not referenced for routing",
  "909": "System failure",
  "911": "Issuer did not respond in time",
  "912": "Card issuer unavailable",
  "992": "Issuer not found",
  "993": "PIN verification impossible",
  "994": "Transaction processing error",
  "995": "Server processing error",
};

const MAX_AMOUNT_CENTIMES = 999_999_999_999;

function pad(value: string, len: number): string {
  return value.padStart(len, "0");
}

function now(): { date: string; time: string } {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  const HH = String(d.getHours()).padStart(2, "0");
  const MM = String(d.getMinutes()).padStart(2, "0");
  const SS = String(d.getSeconds()).padStart(2, "0");
  return { date: `${dd}${mm}${yyyy}`, time: `${HH}${MM}${SS}` };
}

/** Encode one TLV field: TAG(3) + LENGTH(3) + VALUE. */
export function tlv(tag: string, value: string): string {
  return `${tag}${pad(String(value.length), 3)}${value}`;
}

export interface BuildMessageOptions {
  ncai?: string;
  ns?: string;
  amountCentimes?: number;
  currency?: string;
  extraFields?: Array<[string, string]>;
}

/**
 * Build an ECR→terminal request. TM/NCAI/NS/DA/HE are always present; MT/DE when
 * an amount is given; DATR/HETR are always added (required by the terminal).
 */
export function buildMessage(tm: string, opts: BuildMessageOptions = {}): string {
  const { ncai = "0100001", ns = "000001", amountCentimes, currency = "504", extraFields } = opts;
  const t = now();
  const fields: string[] = [tlv(TAG.TM, tm)];

  if (amountCentimes !== undefined) {
    if (amountCentimes < 0 || amountCentimes > MAX_AMOUNT_CENTIMES) {
      throw new RangeError("Amount must be between 0 and 9,999,999,999.99 MAD");
    }
    fields.push(tlv(TAG.MT, String(amountCentimes)));
  }

  fields.push(tlv(TAG.NCAI, ncai));
  fields.push(tlv(TAG.NS, ns));

  if (amountCentimes !== undefined) fields.push(tlv(TAG.DE, currency));

  fields.push(tlv(TAG.DA, t.date));
  fields.push(tlv(TAG.HE, t.time));
  fields.push(tlv(TAG.DATR, t.date));
  fields.push(tlv(TAG.HETR, t.time));

  if (extraFields) for (const [tag, value] of extraFields) fields.push(tlv(tag, value));

  return fields.join("");
}

export interface BuildConfirmationOptions {
  ncai?: string;
  ns?: string;
  amountCentimes?: number;
  currency?: string;
  ncar?: string;
  daex?: string;
}

/**
 * Payment Confirmation (TM 002). Per spec §4.2 the confirmation should carry
 * MT/DE/NCAR/DAEX so the terminal can reinforce coherence checks against the
 * approved payment. All extras are optional (v1 terminals ignore them).
 */
export function buildConfirmation(stan: string, opts: BuildConfirmationOptions = {}): string {
  const { ncai = "0100001", ns = "000001", amountCentimes, currency = "504", ncar, daex } = opts;
  const t = now();
  const fields: string[] = [tlv(TAG.TM, TM.CONFIRMATION), tlv(TAG.NCAI, ncai), tlv(TAG.NS, ns)];

  if (amountCentimes !== undefined) {
    fields.push(tlv(TAG.MT, String(amountCentimes)));
    fields.push(tlv(TAG.DE, currency));
  }

  fields.push(tlv(TAG.STAN, stan));

  if (ncar) fields.push(tlv(TAG.NCAR, ncar));
  if (daex) fields.push(tlv(TAG.DAEX, daex));

  fields.push(tlv(TAG.DA, t.date));
  fields.push(tlv(TAG.HE, t.time));

  return fields.join("");
}

export interface BuildCancellationOptions {
  ncai?: string;
  ns?: string;
  amountCentimes?: number;
  originalSequence?: string;
}

/**
 * Cancellation (TM 003). NapsPay v5.4.4+ requires the original amount (MT 002);
 * `originalSequence` is sent as NSA (005), the sequence number of the payment to void.
 */
export function buildCancellation(stan: string, opts: BuildCancellationOptions = {}): string {
  return buildCancellationFrame(TM.CANCELLATION, stan, opts);
}

/**
 * Cancellation Confirmation (TM 004) — phase 2 of a void, sent on the same connection
 * after an approved TM 103. Carries the same fields as the TM 003 request.
 */
export function buildCancellationConfirmation(stan: string, opts: BuildCancellationOptions = {}): string {
  return buildCancellationFrame(TM.CANCELLATION_CONFIRMATION, stan, opts);
}

function buildCancellationFrame(tm: string, stan: string, opts: BuildCancellationOptions): string {
  const extra: Array<[string, string]> = [[TAG.STAN, stan]];
  if (opts.amountCentimes !== undefined && opts.amountCentimes > 0) {
    extra.push([TAG.MT, String(opts.amountCentimes)]);
  }
  if (opts.originalSequence) extra.push([TAG.NSA, opts.originalSequence]);
  return buildMessage(tm, { ncai: opts.ncai, ns: opts.ns, extraFields: extra });
}

/**
 * Settlement / telecollecte (TM 010): TM + NCAI + DA + HE, no sequence number
 * (same frame as the canonical C# SDK).
 */
export function buildSettlement(ncai = "0100001"): string {
  const t = now();
  return tlv(TAG.TM, TM.SETTLEMENT) + tlv(TAG.NCAI, ncai) + tlv(TAG.DA, t.date) + tlv(TAG.HE, t.time);
}

/**
 * Parse a TLV string → { tag: value }. Stops at the first terminator ('!' v2, '?' v1)
 * so trailing receipt/noise after it is ignored. The PAN in NCAR (007) is masked on
 * parse so the full card number never leaves this function.
 */
export function parseMessage(raw: string): Record<string, string> {
  let data = raw;
  const term = data.search(/[!?]/);
  if (term >= 0) data = data.slice(0, term);
  data = data.trim();

  const fields: Record<string, string> = {};
  let pos = 0;
  while (pos + 6 <= data.length) {
    const tag = data.slice(pos, pos + 3);
    const lenStr = data.slice(pos + 3, pos + 6);
    const len = Number(lenStr);
    if (!/^\d{3}$/.test(tag) || !/^\d{3}$/.test(lenStr) || Number.isNaN(len)) break;
    if (pos + 6 + len > data.length) break;
    const value = data.slice(pos + 6, pos + 6 + len);
    fields[tag] = tag === TAG.NCAR ? maskPan(value) : value;
    pos += 6 + len;
  }
  return fields;
}

export function isApproved(cr: string | undefined | null): boolean {
  return cr != null && APPROVED_CODES.has(cr);
}

export function describeResponse(cr: string | undefined | null): string {
  if (cr != null && cr in RESPONSE_CODES) return RESPONSE_CODES[cr];
  return `Unknown response code: ${cr ?? "(none)"}`;
}

export function maskPan(pan: string): string {
  if (pan.length < 10) return pan;
  return pan.slice(0, 6) + "*".repeat(pan.length - 10) + pan.slice(-4);
}

/** Mask any 16-digit card numbers found in free text (e.g. receipt lines). */
export function maskPansInText(text: string): string {
  return text.replace(/\b\d{16}\b/g, maskPan);
}

/** Return the last '!'/'?'-terminated message from a raw stream. */
export function extractLastMessage(raw: string): string {
  const parts = raw.split(/[!?]/).filter((p) => p.length > 0);
  return parts.length === 0 ? "" : parts[parts.length - 1] + "!";
}
