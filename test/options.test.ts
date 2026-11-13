import { describe, it, expect } from "vitest";
import { resolveOptions } from "../src/models.js";

describe("resolveOptions — per-transport protocol default", () => {
  it("defaults TCP (Sunmi) to v2", () => {
    expect(resolveOptions({ transport: "tcp", tcpHost: "x" }).protocolVersion).toBe("v2");
  });

  it("defaults serial (Ingenico Lane3600) to v2: it ends every reply with '!'", () => {
    expect(resolveOptions({ transport: "serial", serialPath: "/dev/x" }).protocolVersion).toBe("v2");
  });

  it("keeps an explicit v1 for a legacy terminal", () => {
    expect(resolveOptions({ transport: "serial", serialPath: "/dev/x", protocolVersion: "v1" }).protocolVersion).toBe("v1");
  });

  it("defaults to v2 when no transport is given (tcp is the default transport)", () => {
    expect(resolveOptions({}).protocolVersion).toBe("v2");
  });

  it("honours an explicit protocolVersion on either transport", () => {
    expect(resolveOptions({ transport: "serial", protocolVersion: "v2" }).protocolVersion).toBe("v2");
    expect(resolveOptions({ transport: "tcp", protocolVersion: "v1" }).protocolVersion).toBe("v1");
  });
});
