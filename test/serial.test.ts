import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOptions } from "../src/models.js";
import { createSerialTransport, isPhase2 } from "../src/transport/serial.js";

const ports: FakePort[] = [];

class FakePort {
  isOpen = false;
  closeCalls: Array<((err?: Error | null) => void) | undefined> = [];
  writes: string[] = [];
  constructor() {
    ports.push(this);
  }
  open(cb: (err: Error | null) => void) {
    this.isOpen = true;
    cb(null);
  }
  close(cb?: (err?: Error | null) => void) {
    this.closeCalls.push(cb);
    this.isOpen = false;
    cb?.(null);
  }
  set(_opts: { dtr?: boolean; rts?: boolean }, cb: (err?: Error | null) => void) {
    cb(null);
  }
  dataListeners: Array<(chunk: Buffer) => void> = [];
  on(event: string, cb: (chunk: Buffer) => void) {
    if (event === "data") this.dataListeners.push(cb);
  }
  removeListener(event: string, cb: (chunk: Buffer) => void) {
    if (event === "data") this.dataListeners = this.dataListeners.filter((l) => l !== cb);
  }
  reply(frame: string) {
    for (const l of [...this.dataListeners]) l(Buffer.from(frame));
  }
  write(data: string, _enc: string, cb?: (err?: Error | null) => void) {
    this.writes.push(data);
    cb?.(null);
  }
}

vi.mock("serialport", () => ({ SerialPort: FakePort }));

describe("serial transport write", () => {
  afterEach(() => vi.useRealTimers());

  it("ends each frame with the protocol terminator", async () => {
    vi.useFakeTimers();
    for (const [protocolVersion, end] of [["v2", "!"], ["v1", "?"]] as const) {
      const t = createSerialTransport(resolveOptions({ transport: "serial", serialPath: "/dev/x", protocolVersion }));
      await t.connect();
      const sent = expect(t.sendReceive("001003002", 20)).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(40_000);
      await sent;
      expect(ports.at(-1)!.writes).toEqual([`001003002${end}`]);
    }
  });

  it("holds the first frame until the port has been open 32 s (Lane3600 answers late before that)", async () => {
    vi.useFakeTimers();
    const t = createSerialTransport(resolveOptions({ transport: "serial", serialPath: "/dev/x", protocolVersion: "v2" }));
    await t.connect();
    const port = ports.at(-1)!;
    const sent = expect(t.sendReceive("001003002", 20)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(31_900);
    expect(port.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(port.writes).toEqual(["001003002!"]);
    await vi.advanceTimersByTimeAsync(100);
    await sent;
  });
});

describe("serial transport quiet time", () => {
  afterEach(() => vi.useRealTimers());

  it("waits 3 s after a reply before a new operation, 0.5 s before a confirmation", async () => {
    vi.useFakeTimers();
    const t = createSerialTransport(resolveOptions({ transport: "serial", serialPath: "/dev/x", protocolVersion: "v2" }));
    await t.connect();
    const port = ports.at(-1)!;

    // Network test after the 32 s post-open wait, answered at once.
    const test = t.sendReceive("001003009", 5_000);
    await vi.advanceTimersByTimeAsync(32_000);
    port.reply("001003109013003000!");
    await test;

    // Lane3600: a TM 001 0.5 s after TM 109 was refused (CR 100) without a card prompt.
    const pay = t.sendReceive("001003001", 5_000);
    await vi.advanceTimersByTimeAsync(2_900);
    expect(port.writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(port.writes.at(-1)).toBe("001003001!");
    port.reply("001003101013003000!");
    await pay;

    // TM 002 is what the terminal is waiting for: 0.5 s only.
    const confirm = t.sendReceive("001003002", 5_000);
    await vi.advanceTimersByTimeAsync(400);
    expect(port.writes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(port.writes.at(-1)).toBe("001003002!");
    port.reply("001003102013003000!");
    await confirm;
  });

  it("does not cut a reply at a '!' inside receipt text", async () => {
    vi.useFakeTimers();
    const t = createSerialTransport(resolveOptions({ transport: "serial", serialPath: "/dev/x", protocolVersion: "v2" }));
    await t.connect();
    const port = ports.at(-1)!;
    const reply = t.sendReceive("001003008", 5_000);
    await vi.advanceTimersByTimeAsync(32_000);
    port.reply("001003108010014MERCI! A BIENT");  // '!' mid-frame, in the receipt
    port.reply("013003000!");
    expect(await reply).toBe("001003108010014MERCI! A BIENT013003000!");
  });

  it("treats only TM 002 and TM 004 as confirmations", () => {
    expect(isPhase2("001003002003007")).toBe(true);
    expect(isPhase2("001003004003007")).toBe(true);
    expect(isPhase2("001003001002003")).toBe(false);
    expect(isPhase2("001003003003007")).toBe(false);
    expect(isPhase2("001003009003007")).toBe(false);
  });
});

describe("serial transport disconnect", () => {
  it("closes the port after a timeout, so a late reply is never read as the next answer", async () => {
    vi.useFakeTimers();
    try {
      const t = createSerialTransport(resolveOptions({ transport: "serial", serialPath: "/dev/x", protocolVersion: "v2" }));
      await t.connect();
      const port = ports.at(-1)!;
      const sent = expect(t.sendReceive("001003002", 20)).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(40_000);
      await sent;
      expect(port.closeCalls).toHaveLength(1);
      expect(t.isConnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes an open port with a callback, so close errors are never emitted unhandled", async () => {
    const t = createSerialTransport(resolveOptions({ transport: "serial", serialPath: "/dev/x" }));
    await t.connect();
    t.disconnect();
    const port = ports.at(-1)!;
    expect(port.closeCalls).toHaveLength(1);
    expect(port.closeCalls[0]).toBeTypeOf("function");
  });

  it("does not close a port that is already gone (USB unplugged)", async () => {
    const t = createSerialTransport(resolveOptions({ transport: "serial", serialPath: "/dev/x", protocolVersion: "v2" }));
    await t.connect();
    const port = ports.at(-1)!;
    port.isOpen = false; // the OS dropped the device
    expect(() => t.disconnect()).not.toThrow();
    expect(port.closeCalls).toHaveLength(0);
  });
});
