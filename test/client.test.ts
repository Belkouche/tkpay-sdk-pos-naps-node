import { describe, it, expect } from "vitest";
import { NapsClient } from "../src/client.js";
import type { Transport } from "../src/transport/transport.js";
import { TerminalTimeoutError } from "../src/transport/transport.js";
import { tlv, TAG, parseMessage } from "../src/protocol/tlv.js";

/** A scripted transport: each sendReceive returns the next queued response and records the request. */
class FakeTransport implements Transport {
  isConnected = false;
  sent: string[] = [];
  private responses: Array<string | (() => Promise<string>)>;
  constructor(responses: Array<string | (() => Promise<string>)>) {
    this.responses = responses;
  }
  async connect() {
    this.isConnected = true;
  }
  disconnect() {
    this.isConnected = false;
  }
  async sendReceive(message: string): Promise<string> {
    this.sent.push(message);
    const next = this.responses.shift();
    if (next === undefined) throw new Error("FakeTransport: no scripted response left");
    return typeof next === "function" ? next() : next;
  }
}

function common(tm: string, cr: string, extra = ""): string {
  return (
    tlv(TAG.TM, tm) + tlv(TAG.NCAI, "0100001") + tlv(TAG.NS, "000001") +
    tlv(TAG.CR, cr) + tlv(TAG.MT, "1250") + tlv(TAG.DE, "504") +
    tlv(TAG.DA, "11092026") + tlv(TAG.HE, "133441") + extra
  );
}

function client(t: Transport): NapsClient {
  return new NapsClient({ transport: "tcp", tcpHost: "127.0.0.1" }, t);
}

describe("NapsClient.pay", () => {
  it("runs the two-phase flow and returns success", async () => {
    const phase1 = common("101", "000", tlv(TAG.STAN, "703062") + tlv(TAG.NCAR, "516794******3315") + tlv(TAG.DAEX, "3010"));
    const phase2 = common("102", "000", tlv(TAG.STAN, "703062"));
    const t = new FakeTransport([phase1, phase2]);
    const res = await client(t).pay(12.5);

    expect(res.isSuccess).toBe(true);
    expect(res.responseCode).toBe("000");
    expect(res.stan).toBe("703062");
    expect(res.cardNumber).toBe("516794******3315");

    // Phase 1 is a TM 001 payment with MT=1250.
    const p1 = parseMessage(t.sent[0]);
    expect(p1[TAG.TM]).toBe("001");
    expect(p1[TAG.MT]).toBe("1250");

    // Phase 2 confirmation echoes MT/NCAR/DAEX per §4.2.
    const p2 = parseMessage(t.sent[1]);
    expect(p2[TAG.TM]).toBe("002");
    expect(p2[TAG.MT]).toBe("1250");
    expect(p2[TAG.NCAR]).toBe("516794******3315");
    expect(p2[TAG.DAEX]).toBe("3010");
    expect(p2[TAG.STAN]).toBe("703062");
  });

  it("returns the Phase-2 customer receipt and EM/NCAI/NS from the response", async () => {
    const merchantDp = "03000201031001S032001C033008MERCHANT";
    const customerDp = "03000201031001S032001C033008CUSTOMER";
    const phase1 = common("101", "000", tlv(TAG.STAN, "703062") + tlv(TAG.EM, "CC") + tlv(TAG.DP, merchantDp));
    const phase2 = common("102", "000", tlv(TAG.STAN, "703062") + tlv(TAG.DP, customerDp));
    const res = await client(new FakeTransport([phase1, phase2])).pay(12.5);

    expect(res.receiptLines?.[0].text).toBe("MERCHANT");
    expect(res.merchantReceiptText).toBe(merchantDp);
    expect(res.merchantReceiptLines?.[0].text).toBe("MERCHANT");
    expect(res.customerReceiptText).toBe(customerDp);
    expect(res.customerReceiptLines?.[0].text).toBe("CUSTOMER");
    expect(res.entryMode).toBe("CC");
    expect(res.ncai).toBe("0100001");
    expect(res.sequence).toBe("000001");
  });

  it("never exposes a full PAN from NCAR or the print block", async () => {
    const dp = "03000201031001S032001G033022CARTE 5167941234563315";
    const phase1 = common("101", "000", tlv(TAG.STAN, "703062") + tlv(TAG.NCAR, "5167941234563315") + tlv(TAG.DP, dp));
    const t = new FakeTransport([phase1, common("102", "000")]);
    const res = await client(t).pay(12.5);

    expect(res.cardNumber).toBe("516794******3315");
    expect(res.receiptText).not.toContain("5167941234563315");
    expect(res.receiptLines?.[0].text).toBe("CARTE 516794******3315");
    expect(parseMessage(t.sent[1])[TAG.NCAR]).toBe("516794******3315");
  });

  it("reports a refused confirmation (TM 102 CR≠000) as a failure", async () => {
    const phase1 = common("101", "000", tlv(TAG.STAN, "703062"));
    const t = new FakeTransport([phase1, common("102", "482", tlv(TAG.STAN, "703062"))]);
    const res = await client(t).pay(12.5);
    expect(res.isSuccess).toBe(false);
    expect(res.responseCode).toBe("482");
    expect(res.responseMessage).toContain("Transaction already cancelled");
  });

  it("returns a decline without confirming", async () => {
    const t = new FakeTransport([common("101", "116", tlv(TAG.STAN, "000001"))]);
    const res = await client(t).pay(12.5);
    expect(res.isSuccess).toBe(false);
    expect(res.responseCode).toBe("116");
    expect(res.responseMessage).toContain("Insufficient funds");
    expect(t.sent).toHaveLength(1); // no phase 2
  });

  it("maps a payment timeout", async () => {
    const t = new FakeTransport([
      async () => {
        throw new TerminalTimeoutError(1000);
      },
    ]);
    const res = await client(t).pay(1);
    expect(res.isSuccess).toBe(false);
    expect(res.responseCode).toBe("TIMEOUT");
  });

  it("reports a confirmation timeout as declined, keeping the STAN", async () => {
    const phase1 = common("101", "000", tlv(TAG.STAN, "703062"));
    const t = new FakeTransport([
      phase1,
      async () => {
        throw new TerminalTimeoutError(1000);
      },
    ]);
    const res = await client(t).pay(12.5);
    expect(res.isSuccess).toBe(false);
    expect(res.responseCode).toBe("TIMEOUT");
    expect(res.stan).toBe("703062");
    expect(res.responseMessage).toContain("result unknown");
  });

  it("reports an approval without a STAN as declined, without confirming", async () => {
    const t = new FakeTransport([common("101", "000")]);
    const res = await client(t).pay(12.5);
    expect(res.isSuccess).toBe(false);
    expect(res.responseCode).toBe("INVALID_RESPONSE");
    expect(t.sent).toHaveLength(1);
  });
});

describe("NapsClient.cancel", () => {
  it("sends STAN + amount and accepts CR=000", async () => {
    const t = new FakeTransport([common("103", "000", tlv(TAG.STAN, "703062")), common("104", "000")]);
    const res = await client(t).cancel("703062", 12.5);
    expect(res.isSuccess).toBe(true);
    const req = parseMessage(t.sent[0]);
    expect(req[TAG.TM]).toBe("003");
    expect(req[TAG.STAN]).toBe("703062");
    expect(req[TAG.MT]).toBe("1250");
  });

  it("completes the two-phase void: TM 004 after TM 103, void STAN + customer receipt from TM 104", async () => {
    const merchantDp = "03000201031001S032001C033008MERCHANT";
    const customerDp = "03000201031001S032001C033008CUSTOMER";
    const t = new FakeTransport([
      common("103", "000", tlv(TAG.STAN, "703062") + tlv(TAG.DP, merchantDp)),
      common("104", "000", tlv(TAG.STAN, "900001") + tlv(TAG.DP, customerDp)),
    ]);
    const res = await client(t).cancel("703062", 12.5, "000003");

    expect(res).toMatchObject({ isSuccess: true, isCancelled: true, stan: "900001" });
    expect(res.receiptLines?.[0].text).toBe("MERCHANT");
    expect(res.merchantReceiptLines?.[0].text).toBe("MERCHANT");
    expect(res.customerReceiptLines?.[0].text).toBe("CUSTOMER");

    const [p1, p2] = t.sent.map(parseMessage);
    expect(p2[TAG.TM]).toBe("004");
    expect(p2[TAG.NCAI]).toBe(p1[TAG.NCAI]);
    expect(p2[TAG.STAN]).toBe("703062");
  });

  it("returns the TM 104 receipt as the merchant copy when TM 103 has none (Ingenico Lane3600)", async () => {
    const voidDp = "03000201031001S032001C033010ANNULATION";
    const t = new FakeTransport([
      common("103", "000", tlv(TAG.STAN, "000182")),
      common("104", "000", tlv(TAG.STAN, "000182") + tlv(TAG.DP, voidDp)),
    ]);
    const res = await client(t).cancel("000182", 1);

    expect(res).toMatchObject({ isSuccess: true, isCancelled: true });
    expect(res.receiptLines?.[0].text).toBe("ANNULATION");
    expect(res.merchantReceiptLines?.[0].text).toBe("ANNULATION");
    expect(res.customerReceiptLines).toBeUndefined();
  });

  it("TM 004 carries the TM 003 sequence in NS (not NSA) and echoes MT/DE/DATR/HETR from TM 103", async () => {
    const t = new FakeTransport([
      common("103", "000", tlv(TAG.STAN, "703062") + tlv(TAG.DATR, "10092026") + tlv(TAG.HETR, "101500")),
      common("104", "000"),
    ]);
    // TM 003 asks for 12.50 but TM 103 reports MT=1250 — the echoed value is what's sent.
    await client(t).cancel("703062", 99, "000003");
    const [p1, p2] = t.sent.map(parseMessage);
    expect(p2[TAG.NS]).toBe(p1[TAG.NS]);
    expect(p2[TAG.NSA]).toBeUndefined();
    expect(p2[TAG.MT]).toBe("1250");
    expect(p2[TAG.DE]).toBe("504");
    expect(p2[TAG.DATR]).toBe("10092026");
    expect(p2[TAG.HETR]).toBe("101500");
  });

  it("fails closed when TM 104 never arrives: pending, keeping STAN and the TM 103 merchant receipt", async () => {
    const merchantDp = "03000201031001S032001C033008MERCHANT";
    const t = new FakeTransport([
      common("103", "000", tlv(TAG.STAN, "703062") + tlv(TAG.DP, merchantDp)),
      async () => {
        throw new TerminalTimeoutError(1000);
      },
    ]);
    const res = await client(t).cancel("703062", 12.5);
    expect(res).toMatchObject({ isSuccess: false, isCancelled: false, isPending: true, stan: "703062", responseCode: "TIMEOUT" });
    expect(res.receiptLines?.[0].text).toBe("MERCHANT");
    expect(res.merchantReceiptLines?.[0].text).toBe("MERCHANT");
    expect(res.customerReceiptLines).toBeUndefined();
  });

  it("treats TM 104 CR=995 as pending, not success and not a hard failure", async () => {
    const t = new FakeTransport([common("103", "000", tlv(TAG.STAN, "703062")), common("104", "995")]);
    const res = await client(t).cancel("703062", 12.5);
    expect(res).toMatchObject({ isSuccess: false, isCancelled: false, isPending: true, stan: "703062", responseCode: "995" });
  });

  it("accepts TM 104 CR=480 as a completed void", async () => {
    const t = new FakeTransport([common("103", "000", tlv(TAG.STAN, "703062")), common("104", "480")]);
    const res = await client(t).cancel("703062", 12.5);
    expect(res).toMatchObject({ isSuccess: true, isCancelled: true, responseCode: "480" });
    expect(res.isPending).toBeUndefined();
  });

  it("fails when TM 104 refuses the cancellation confirmation", async () => {
    const t = new FakeTransport([common("103", "000", tlv(TAG.STAN, "703062")), common("104", "482")]);
    const res = await client(t).cancel("703062", 12.5);
    expect(res).toMatchObject({ isSuccess: false, isCancelled: false, responseCode: "482" });
    expect(res.isPending).toBeUndefined();
  });

  it("does not send TM 004 when the terminal answers TM 003 directly with TM 104", async () => {
    const t = new FakeTransport([common("104", "000", tlv(TAG.STAN, "703062"))]);
    expect((await client(t).cancel("703062", 12.5)).isSuccess).toBe(true);
    expect(t.sent).toHaveLength(1);
  });

  it("does not send TM 004 after a refused TM 103", async () => {
    const t = new FakeTransport([common("103", "302")]);
    expect((await client(t).cancel("703062", 12.5)).isSuccess).toBe(false);
    expect(t.sent).toHaveLength(1);
  });

  it("sends the original sequence as NSA (005) when given", async () => {
    const t = new FakeTransport([common("104", "000", tlv(TAG.STAN, "703062"))]);
    const res = await client(t).cancel("703062", 12.5, "000003");
    expect(res.isSuccess).toBe(true); // TM 104 (v5.4.4 correction) is a successful void
    expect(parseMessage(t.sent[0])[TAG.NSA]).toBe("000003");
  });

  it("treats TM 103 CR=480 as a failure without TM 004 (480 completes only on TM 104)", async () => {
    const t = new FakeTransport([common("103", "480", tlv(TAG.STAN, "703062"))]);
    const res = await client(t).cancel("703062", 12.5);
    expect(res.isSuccess).toBe(false);
    expect(t.sent).toHaveLength(1);
  });
});

describe("NapsClient.networkTest / referencing", () => {
  it("network test maps CR=000 to success (USB serial)", async () => {
    const t = new FakeTransport([common("109", "000")]);
    const res = await new NapsClient({ transport: "serial", serialPath: "/dev/x" }, t).networkTest();
    expect(res.isSuccess).toBe(true);
  });

  it("network test over TCP sends nothing and returns UNSUPPORTED (Sunmi NapsPay answers 902)", async () => {
    const t = new FakeTransport([common("109", "000")]);
    const res = await client(t).networkTest();
    expect(res.isSuccess).toBe(false);
    expect(res.responseCode).toBe("UNSUPPORTED");
    expect(t.sent).toHaveLength(0);
  });

  it("referencing sends TIDE and echoes the parameter set", async () => {
    const t = new FakeTransport([common("113", "000", tlv(TAG.TIDE, "02"))]);
    const res = await client(t).referencing("02");
    expect(res.isSuccess).toBe(true);
    expect(res.parameterSet).toBe("02");
    expect(parseMessage(t.sent[0])[TAG.TIDE]).toBe("02");
  });

  it("referencing falls back to the requested TIDE when not echoed", async () => {
    const t = new FakeTransport([common("113", "000")]);
    expect((await client(t).referencing("02")).parameterSet).toBe("02");
  });
});

describe("NapsClient management operations", () => {
  it("send the client's NCAI and a fresh sequence number", async () => {
    const t = new FakeTransport([common("109", "000"), common("110", "000"), common("112", "000")]);
    const c = new NapsClient({ transport: "serial", serialPath: "/dev/x", registerId: "02", cashierId: "00005" }, t);
    await c.networkTest();
    await c.totals();
    await c.resetPinPad();
    const sent = t.sent.map(parseMessage);
    expect(sent.map((f) => f[TAG.NCAI])).toEqual(["0200005", "0200005", "0200005"]);
    expect(sent.map((f) => f[TAG.NS])).toEqual(["000001", "000002", "000003"]);
  });

  it("duplicateReceipt targets a STAN when given (v2 §4.6)", async () => {
    const t = new FakeTransport([common("108", "000"), common("108", "000")]);
    const c = client(t);
    await c.duplicateReceipt("703062");
    await c.duplicateReceipt();
    expect(parseMessage(t.sent[0])[TAG.STAN]).toBe("703062");
    expect(parseMessage(t.sent[1])[TAG.STAN]).toBeUndefined();
  });

  it("duplicateReceipt reports success on CR=000", async () => {
    const t = new FakeTransport([common("108", "000", tlv(TAG.STAN, "703062"))]);
    const res = await client(t).duplicateReceipt();
    expect(res.isSuccess).toBe(true);
    expect(res.stan).toBe("703062");
  });
});

describe("NapsClient totals / referencing receipt masking", () => {
  it("masks PANs in the totals and referencing receipt text", async () => {
    const dp = "03000201031001S032001G033022CARTE 5167941234563315";
    const t = new FakeTransport([common("110", "000", tlv(TAG.DP, dp)), common("113", "000", tlv(TAG.DP, dp))]);
    const c = client(t);
    expect((await c.totals()).receiptText).toContain("516794******3315");
    expect((await c.referencing()).receiptText).not.toContain("5167941234563315");
  });

  it("parses the totals and referencing receipts into lines", async () => {
    const dp = "03000201031001G032001C033006TOTAUX*03000202031001S032001G033007TOTAL 2";
    const t = new FakeTransport([common("110", "000", tlv(TAG.DP, dp)), common("113", "000", tlv(TAG.DP, dp))]);
    const c = client(t);
    expect((await c.totals()).receiptLines?.map((l) => l.text)).toEqual(["TOTAUX", "TOTAL 2"]);
    expect((await c.referencing()).receiptLines?.[0]).toMatchObject({ text: "TOTAUX", bold: true, alignment: "center" });
  });

  it("returns a decline receipt as sent, with no merchant/customer copy", async () => {
    const dp = "03000221031001G032001C033019TRANSACTION REFUSEE";
    const res = await client(new FakeTransport([common("101", "116", tlv(TAG.DP, dp))])).pay(12.5);
    expect(res.receiptLines?.[0].text).toBe("TRANSACTION REFUSEE");
    expect(res.merchantReceiptLines).toBeUndefined();
  });
});

describe("NapsClient.settlement", () => {
  it("sends TM 010 without a sequence and maps CR=000 with date/time", async () => {
    const t = new FakeTransport([common("110", "000")]);
    const res = await client(t).settlement();
    expect(res).toMatchObject({ isSuccess: true, responseCode: "000", date: "11092026", time: "133441" });
    const req = parseMessage(t.sent[0]);
    expect(req[TAG.TM]).toBe("010");
    expect(req[TAG.NCAI]).toBe("0100001");
    expect(req[TAG.NS]).toBeUndefined();
  });

  it("maps CR=052 to 'already settled today'", async () => {
    const res = await client(new FakeTransport([common("110", "052")])).settlement();
    expect(res.isSuccess).toBe(false);
    expect(res.message).toBe("Already settled today");
  });
});
