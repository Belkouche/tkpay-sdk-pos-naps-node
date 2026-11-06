import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { existsSync } from "node:fs";
import { NapsClient } from "../src/index.js";

/**
 * Integration tests against the Python NAPS terminal emulator (tkpay-naps-emulator).
 * The emulator is spawned per-suite; if it is not present on disk, the suite is skipped.
 */

const EMULATOR = "/Users/belkouche/Projects/tkpay/tkpay-naps-emulator/naps_emulator.py";
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

suite("NapsClient ⇄ emulator (TCP, v2)", () => {
  let emu: ChildProcess;

  beforeAll(async () => {
    emu = spawn("python3", [EMULATOR, "--port", String(PORT)], { stdio: "ignore" });
    await waitForPort(PORT, HOST);
  });

  afterAll(() => {
    emu?.kill();
  });

  it("network test succeeds", async () => {
    const res = await newClient().networkTest();
    expect(res.isSuccess).toBe(true);
    expect(res.responseCode).toBe("000");
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

  it("referencing echoes the recharge parameter set", async () => {
    const res = await newClient().referencing("02");
    expect(res.isSuccess).toBe(true);
    expect(res.parameterSet).toBe("02");
  });

  it("responds fast (no drain delay → '!' terminator honoured)", async () => {
    const t0 = Date.now();
    await newClient().networkTest();
    expect(Date.now() - t0).toBeLessThan(800); // would be >1000ms if it hit the drain fallback
  });
});
