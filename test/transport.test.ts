import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { TcpTransport } from "../src/transport/tcp.js";
import { resolveOptions } from "../src/models.js";

/** One-shot TCP server that answers every request with `reply`. */
function serve(reply: string): Promise<net.Server> {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => sock.on("data", () => sock.write(reply)));
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

describe("TcpTransport framing", () => {
  let srv: net.Server | undefined;
  let transport: TcpTransport | undefined;
  afterEach(() => {
    transport?.disconnect();
    srv?.close();
  });

  it("ends a v2 read on a v1 '?' terminator without waiting for the silence fallback", async () => {
    srv = await serve("001003109013003000?");
    const port = (srv.address() as net.AddressInfo).port;
    transport = new TcpTransport(resolveOptions({ tcpHost: "127.0.0.1", tcpPort: port, protocolVersion: "v2" }));

    const t0 = Date.now();
    const resp = await transport.sendReceive("001003009", 5000);
    expect(resp).toBe("001003109013003000?");
    expect(Date.now() - t0).toBeLessThan(800); // >1000ms would mean the drain fallback fired
  });
});
