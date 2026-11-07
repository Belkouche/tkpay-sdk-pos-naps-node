import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NapsClient } from "../src/client.js";
import type { Transport } from "../src/transport/transport.js";
import { tlv, TAG, parseMessage } from "../src/protocol/tlv.js";
import { receiptToText } from "../src/protocol/receipt.js";

/**
 * Card numbers must be masked (first 6 + last 4) the moment a reply is parsed: nothing the
 * SDK returns, sends back, throws or prints may contain the full number.
 */

const PAN = "5167940000123315";
const PAN_SPACED = "5167 9400 0012 3315";
const PAN_19 = "6200000000000000005";

/** Every way the full numbers could leak (digits only, and as printed). */
const FULL = [PAN, PAN_SPACED, PAN_19, "940000123315", "000000000000"];

function line(num: number, content: string, style = "S", align = "G"): string {
  return `030002${String(num).padStart(2, "0")}031001${style}032001${align}033${String(content.length).padStart(3, "0")}${content}`;
}

const DP = [
  line(0, "TKpay", "G", "C"),
  line(9, "VISA"),
  line(10, `CARTE ${PAN_SPACED}`),
  line(11, `REF ${PAN_19}`),
  line(12, "MONTANT: 10.00 MAD"),
  line(13, "Copie Commercant"),
].join("*");

/** The same receipt lines, as they must come out. */
const EXPECTED_LINES = [
  "TKpay",
  "VISA",
  "CARTE 5167 94** **** 3315",
  "REF 620000*********0005",
  "MONTANT: 10.00 MAD",
  "Copie Commercant",
];

function reply(tm: string, cr: string, extra = ""): string {
  return (
    tlv(TAG.TM, tm) + tlv(TAG.NCAI, "0100001") + tlv(TAG.NS, "000001") + tlv(TAG.CR, cr) +
    tlv(TAG.MT, "1000") + tlv(TAG.DE, "504") + tlv(TAG.STAN, "703062") + tlv(TAG.NCAR, PAN) +
    tlv(TAG.DAEX, "3010") + extra + "!"
  );
}

class FakeTransport implements Transport {
  isConnected = true;
  sent: string[] = [];
  constructor(private responses: string[]) {}
  async connect() {}
  disconnect() {}
  async sendReceive(message: string): Promise<string> {
    this.sent.push(message);
    const next = this.responses.shift();
    if (next === undefined) throw new Error("no scripted response");
    return next;
  }
}

function expectNoFullPan(value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const full of FULL) expect(text).not.toContain(full);
}

const client = (t: Transport) => new NapsClient({ transport: "tcp", tcpHost: "127.0.0.1" }, t);

describe("card number masking", () => {
  const logged: string[] = [];
  beforeEach(() => {
    logged.length = 0;
    const capture = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const) {
      vi.spyOn(console, level).mockImplementation(capture);
    }
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => (logged.push(String(chunk)), true));
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    expectNoFullPan(logged.join("\n")); // nothing printed may contain the full number
  });

  it("masks NCAR (007) and every card number in the DP (010) block at parse", () => {
    const fields = parseMessage(reply("101", "000", tlv(TAG.DP, DP)));
    expect(fields[TAG.NCAR]).toBe("516794******3315");
    expectNoFullPan(fields);
  });

  it("payment: no result field, receipt line or request frame contains the full number", async () => {
    const t = new FakeTransport([reply("101", "000", tlv(TAG.DP, DP)), reply("102", "000", tlv(TAG.DP, DP))]);
    const res = await client(t).pay(10);

    expect(res.isSuccess).toBe(true);
    expect(res.cardNumber).toBe("516794******3315");
    expectNoFullPan(res);
    expectNoFullPan(t.sent); // the TM 002 confirmation echoes the masked NCAR
    // Receipt lines are otherwise unchanged: same lines, same order, same text.
    expect(res.merchantReceiptLines?.map((l) => l.text)).toEqual(EXPECTED_LINES);
    expect(res.customerReceiptLines?.map((l) => l.text)).toEqual(EXPECTED_LINES);
    expect(res.merchantReceiptLines?.[0]).toMatchObject({ bold: true, alignment: "center" });
    expectNoFullPan(receiptToText(res.customerReceiptLines ?? []));
  });

  it("decline, void, duplicate, totals and referencing results never contain the full number", async () => {
    const dp = tlv(TAG.DP, DP);
    const t = new FakeTransport([
      reply("101", "116", dp),
      reply("103", "000", dp),
      reply("104", "000", dp),
      reply("108", "000", dp),
      reply("110", "000", dp),
      reply("113", "000", dp),
    ]);
    const c = client(t);
    const results = [
      await c.pay(10),
      await c.cancel("703062", 10),
      await c.duplicateReceipt("703062"),
      await c.totals(),
      await c.referencing(),
    ];
    for (const r of results) {
      expectNoFullPan(r);
      expect(r.receiptLines?.map((l) => l.text)).toEqual(EXPECTED_LINES);
    }
    expectNoFullPan(t.sent);
  });

  it("errors raised while talking to the terminal do not carry the reply", async () => {
    const t: Transport = {
      isConnected: true,
      connect: async () => {},
      disconnect: () => {},
      sendReceive: async () => {
        throw new Error("connection closed before response");
      },
    };
    const err = await client(t).networkTest().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expectNoFullPan(String(err) + (err as Error).stack);
  });
});
