import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { existsSync } from "node:fs";
import { NapsClient, receiptToText, type ReceiptLine } from "../src/index.js";

/**
 * Integration tests against the Python NAPS terminal emulator (tkpay-naps-emulator).
 * The emulator is spawned per-suite; if it is not present on disk, the suite is skipped.
 */

const EMULATOR = process.env.NAPS_EMULATOR ?? "../tkpay-naps-emulator/naps_emulator.py";
const PORT = Number(process.env.NAPS_EMULATOR_PORT ?? 4471);
const HOST = "127.0.0.1";

function waitForPort(port: number, host: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const s = net.connect(port, host);
      s.once("connect", () => {
        s.destroy();
        resolve();
      });
      s.once("error", () => {
        s.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error("emulator did not start"));
        else setTimeout(tryConnect, 100);
      });
    };
    tryConnect();
  });
}

function newClient(): NapsClient {
  return new NapsClient({ transport: "tcp", tcpHost: HOST, tcpPort: PORT });
}

const hasEmulator = existsSync(EMULATOR);
const suite = hasEmulator ? describe : describe.skip;

/** Run the emulator with `args` for the enclosing suite; suites share PORT, one at a time. */
function useEmulator(args: string[] = []): void {
  let emu: ChildProcess;

  beforeAll(async () => {
    emu = spawn("python3", [EMULATOR, "--port", String(PORT), ...args], { stdio: "ignore" });
    await waitForPort(PORT, HOST);
  });

  afterAll(async () => {
    if (!emu || emu.exitCode !== null) return;
    const exited = new Promise((resolve) => emu.once("exit", resolve));
    emu.kill();
    await exited;
  });
}

suite("NapsClient ⇄ emulator (TCP, v2)", () => {
  useEmulator();

  it("network test is not sent over TCP", async () => {
    const res = await newClient().networkTest();
    expect(res.isSuccess).toBe(false);
    expect(res.responseCode).toBe("UNSUPPORTED");
  });

  it("completes a two-phase payment", async () => {
    const res = await newClient().pay(12.5);
    expect(res.isSuccess).toBe(true);
    expect(res.responseCode).toBe("000");
    expect(res.stan).toBeTruthy();
    expect(res.cardNumber).toBe("516794******3315");
    expect(res.receiptLines?.length).toBeGreaterThan(0);
  });

  it("returns the Phase-2 customer receipt and entry mode", async () => {
    const res = await newClient().pay(15);
    expect(res.isSuccess).toBe(true);
    expect(res.customerReceiptLines?.length).toBeGreaterThan(0);
    expect(res.entryMode).toBe("CC");
  });

  it("settlement (TM 010) is accepted", async () => {
    const res = await newClient().settlement();
    expect(res.isSuccess).toBe(true);
    expect(res.responseCode).toBe("000");
  });

  it("duplicate receipt succeeds", async () => {
    const res = await newClient().duplicateReceipt();
    expect(res.isSuccess).toBe(true);
  });

  it("cancels a payment by STAN with amount", async () => {
    const c = newClient();
    const pay = await c.pay(9);
    expect(pay.isSuccess).toBe(true);
    const cancel = await newClient().cancel(pay.stan!, 9);
    expect(cancel.isSuccess).toBe(true);
  });

  it("completes the two-phase void (TM 003 → 103, TM 004 → 104) without waiting on a timeout", async () => {
    const pay = await newClient().pay(20);
    expect(pay.isSuccess).toBe(true);

    const t0 = Date.now();
    const cancel = await newClient().cancel(pay.stan!, 20, pay.sequence);
    // TM 103/104 may carry no terminator (live v5.4.4), costing ~1 s of silence framing
    // per phase; a stalled TM 004 would take the full 40 s confirmation timeout.
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(cancel).toMatchObject({ isSuccess: true, isCancelled: true, responseCode: "000" });
    // Live terminals: TM 103 has no receipt; the TM 104 receipt is the merchant copy.
    expect(cancel.merchantReceiptLines?.length).toBeGreaterThan(0);
    expect(cancel.customerReceiptLines).toBeUndefined();
    expect(cancel.stan).toMatch(/^\d{6}$/); // void STAN from TM 104
  });

  it("referencing echoes the recharge parameter set", async () => {
    const res = await newClient().referencing("02");
    expect(res.isSuccess).toBe(true);
    expect(res.parameterSet).toBe("02");
  });

  it("responds fast (no drain delay → '!' terminator honoured)", async () => {
    const t0 = Date.now();
    await newClient().totals();
    expect(Date.now() - t0).toBeLessThan(800); // would be >1000ms if it hit the drain fallback
  });
});

/** Render a receipt, trim each line, and replace the per-transaction values with placeholders. */
function normalized(lines: ReceiptLine[] | undefined): string[] {
  return receiptToText(lines ?? [])
    .split("\n")
    .map((l) => l.trim())
    .map((l) =>
      l
        .replace(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/, "<DATE>")
        .replace(/^(Transaction|Autorisation|STAN): \d+$/, "$1: <N>"),
    );
}

function goldenReceipt(amount: string, ...tail: string[]): string[] {
  const sep = "--------------------------------";
  return [
    "TKpay", sep, "<DATE>", "TKPAY DEMO", "CASABLANCA", sep, "VISA", "516794******3315",
    "Terminal: 00000001", "Transaction: <N>", "Autorisation: <N>", "STAN: <N>", sep,
    `MONTANT: ${amount} MAD`, sep, ...tail,
  ];
}

suite("NapsClient ⇄ emulator receipts (golden)", () => {
  useEmulator();

  it("payment: merchant copy (TM 101) and customer copy (TM 102)", async () => {
    const res = await newClient().pay(10);
    expect(res.isSuccess).toBe(true);
    expect(normalized(res.merchantReceiptLines)).toEqual(goldenReceipt("10.00", "DEBIT", "Copie Commerçant"));
    expect(normalized(res.customerReceiptLines)).toEqual(goldenReceipt("10.00", "DEBIT", "Copie Client"));
  });

  it("void: the TM 104 receipt is the merchant copy (TM 103 has none, as on live terminals)", async () => {
    const pay = await newClient().pay(10);
    const res = await newClient().cancel(pay.stan!, 10, pay.sequence);
    expect(res.isSuccess).toBe(true);
    expect(normalized(res.merchantReceiptLines)).toEqual(goldenReceipt("10.00", "ANNULATION", "Copie Commerçant"));
    expect(res.customerReceiptLines).toBeUndefined();
  });
});

suite("NapsClient ⇄ emulator --mode decline", () => {
  useEmulator(["--mode", "decline"]);

  it("returns the Phase-1 decline without confirming", async () => {
    const res = await newClient().pay(12.5);
    expect(res).toMatchObject({ isSuccess: false, responseCode: "100" });
  });
});

suite("NapsClient ⇄ emulator --mode error --code 116", () => {
  useEmulator(["--mode", "error", "--code", "116"]);

  it("maps the supplied decline code", async () => {
    const res = await newClient().pay(12.5);
    expect(res).toMatchObject({ isSuccess: false, responseCode: "116" });
  });
});

for (const code of ["302", "482"]) {
  suite(`NapsClient ⇄ emulator --mode confirm_error --code ${code}`, () => {
    useEmulator(["--mode", "confirm_error", "--code", code]);

    it("reports the refused TM 102 confirmation as a failure", async () => {
      const res = await newClient().pay(12.5);
      expect(res.isSuccess).toBe(false);
      expect(res.responseCode).toBe(code);
    });
  });
}

/** Pay, then void that payment on a fresh connection (TM 003 → 103, TM 004 → 104). */
async function payThenVoid(client = newClient()) {
  const pay = await newClient().pay(20);
  expect(pay.isSuccess).toBe(true);
  const cancel = await client.cancel(pay.stan!, 20, pay.sequence);
  return { pay, cancel };
}

suite("NapsClient ⇄ emulator --mode void_480", () => {
  useEmulator(["--mode", "void_480"]);

  it("TM 104 CR=480 completes the void", async () => {
    const { cancel } = await payThenVoid();
    expect(cancel).toMatchObject({ isSuccess: true, isCancelled: true, responseCode: "480" });
    expect(cancel.isPending).toBeUndefined();
  });
});

for (const mode of ["void_995", "void_no_confirm"]) {
  suite(`NapsClient ⇄ emulator --mode ${mode}`, () => {
    useEmulator(["--mode", mode]);

    it("fails closed: pending, keeping the STAN", async () => {
      // Short confirmation timeout so void_no_confirm doesn't wait the full 40 s.
      const c = new NapsClient({ transport: "tcp", tcpHost: HOST, tcpPort: PORT, confirmationTimeoutMs: 3000 });
      const { pay, cancel } = await payThenVoid(c);
      expect(cancel).toMatchObject({
        isSuccess: false,
        isCancelled: false,
        isPending: true,
        stan: pay.stan,
        responseCode: mode === "void_995" ? "995" : "TIMEOUT",
      });
      expect(cancel.receiptLines).toBeUndefined(); // TM 103 carries no receipt on live terminals
    });
  });
}

for (const code of ["302", "482"]) {
  suite(`NapsClient ⇄ emulator --mode void_refuse --code ${code}`, () => {
    useEmulator(["--mode", "void_refuse", "--code", code]);

    it("a refused TM 103 fails the void, not pending", async () => {
      const { cancel } = await payThenVoid();
      expect(cancel).toMatchObject({ isSuccess: false, isCancelled: false, responseCode: code });
      expect(cancel.isPending).toBeUndefined();
    });
  });
}
