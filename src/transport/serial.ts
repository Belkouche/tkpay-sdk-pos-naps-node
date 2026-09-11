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
  write(data: string, encoding: string, cb?: (err?: Error | null) => void): void;
  on(event: "data", cb: (chunk: Buffer) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  removeListener(event: string, cb: (...args: unknown[]) => void): void;
}
type SerialPortCtor = new (opts: { path: string; baudRate: number; autoOpen: boolean }) => SerialPortLike;

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

export class SerialTransport implements Transport {
  private port: SerialPortLike | null = null;
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
    const port = new SerialPort({ path: this.path, baudRate: this.baudRate, autoOpen: false });
    await new Promise<void>((resolve, reject) => {
      port.open((err) => (err ? reject(err) : resolve()));
    });
    this.port = port;
  }

  disconnect(): void {
    this.port?.close();
    this.port = null;
  }

  async sendReceive(message: string, timeoutMs: number): Promise<string> {
    if (!this.port) await this.connect();
    const port = this.port;
    if (!port) throw new Error("serial port not open");

    return new Promise<string>((resolve, reject) => {
      let buf = "";
      let drainTimer: NodeJS.Timeout | null = null;
      const overall = setTimeout(() => finish(new TerminalTimeoutError(timeoutMs)), timeoutMs);

      const onData = (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const idx = buf.indexOf(this.terminator);
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
        if (err) reject(err);
        else resolve(value!);
      };

      port.on("data", onData);
      port.on("error", onErr);
      port.write(message, "utf8", (err) => {
        if (err) finish(err);
      });
    });
  }
}

/** Factory kept separate so `client.ts` can import it without a static serialport dep. */
export function createSerialTransport(opts: ResolvedOptions): Transport {
  return new SerialTransport(opts);
}
