import { describe, it, expect } from "vitest";
import {
  tlv,
  buildMessage,
  buildConfirmation,
  buildCancellation,
  buildCancellationConfirmation,
  buildSettlement,
  parseMessage,
  maskPansInText,
  isApproved,
  maskPan,
  describeResponse,
  extractLastMessage,
  RESPONSE_CODES,
  TM,
  TAG,
  TIDE,
  RECEIPT_TAG,
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

  it("masks a full PAN in NCAR (007) on parse", () => {
    const f = parseMessage(tlv("001", "101") + tlv("007", "5167941234563315") + "!");
    expect(f["007"]).toBe("516794******3315");
  });

  it.each(["5167941234563315", "5167 9412 3456 3315", "5167-9412-3456-3315", "516794******3315", "5167 94** **** 3315"])(
    "returns NCAR (007) %j as first 6 + '*' + last 4",
    (ncar) => {
      expect(parseMessage(tlv("001", "101") + tlv("007", ncar) + "!")["007"]).toBe("516794******3315");
    },
  );

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

describe("buildCancellation", () => {
  it("carries STAN, original amount (MT) and original sequence (NSA)", () => {
    const f = parseMessage(
      buildCancellation("703062", { ncai: "0100001", ns: "000007", amountCentimes: 1250, originalSequence: "000003" }),
    );
    expect(f["001"]).toBe("003");
    expect(f["008"]).toBe("703062");
    expect(f["002"]).toBe("1250");
    expect(f["005"]).toBe("000003");
  });

  it("omits NSA when no original sequence is given", () => {
    expect(parseMessage(buildCancellation("703062"))["005"]).toBeUndefined();
  });
});

describe("buildCancellationConfirmation", () => {
  it("follows v2 §4.4: TM 004, NS (no NSA), STAN, MT+DE, DATR/HETR, DA/HE", () => {
    const msg = buildCancellationConfirmation("703062", {
      ncai: "0100001", ns: "000007", amount: "000000001250", datr: "10092026", hetr: "101500",
    });
    const f = parseMessage(msg);
    expect(Object.keys(f)).toEqual(["001", "003", "004", "008", "002", "012", "018", "019", "014", "015"]);
    expect(f["001"]).toBe("004");
    expect(f["004"]).toBe("000007");
    expect(f["002"]).toBe("000000001250"); // echoed verbatim
    expect(f["005"]).toBeUndefined();
  });

  it("omits MT/DE and DATR/HETR when not provided", () => {
    const f = parseMessage(buildCancellationConfirmation("703062"));
    expect(Object.keys(f)).toEqual(["001", "003", "004", "008", "014", "015"]);
  });
});

describe("buildSettlement", () => {
  it("is TM 010 + NCAI + DA + HE with no sequence number", () => {
    const f = parseMessage(buildSettlement("0200005"));
    expect(Object.keys(f)).toEqual(["001", "003", "014", "015"]);
    expect(f["001"]).toBe("010");
    expect(f["003"]).toBe("0200005");
    expect(f["014"]).toMatch(/^\d{8}$/);
    expect(f["015"]).toMatch(/^\d{6}$/);
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

describe("maskPansInText", () => {
  it("masks 16-digit card numbers inside free text", () => {
    expect(maskPansInText("CARTE 5167941234563315 VISA")).toBe("CARTE 516794******3315 VISA");
  });
  // Shared masking rule — identical vectors across the 7 NAPS SDKs.
  it.each([
    ["5167940000123315", "516794******3315"],
    ["5167 9400 0012 3315", "5167 94** **** 3315"],
    ["5167-9400-0012-3315", "5167-94**-****-3315"],
    ["5167.9400.0012.3315", "5167.94**.****.3315"],
    ["6011000990139424127", "601100*********4127"],
    ["5167 9400 0012 3315 0000", "5167 94** **** **** 0000"],
    ["07/11/2026 00:12:10", "07/11/2026 00:12:10"],
    ["MONTANT: 10.00 MAD", "MONTANT: 10.00 MAD"],
    ["Terminal: 00000001", "Terminal: 00000001"],
  ])("maskPansInText(%j) → %j", (input, expected) => {
    expect(maskPansInText(input)).toBe(expected);
  });

  it("masks runs of 13+ digits with tab or non-breaking-space separators, and runs over 19 digits", () => {
    expect(maskPansInText("4111111111111")).toBe("411111***1111"); // 13 digits
    expect(maskPansInText("5167\t9400\t0012\t3315")).toBe("5167\t94**\t****\t3315");
    expect(maskPansInText("5167\u00A09400\u00A00012\u00A03315")).toBe("5167\u00A094**\u00A0****\u00A03315");
    expect(maskPansInText("12345678901234567890")).toBe("123456**********7890"); // 20 digits: fail closed
  });

  it("leaves shorter runs, double separators, amounts and receipt numbers alone", () => {
    for (const text of [
      "STAN 703062 REF 123456789012", // 12 digits
      "5167  9400  0012  3315", // two separators between groups: no run of 13
      "MONTANT: 1 250,00 MAD",
      "Transaction: 653394",
      "Autorisation: 379900",
    ]) {
      expect(maskPansInText(text)).toBe(text);
    }
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

  it("exposes the v5.4.4 tag set, receipt sub-tags and response message types", () => {
    expect(TAG.NHC).toBe("006");
    expect(TAG.TYPA).toBe("021");
    expect(TAG.MDLC).toBe("028");
    expect(TAG.EM).toBe("040");
    expect(RECEIPT_TAG).toEqual({ LINE_NUMBER: "030", FORMAT: "031", ALIGNMENT: "032", CONTENT: "033" });
    expect(TM.SETTLEMENT).toBe("010");
    expect(TM.CANCELLATION_RESPONSE).toBe("103");
    expect(TM.CANCELLATION_CORRECTION).toBe("104");
  });
});
