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

  it("reports a confirmation timeout but keeps the approval", async () => {
    const phase1 = common("101", "000", tlv(TAG.STAN, "703062"));
    const t = new FakeTransport([
      phase1,
      async () => {
        throw new TerminalTimeoutError(1000);
      },
    ]);
    const res = await client(t).pay(12.5);
    expect(res.isSuccess).toBe(true);
    expect(res.responseMessage).toContain("Confirmation timed out");
  });
});

describe("NapsClient.cancel", () => {
  it("sends STAN + amount and accepts CR=000", async () => {
    const t = new FakeTransport([common("103", "000", tlv(TAG.STAN, "703062"))]);
    const res = await client(t).cancel("703062", 12.5);
    expect(res.isSuccess).toBe(true);
    const req = parseMessage(t.sent[0]);
    expect(req[TAG.TM]).toBe("003");
    expect(req[TAG.STAN]).toBe("703062");
    expect(req[TAG.MT]).toBe("1250");
  });

  it("accepts CR=480 (reversal accepted) as success", async () => {
    const t = new FakeTransport([common("103", "480", tlv(TAG.STAN, "703062"))]);
    const res = await client(t).cancel("703062", 12.5);
    expect(res.isSuccess).toBe(true);
    expect(res.isCancelled).toBe(true);
  });
});

describe("NapsClient.networkTest / referencing", () => {
  it("network test maps CR=000 to success", async () => {
    const t = new FakeTransport([common("109", "000")]);
    const res = await client(t).networkTest();
    expect(res.isSuccess).toBe(true);
  });

  it("referencing sends TIDE and echoes the parameter set", async () => {
    const t = new FakeTransport([common("113", "000", tlv(TAG.TIDE, "02"))]);
    const res = await client(t).referencing("02");
    expect(res.isSuccess).toBe(true);
    expect(res.parameterSet).toBe("02");
    expect(parseMessage(t.sent[0])[TAG.TIDE]).toBe("02");
  });
});
