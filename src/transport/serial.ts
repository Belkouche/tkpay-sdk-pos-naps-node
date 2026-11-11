import type { ResolvedOptions } from "../models.js";
import { findIngenicoPort } from "../discovery.js";
import { TerminalTimeoutError, type Transport } from "./transport.js";

/**
 * USB serial transport for Ingenico Lane terminals. Uses the optional `serialport`
 * package (native), lazy-loaded so the SDK installs and the TCP path works without it.
 *
 * NAPS TLV generation is selectable via `protocolVersion` ("v1" | "v2"): v1 terminals
 * terminate responses with '?', v2 (NapsPay v5.4.4+) with '!'.
 */

/** Minimal structural type for the bit of `serialport` we use (avoids a hard type dep). */
interface SerialPortLike {
  isOpen: boolean;
  open(cb: (err: Error | null) => void): void;
  close(cb?: (err?: Error | null) => void): void;
  set(opts: { dtr?: boolean; rts?: boolean }, cb: (err?: Error | null) => void): void;
  write(data: string, encoding: string, cb?: (err?: Error | null) => void): void;
  on(event: "data", cb: (chunk: Buffer) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  removeListener(event: string, cb: (...args: unknown[]) => void): void;
}
type SerialPortCtor = new (opts: { path: string; baudRate: number; autoOpen: boolean; hupcl: boolean }) => SerialPortLike;

async function loadSerialPort(): Promise<SerialPortCtor> {
  try {
    const mod = (await import("serialport")) as { SerialPort: SerialPortCtor };
    return mod.SerialPort;
  } catch {
    throw new Error(
      "The 'serialport' package is required for the USB serial transport. Install it with: npm install serialport",
    );
  }
}

/** Quiet time kept between the terminal's last byte and our next frame. */
const SETTLE_MS = 500;

/**
 * The Ingenico Lane3600 holds back every answer until ~30 s after the port opens: the first
 * frame's reply always landed at 30.1 s. A TM 101 delayed that way reached us after the
 * terminal had given up waiting for TM 002 ("attente validation caisse" timeout), so the
 * payment was never recorded. Frames sent once the port has been open this long answer
 * normally (TM 008 in 3–7 s), so the first frame waits for it. Keep the client connected
 * between transactions to pay this once.
 */
const READY_MS = 32_000;

export class SerialTransport implements Transport {
  private port: SerialPortLike | null = null;
  private lastRxAt = 0;
  private openedAt = 0;
  /** Explicit path, or undefined to auto-discover the Ingenico port on connect. */
  private path: string | undefined;
  private readonly baudRate: number;
  private readonly terminator: string;

  constructor(opts: ResolvedOptions) {
    this.path = opts.serialPath; // may be undefined → discovered on connect
    this.baudRate = opts.serialBaudRate;
    this.terminator = opts.protocolVersion === "v1" ? "?" : "!";
  }

  get isConnected(): boolean {
    return this.port !== null && this.port.isOpen;
  }

  async connect(): Promise<void> {
    if (!this.path) {
      const found = await findIngenicoPort();
      if (!found) {
        throw new Error(
          "No Ingenico serial port found. Pass serialPath explicitly, or check the terminal is connected.",
        );
      }
      this.path = found;
    }
    const SerialPort = await loadSerialPort();
    // DTR/RTS asserted and never dropped on close (hupcl: false).
    const port = new SerialPort({ path: this.path, baudRate: this.baudRate, autoOpen: false, hupcl: false });
    await new Promise<void>((resolve, reject) => {
      port.open((err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      port.set({ dtr: true, rts: true }, (err) => (err ? reject(err) : resolve()));
    });
    this.port = port;
    this.openedAt = Date.now();
  }

  disconnect(): void {
    // The port may already be gone (USB unplugged, terminal rebooted). Closing with a callback
    // keeps serialport from emitting an unhandled 'error' that would crash the process.
    if (this.port?.isOpen) this.port.close(() => {});
    this.port = null;
  }

  async sendReceive(message: string, timeoutMs: number): Promise<string> {
    if (!this.port) await this.connect();
    const port = this.port;
    if (!port) throw new Error("serial port not open");

    const wait = Math.max(this.openedAt + READY_MS, this.lastRxAt + SETTLE_MS) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    return new Promise<string>((resolve, reject) => {
      let buf = "";
      let drainTimer: NodeJS.Timeout | null = null;
      const overall = setTimeout(() => finish(new TerminalTimeoutError(timeoutMs)), timeoutMs);

      const onData = (chunk: Buffer) => {
        this.lastRxAt = Date.now();
        buf += chunk.toString("utf8");
        let idx = buf.indexOf(this.terminator);
        // A chunk ending in the other generation's terminator also ends the frame, so a
        // v1/v2 mismatch skips the 1s silence fallback (matches the canonical C# reader).
        if (idx < 0 && /[!?]$/.test(buf)) idx = buf.length - 1;
        if (idx >= 0) {
          finish(null, buf.slice(0, idx + 1));
        } else {
          if (drainTimer) clearTimeout(drainTimer);
          drainTimer = setTimeout(() => finish(null, buf), 1000);
        }
      };
      const onErr = (err: Error) => finish(err);

      const cleanup = () => {
        clearTimeout(overall);
        if (drainTimer) clearTimeout(drainTimer);
        port.removeListener("data", onData as (...a: unknown[]) => void);
        port.removeListener("error", onErr as (...a: unknown[]) => void);
      };
      const finish = (err: Error | null, value?: string) => {
        cleanup();
        if (err) {
          // A reply that comes after a timeout or error must not be read as the answer to the
          // next request: close the port so the next call opens a fresh one.
          this.disconnect();
          reject(err);
        } else resolve(value!);
      };

      port.on("data", onData);
      port.on("error", onErr);
      // Frames end with the terminator, as in the diagnostic session that worked on the Lane3600.
      const frame = message.endsWith(this.terminator) ? message : message + this.terminator;
      port.write(frame, "utf8", (err) => {
        if (err) finish(err);
      });
    });
  }
}

/** Factory kept separate so `client.ts` can import it without a static serialport dep. */
export function createSerialTransport(opts: ResolvedOptions): Transport {
  return new SerialTransport(opts);
}
