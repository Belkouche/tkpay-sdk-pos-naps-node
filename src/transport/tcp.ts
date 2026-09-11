import net from "node:net";
import type { ResolvedOptions } from "../models.js";
import { TerminalTimeoutError, type Transport } from "./transport.js";

/**
 * TCP transport for Sunmi P2/P3. Speaks the NAPS M2M ASCII TLV protocol; responses
 * are terminated by '!' (v2 / NapsPay v5.4.4) or '?' (v1). Requests carry no terminator.
 */
export class TcpTransport implements Transport {
  private socket: net.Socket | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly connectTimeoutMs: number;
  private readonly terminator: string;

  constructor(opts: ResolvedOptions) {
    if (!opts.tcpHost) throw new Error("tcpHost is required for the TCP transport");
    this.host = opts.tcpHost;
    this.port = opts.tcpPort;
    this.connectTimeoutMs = opts.tcpConnectTimeoutMs;
    this.terminator = opts.protocolVersion === "v1" ? "?" : "!";
  }

  get isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = new net.Socket();
      const onError = (err: Error) => {
        sock.destroy();
        reject(err);
      };
      sock.setTimeout(this.connectTimeoutMs, () => onError(new TerminalTimeoutError(this.connectTimeoutMs)));
      sock.once("error", onError);
      sock.connect(this.port, this.host, () => {
        sock.setTimeout(0);
        sock.removeListener("error", onError);
        this.socket = sock;
        resolve();
      });
    });
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  async sendReceive(message: string, timeoutMs: number): Promise<string> {
    if (!this.socket) await this.connect();
    const sock = this.socket;
    if (!sock) throw new Error("socket not connected");

    return new Promise<string>((resolve, reject) => {
      let buf = "";
      let drainTimer: NodeJS.Timeout | null = null;
      const overall = setTimeout(() => finish(new TerminalTimeoutError(timeoutMs)), timeoutMs);

      const cleanup = () => {
        clearTimeout(overall);
        if (drainTimer) clearTimeout(drainTimer);
        sock.removeListener("data", onData);
        sock.removeListener("error", onErr);
        sock.removeListener("close", onClose);
      };
      const finish = (err: Error | null, value?: string) => {
        cleanup();
        if (err) reject(err);
        else resolve(value!);
      };

      const onData = (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const idx = buf.indexOf(this.terminator);
        if (idx >= 0) {
          // Return up to and including the terminator; the parser stops there.
          finish(null, buf.slice(0, idx + 1));
        } else {
          // No terminator yet — arm a 1s silence fallback (defends against a v1
          // terminal talking to a v2 client or vice-versa).
          if (drainTimer) clearTimeout(drainTimer);
          drainTimer = setTimeout(() => finish(null, buf), 1000);
        }
      };
      const onErr = (err: Error) => finish(err);
      const onClose = () => finish(buf ? null : new Error("connection closed before response"), buf);

      sock.on("data", onData);
      sock.once("error", onErr);
      sock.once("close", onClose);

      sock.write(message, "utf8", (err) => {
        if (err) finish(err);
      });
    });
  }
}
