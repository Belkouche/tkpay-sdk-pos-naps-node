import {
  resolveOptions,
  type NapsClientOptions,
  type PaymentResult,
  type ReferencingResult,
  type ResolvedOptions,
  type SettlementResult,
  type TestResult,
  type TotalsResult,
} from "./models.js";
import { parseReceipt } from "./protocol/receipt.js";
import {
  TAG,
  TM,
  TIDE,
  buildCancellation,
  buildCancellationConfirmation,
  buildConfirmation,
  buildMessage,
  buildSettlement,
  describeResponse,
  extractLastMessage,
  isApproved,
  maskPan,
  maskPansInText,
  parseMessage,
} from "./protocol/tlv.js";
import { TerminalTimeoutError, type Transport } from "./transport/transport.js";
import { TcpTransport } from "./transport/tcp.js";
import { createSerialTransport } from "./transport/serial.js";
import { findIngenicoPort, listPorts, type PortInfo } from "./discovery.js";

/**
 * Unified NAPS terminal client. Supports Sunmi P2/P3 (TCP) and Ingenico Lane
 * (USB serial) through one API. Two-phase payment: authorization (TM 001) then
 * confirmation (TM 002).
 */
export class NapsClient {
  private readonly opts: ResolvedOptions;
  private readonly transport: Transport;
  private sequence = 1;

  /** @param transport optional injected transport (used in tests). */
  constructor(options: NapsClientOptions = {}, transport?: Transport) {
    this.opts = resolveOptions(options);
    this.transport = transport ?? this.createTransport();
  }

  private createTransport(): Transport {
    if (this.opts.transport === "serial") return createSerialTransport(this.opts);
    return new TcpTransport(this.opts);
  }

  get isConnected(): boolean {
    return this.transport.isConnected;
  }
  connect(): Promise<void> {
    return this.transport.connect();
  }
  disconnect(): void {
    this.transport.disconnect();
  }

  private get ncai(): string {
    return this.opts.registerId + this.opts.cashierId;
  }

  private nextSequence(): string {
    const ns = String(this.sequence).padStart(6, "0");
    this.sequence = (this.sequence % 999999) + 1;
    return ns;
  }

  /** NCAI + a fresh sequence for single-frame management operations. */
  private managementFields(): { ncai: string; ns: string } {
    return { ncai: this.ncai, ns: this.nextSequence() };
  }

  /** Process a payment (MAD). Two-phase: TM 001 authorization then TM 002 confirmation. */
  async pay(amountMad: number, _orderId?: string): Promise<PaymentResult> {
    const amountCentimes = Math.round(amountMad * 100);
    const ncai = this.ncai;
    const ns = this.nextSequence();

    const payMsg = buildMessage(TM.PAYMENT, { ncai, ns, amountCentimes });
    let payResp: string;
    try {
      payResp = await this.transport.sendReceive(payMsg, this.opts.paymentTimeoutMs);
    } catch (e) {
      if (e instanceof TerminalTimeoutError) {
        return { isSuccess: false, isCancelled: false, responseCode: "TIMEOUT", responseMessage: "Payment request timed out" };
      }
      throw e;
    }

    const payFields = parseMessage(payResp);
    const cr = payFields[TAG.CR];
    if (!isApproved(cr)) return mapResult(payFields, false);

    const stan = payFields[TAG.STAN];
    if (!stan) return mapResult(payFields, true); // approved but no STAN → cannot confirm

    // Spec §4.2: echo MT/NCAR/DAEX from the approved payment.
    const confMsg = buildConfirmation(stan, {
      ncai,
      ns,
      amountCentimes,
      ncar: payFields[TAG.NCAR],
      daex: payFields[TAG.DAEX],
    });
    try {
      const confResp = await this.transport.sendReceive(confMsg, this.opts.confirmationTimeoutMs);
      const confFields = parseMessage(confResp);
      const confCr = confFields[TAG.CR];
      // The Phase-2 (TM 102) DP is the customer copy of the receipt.
      const confDp = confFields[TAG.DP];
      const result: PaymentResult = {
        ...mapResult(payFields, true),
        customerReceiptText: maskDp(confDp),
        customerReceiptLines: confDp ? parseReceipt(confDp) : undefined,
      };
      // The terminal can refuse the confirmation (302 = sale not found, 482 = already
      // cancelled — it auto-reverses). That is not an approval.
      if (confCr !== undefined && confCr !== "000") {
        return {
          ...result,
          isSuccess: false,
          responseCode: confCr,
          responseMessage: `Confirmation refused: ${describeResponse(confCr)}`,
        };
      }
      return result;
    } catch (e) {
      if (e instanceof TerminalTimeoutError) {
        return { ...mapResult(payFields, true), responseMessage: "Confirmation timed out" };
      }
      throw e;
    }
  }

  /**
   * Cancel/void a payment by STAN. NapsPay v5.4.4 requires the original amount (MAD).
   * Two-phase on the same connection (v2 §4.3–4.4): TM 003 → 103 CR=000 only means the
   * transaction was found; TM 004 → 104 executes the reversal (CR 000/480 = completed).
   * No TM 104 reply, or CR=995, yields `isPending: true` (not a success) with the STAN
   * and the TM 103 merchant receipt — verify with `duplicateReceipt(stan)`.
   * @param originalSequence NS of the payment to void, sent as NSA (005) on TM 003.
   */
  async cancel(stan: string, amountMad?: number, originalSequence?: string): Promise<PaymentResult> {
    const ns = this.nextSequence();
    const amountCentimes = amountMad !== undefined ? Math.round(amountMad * 100) : undefined;
    const msg = buildCancellation(stan, { ncai: this.ncai, ns, amountCentimes, originalSequence });
    try {
      const resp = await this.transport.sendReceive(msg, this.opts.testTimeoutMs);
      const fields = parseMessage(extractLastMessage(resp));
      const tm = fields[TAG.TM];
      const cr = fields[TAG.CR];
      const result = mapResult(fields, false);
      if (tm !== "103" || cr !== "000") {
        // A terminal answering TM 003 directly with a completed TM 104 is still a void.
        // Success is decided by TM+CR, not the payment-approval set (480 is a valid void).
        const done = tm === "104" && (cr === "000" || cr === "480");
        return { ...result, isSuccess: done, isCancelled: done || result.isCancelled };
      }

      // Phase 2: Cancellation Confirmation (TM 004 → 104) executes the reversal.
      const confMsg = buildCancellationConfirmation(fields[TAG.STAN] ?? stan, {
        ncai: this.ncai,
        ns, // same NS as the TM 003 it confirms
        amount: fields[TAG.MT] ?? (amountCentimes ? String(amountCentimes) : undefined),
        currency: fields[TAG.DE],
        datr: fields[TAG.DATR],
        hetr: fields[TAG.HETR],
      });
      let confFields: Record<string, string> | undefined;
      try {
        confFields = parseMessage(await this.transport.sendReceive(confMsg, this.opts.confirmationTimeoutMs));
      } catch (e) {
        if (!(e instanceof TerminalTimeoutError)) throw e;
      }
      const confCr = confFields?.[TAG.CR];
      // Fail closed: no reply, no CR, or 995 (seen alongside completed voids on live
      // terminals) means the outcome is unknown — pending, never success.
      if (confCr === undefined || confCr === "995") {
        return {
          ...result,
          isSuccess: false,
          isCancelled: false,
          isPending: true,
          responseCode: confCr ?? "TIMEOUT",
          responseMessage: `Cancellation unconfirmed (${confCr ?? "no TM 104 reply"}): verify with duplicateReceipt(stan)`,
        };
      }
      if (confCr !== "000" && confCr !== "480") {
        return {
          ...result,
          isSuccess: false,
          isCancelled: false,
          responseCode: confCr,
          responseMessage: `Cancellation confirmation refused: ${describeResponse(confCr)}`,
        };
      }
      const confDp = confFields?.[TAG.DP];
      return {
        ...result,
        isSuccess: true,
        isCancelled: true,
        responseCode: confCr,
        stan: confFields?.[TAG.STAN] ?? result.stan,
        customerReceiptText: maskDp(confDp),
        customerReceiptLines: confDp ? parseReceipt(confDp) : undefined,
      };
    } catch (e) {
      if (e instanceof TerminalTimeoutError) {
        return { isSuccess: false, isCancelled: false, responseCode: "TIMEOUT", responseMessage: "Cancel request timed out" };
      }
      throw e;
    }
  }

  async networkTest(): Promise<TestResult> {
    const resp = await this.transport.sendReceive(buildMessage(TM.NETWORK_TEST, this.managementFields()), this.opts.testTimeoutMs);
    const cr = parseMessage(resp)[TAG.CR];
    return { isSuccess: cr === "000", responseCode: cr, message: cr === "000" ? "Network OK" : `Network test failed: CR=${cr}` };
  }

  /** @param tide "01" merchant (default) or "02" recharge parameter set. */
  async referencing(tide: string = TIDE.MERCHANT): Promise<ReferencingResult> {
    const msg = buildMessage(TM.REFERENCING, { ...this.managementFields(), extraFields: [[TAG.TIDE, tide]] });
    const resp = await this.transport.sendReceive(msg, this.opts.referencingTimeoutMs);
    const fields = parseMessage(resp);
    const cr = fields[TAG.CR];
    return { isSuccess: cr === "000", responseCode: cr, parameterSet: fields[TAG.TIDE] ?? tide, receiptText: maskDp(fields[TAG.DP]) };
  }

  async totals(): Promise<TotalsResult> {
    const resp = await this.transport.sendReceive(buildMessage(TM.TOTALS, this.managementFields()), this.opts.testTimeoutMs);
    const fields = parseMessage(resp);
    const cr = fields[TAG.CR];
    return { isSuccess: cr === "000", responseCode: cr, receiptText: maskDp(fields[TAG.DP]) };
  }

  /** @param stan STAN of a payment from the current business day; omit for the last one (v2 §4.6). */
  async duplicateReceipt(stan?: string): Promise<PaymentResult> {
    const extraFields: Array<[string, string]> = stan ? [[TAG.STAN, stan]] : [];
    const msg = buildMessage(TM.DUPLICATE, { ...this.managementFields(), extraFields });
    const resp = await this.transport.sendReceive(msg, 15_000);
    return mapResult(parseMessage(resp), true);
  }

  async resetPinPad(): Promise<void> {
    await this.transport.sendReceive(buildMessage(TM.RESET_PINPAD, this.managementFields()), 15_000);
  }

  /**
   * Settlement / telecollecte (TM 010): uploads the day's batch to the NAPS host.
   * The terminal must be idle and referenced. CR 052 = already settled today.
   */
  async settlement(): Promise<SettlementResult> {
    const resp = await this.transport.sendReceive(buildSettlement(this.ncai), this.opts.paymentTimeoutMs);
    const fields = parseMessage(resp);
    const cr = fields[TAG.CR];
    if (cr === "000") {
      return { isSuccess: true, responseCode: cr, message: "Settlement accepted", date: fields[TAG.DA], time: fields[TAG.HE] };
    }
    const message =
      cr === "052" ? "Already settled today" : cr === "909" ? "Terminal or server is down" : `Settlement failed: CR=${cr}`;
    return { isSuccess: false, responseCode: cr, message };
  }

  /** Auto-discover the Ingenico Lane serial port (USB serial only). */
  static findPort(): Promise<string | null> {
    return findIngenicoPort();
  }

  /** List all available serial ports. */
  static listPorts(): Promise<PortInfo[]> {
    return listPorts();
  }
}

function maskDp(dp: string | undefined): string | undefined {
  return dp !== undefined ? maskPansInText(dp) : undefined;
}

function mapResult(fields: Record<string, string>, isApprovedFlag: boolean): PaymentResult {
  const cr = fields[TAG.CR];
  const card = fields[TAG.NCAR];
  const rawDp = fields[TAG.DP];
  // Display copies of the print block are PAN-masked; lines are parsed from the raw
  // block because masking inserts '*', the DP line-group separator.
  const dp = maskDp(rawDp);
  return {
    isSuccess: isApprovedFlag && isApproved(cr),
    isCancelled: cr === "280" || cr === "480",
    responseCode: cr,
    responseMessage: dp ?? describeResponse(cr),
    authorizationNumber: fields[TAG.NA],
    cardNumber: card ? maskPan(card) : undefined,
    // CardScheme has no dedicated v2 tag — leave undefined rather than mislabel DATR.
    cardScheme: undefined,
    stan: fields[TAG.STAN],
    approvalCode: fields[TAG.NA],
    transactionDate: fields[TAG.DA],
    transactionTime: fields[TAG.HE],
    originalTransactionDate: fields[TAG.DATR],
    originalTransactionTime: fields[TAG.HETR],
    cardExpiry: fields[TAG.DAEX],
    receiptText: dp,
    receiptLines: rawDp ? parseReceipt(rawDp) : undefined,
    cardholderName: fields[TAG.NPRT],
    entryMode: fields[TAG.EM],
    ncai: fields[TAG.NCAI],
    sequence: fields[TAG.NS],
  };
}
