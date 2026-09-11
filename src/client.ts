import {
  resolveOptions,
  type NapsClientOptions,
  type PaymentResult,
  type ReferencingResult,
  type ResolvedOptions,
  type TestResult,
  type TotalsResult,
} from "./models.js";
import { parseReceipt } from "./protocol/receipt.js";
import {
  TAG,
  TM,
  TIDE,
  buildCancellation,
  buildConfirmation,
  buildMessage,
  describeResponse,
  extractLastMessage,
  isApproved,
  maskPan,
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
      const confCr = parseMessage(confResp)[TAG.CR];
      const result = mapResult(payFields, true);
      if (confCr !== "000") return { ...result, responseMessage: `Confirmation failed: CR=${confCr}` };
      return result;
    } catch (e) {
      if (e instanceof TerminalTimeoutError) {
        return { ...mapResult(payFields, true), responseMessage: "Confirmation timed out" };
      }
      throw e;
    }
  }

  /** Cancel/void a payment by STAN. NapsPay v5.4.4 requires the original amount (MAD). */
  async cancel(stan: string, amountMad?: number): Promise<PaymentResult> {
    const ns = this.nextSequence();
    const amountCentimes = amountMad !== undefined ? Math.round(amountMad * 100) : undefined;
    const msg = buildCancellation(stan, { ncai: this.ncai, ns, amountCentimes });
    try {
      const resp = await this.transport.sendReceive(msg, this.opts.testTimeoutMs);
      const fields = parseMessage(extractLastMessage(resp));
      const tm = fields[TAG.TM];
      const cr = fields[TAG.CR];
      // v5.4.4: TM 103 (cancellation) or 104 (correction) with CR=000 (found) or
      // CR=480 (reversal accepted) is a successful void.
      const approved = (tm === "103" || tm === "104") && (cr === "000" || cr === "480");
      // Cancellation success is decided by TM+CR above, not by the payment-approval
      // code set, so override isSuccess directly (480 is a valid void, not an approval).
      const result = mapResult(fields, false);
      return { ...result, isSuccess: approved, isCancelled: approved || result.isCancelled };
    } catch (e) {
      if (e instanceof TerminalTimeoutError) {
        return { isSuccess: false, isCancelled: false, responseCode: "TIMEOUT", responseMessage: "Cancel request timed out" };
      }
      throw e;
    }
  }

  async networkTest(): Promise<TestResult> {
    const resp = await this.transport.sendReceive(buildMessage(TM.NETWORK_TEST), this.opts.testTimeoutMs);
    const cr = parseMessage(resp)[TAG.CR];
    return { isSuccess: cr === "000", responseCode: cr, message: cr === "000" ? "Network OK" : `Network test failed: CR=${cr}` };
  }

  /** @param tide "01" merchant (default) or "02" recharge parameter set. */
  async referencing(tide: string = TIDE.MERCHANT): Promise<ReferencingResult> {
    const msg = buildMessage(TM.REFERENCING, { extraFields: [[TAG.TIDE, tide]] });
    const resp = await this.transport.sendReceive(msg, this.opts.referencingTimeoutMs);
    const fields = parseMessage(resp);
    const cr = fields[TAG.CR];
    return { isSuccess: cr === "000", responseCode: cr, parameterSet: fields[TAG.TIDE], receiptText: fields[TAG.DP] };
  }

  async totals(): Promise<TotalsResult> {
    const resp = await this.transport.sendReceive(buildMessage(TM.TOTALS), this.opts.testTimeoutMs);
    const fields = parseMessage(resp);
    const cr = fields[TAG.CR];
    return { isSuccess: cr === "000", responseCode: cr, receiptText: fields[TAG.DP] };
  }

  async duplicateReceipt(): Promise<PaymentResult> {
    const resp = await this.transport.sendReceive(buildMessage(TM.DUPLICATE), 15_000);
    return mapResult(parseMessage(resp), false);
  }

  async resetPinPad(): Promise<void> {
    await this.transport.sendReceive(buildMessage(TM.RESET_PINPAD), 15_000);
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

function mapResult(fields: Record<string, string>, isApprovedFlag: boolean): PaymentResult {
  const cr = fields[TAG.CR];
  const card = fields[TAG.NCAR];
  const dp = fields[TAG.DP];
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
    receiptLines: dp ? parseReceipt(dp) : undefined,
    cardholderName: fields[TAG.NPRT],
  };
}
