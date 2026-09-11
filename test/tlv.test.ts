import { describe, it, expect } from "vitest";
import {
  tlv,
  buildMessage,
  buildConfirmation,
  parseMessage,
  isApproved,
  maskPan,
  describeResponse,
  extractLastMessage,
  RESPONSE_CODES,
  TM,
  TAG,
  TIDE,
} from "../src/protocol/tlv.js";

describe("tlv encoding", () => {
  it("encodes TAG(3)+LEN(3)+VALUE", () => {
    expect(tlv("001", "009")).toBe("001003009");
    expect(tlv("002", "000000001000")).toBe("002012000000001000");
    expect(tlv("014", "14052026")).toBe("01400814052026");
  });

  it("encodes an empty value with length 000", () => {
    expect(tlv("010", "")).toBe("010000");
  });
});

describe("parseMessage", () => {
  it("parses a basic message and strips the terminator", () => {
    const f = parseMessage("001003109013003000!");
    expect(f["001"]).toBe("109");
    expect(f["013"]).toBe("000");
  });

  it("parses a payment response", () => {
    const f = parseMessage(
      "001003101013003000008006123456009006AB1234007016516794******3315!",
    );
    expect(f["001"]).toBe("101");
    expect(f["013"]).toBe("000");
    expect(f["008"]).toBe("123456");
    expect(f["009"]).toBe("AB1234");
    expect(f["007"]).toBe("516794******3315");
  });

  it("parses without a terminator", () => {
    const f = parseMessage("001003109013003000");
    expect(f["001"]).toBe("109");
    expect(f["013"]).toBe("000");
  });

  it("returns empty for an empty string", () => {
    expect(parseMessage("")).toEqual({});
  });

  it("stops on a truncated field", () => {
    // length says 10 but only 3 chars available
    expect(parseMessage("001010abc")).toEqual({});
  });
});

describe("buildMessage", () => {
  it("builds a network test with connection framing, no terminator", () => {
    const msg = buildMessage(TM.NETWORK_TEST);
    expect(msg.startsWith("001003009")).toBe(true);
    expect(msg.endsWith("!")).toBe(false);
    expect(msg).toContain("003007"); // NCAI tag
    expect(msg).toContain("004006"); // NS tag
  });

  it("builds a payment with amount + currency", () => {
    const msg = buildMessage(TM.PAYMENT, { amountCentimes: 1000 });
    expect(msg.startsWith("001003001")).toBe(true);
    expect(msg).toContain("0020041000"); // MT 10.00 MAD
    expect(msg).toContain("012003504"); // currency MAD
    expect(msg.endsWith("!")).toBe(false);
  });

  it("round-trips build → parse", () => {
    const msg = buildMessage(TM.PAYMENT, {
      ncai: "0200005",
      ns: "000042",
      amountCentimes: 5000,
    });
    const f = parseMessage(msg);
    expect(f["001"]).toBe("001");
    expect(f["002"]).toBe("5000");
    expect(f["003"]).toBe("0200005");
    expect(f["004"]).toBe("000042");
    expect(f["012"]).toBe("504");
  });

  it("rejects an out-of-range amount", () => {
    expect(() => buildMessage(TM.PAYMENT, { amountCentimes: -1 })).toThrow();
    expect(() =>
      buildMessage(TM.PAYMENT, { amountCentimes: 1_000_000_000_000 }),
    ).toThrow();
  });
});

describe("buildConfirmation", () => {
  it("includes STAN", () => {
    const msg = buildConfirmation("654321");
    expect(msg.startsWith("001003002")).toBe(true); // TM=002
    expect(msg).toContain("008006654321");
    expect(msg.endsWith("!")).toBe(false);
  });

  it("carries MT/DE/NCAR/DAEX per spec §4.2", () => {
    const msg = buildConfirmation("654321", {
      ncai: "0100001",
      ns: "000042",
      amountCentimes: 2500,
      ncar: "516794******3315",
      daex: "2612",
    });
    const f = parseMessage(msg);
    expect(f["001"]).toBe("002");
    expect(f["002"]).toBe("2500");
    expect(f["012"]).toBe("504");
    expect(f["008"]).toBe("654321");
    expect(f["007"]).toBe("516794******3315");
    expect(f["017"]).toBe("2612");
  });

  it("omits optional fields when not provided", () => {
    const f = parseMessage(buildConfirmation("654321"));
    expect(f["002"]).toBeUndefined();
    expect(f["007"]).toBeUndefined();
    expect(f["017"]).toBeUndefined();
    expect(f["008"]).toBe("654321");
  });
});

describe("isApproved", () => {
  it("accepts the approval codes", () => {
    for (const c of ["000", "001", "003", "007"]) {
      expect(isApproved(c)).toBe(true);
    }
  });

  it("rejects declines and null", () => {
    for (const c of ["100", "116", "909"]) {
      expect(isApproved(c)).toBe(false);
    }
    expect(isApproved(undefined)).toBe(false);
  });
});

describe("describeResponse", () => {
  it("describes known codes", () => {
    expect(describeResponse("000")).toBe("Approved");
    expect(describeResponse("116")).toBe("Insufficient funds");
    expect(describeResponse("480")).toBe("Reversal accepted");
    expect(describeResponse("909")).toBe("System failure");
  });

  it("falls back for unknown codes", () => {
    expect(describeResponse("777")).toContain("Unknown response code");
    expect(describeResponse(undefined)).toContain("Unknown response code");
  });

  it("has the full §6 table", () => {
    // spot-check the table is materially complete
    expect(Object.keys(RESPONSE_CODES).length).toBeGreaterThan(70);
  });
});

describe("maskPan", () => {
  it("masks a standard card", () => {
    expect(maskPan("5167941234563315")).toBe("516794******3315");
  });
  it("leaves short numbers alone", () => {
    expect(maskPan("12345")).toBe("12345");
  });
  it("is idempotent on an already-masked value", () => {
    expect(maskPan("516794******3315")).toBe("516794******3315");
  });
});

describe("extractLastMessage", () => {
  it("returns a single message", () => {
    expect(extractLastMessage("001003109!")).toBe("001003109!");
  });
  it("returns the last of several", () => {
    expect(extractLastMessage("001003109!013003000!")).toBe("013003000!");
  });
  it("returns empty for empty input", () => {
    expect(extractLastMessage("")).toBe("");
  });
});

describe("constants", () => {
  it("exposes v2 tags and TIDE values", () => {
    expect(TAG.TIDE).toBe("020");
    expect(TAG.NSA).toBe("005");
    expect(TAG.CB).toBe("011");
    expect(TIDE.MERCHANT).toBe("01");
    expect(TIDE.RECHARGE).toBe("02");
  });
});
