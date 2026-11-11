import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOptions } from "../src/models.js";
import { createSerialTransport } from "../src/transport/serial.js";

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
  on() {}
  removeListener() {}
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

describe("serial transport disconnect", () => {
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
