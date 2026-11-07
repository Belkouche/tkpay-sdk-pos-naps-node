import { describe, it, expect } from "vitest";
import { parseReceipt, receiptToText } from "../src/protocol/receipt.js";

/** Build one DP line group as the terminal encodes it: DP1(030)/DP2(031)/DP3(032)/DP4(033). */
function line(num: number, content: string, style: string, align: string): string {
  const n = String(num).padStart(2, "0");
  const len = String(content.length).padStart(3, "0");
  return `030002${n}031001${style}032001${align}033${len}${content}`;
}

describe("parseReceipt", () => {
  it("parses DP1-4 sub-tags, format and alignment", () => {
    const dp = [
      line(0, "TKpay", "G", "C"),
      line(1, "MONTANT: 25.00 MAD", "S", "G"),
      line(2, "MERCI", "S", "D"),
    ].join("*");

    const lines = parseReceipt(dp);
    expect(lines).toHaveLength(3);

    expect(lines[0]).toMatchObject({ lineNumber: "00", text: "TKpay", bold: true, alignment: "center" });
    expect(lines[1]).toMatchObject({ text: "MONTANT: 25.00 MAD", bold: false, alignment: "left" });
    expect(lines[2]).toMatchObject({ text: "MERCI", bold: false, alignment: "right" });
  });

  it("ignores a trailing '?' end marker", () => {
    const dp = line(0, "TKpay", "G", "C") + "?";
    const lines = parseReceipt(dp);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("TKpay");
  });

  it("skips groups without a line number", () => {
    // a stray fragment between separators must not produce a line
    const dp = line(0, "A", "S", "G") + "*" + "garbage" + "*" + line(1, "B", "S", "G");
    const lines = parseReceipt(dp);
    expect(lines.map((l) => l.text)).toEqual(["A", "B"]);
  });

  it("masks a full PAN printed on a line", () => {
    const lines = parseReceipt(line(3, "CARTE: 5167941234563315", "S", "G"));
    expect(lines[0].text).toBe("CARTE: 516794******3315");
  });

  it("returns empty for empty input", () => {
    expect(parseReceipt("")).toEqual([]);
  });
});

/** DP blocks captured from the emulator (master) for a 10.00 MAD payment: TM 101 and TM 102. */
const EMULATOR_MERCHANT_DP =
  "03000200031001G032001C033005TKpay*03000202031001S032001G033032--------------------------------*03000203031001S032001G03301907/11/2026 00:11:31*03000204031001S032001G033010TKPAY DEMO*03000206031001S032001G033010CASABLANCA*03000207031001S032001G033032--------------------------------*03000209031001S032001G033004VISA*03000210031001S032001G033016516794******3315*03000215031001S032001G033018Terminal: 00000001*03000217031001S032001G033019Transaction: 653394*03000218031001S032001G033020Autorisation: 379900*03000219031001S032001G033012STAN: 653394*03000220031001S032001G033032--------------------------------*03000221031001S032001G033018MONTANT: 10.00 MAD*03000222031001S032001G033032--------------------------------*03000223031001S032001G033005DEBIT*03000224031001S032001G033016Copie Commercant";
const EMULATOR_CUSTOMER_DP =
  "03000200031001G032001C033005TKpay*03000202031001S032001G033032--------------------------------*03000203031001S032001G03301907/11/2026 00:11:31*03000204031001S032001G033010TKPAY DEMO*03000206031001S032001G033010CASABLANCA*03000207031001S032001G033032--------------------------------*03000209031001S032001G033004VISA*03000210031001S032001G033016516794******3315*03000215031001S032001G033018Terminal: 00000001*03000217031001S032001G033019Transaction: 653394*03000218031001S032001G033020Autorisation: 550432*03000219031001S032001G033012STAN: 653394*03000220031001S032001G033032--------------------------------*03000221031001S032001G033018MONTANT: 10.00 MAD*03000222031001S032001G033032--------------------------------*03000223031001S032001G033005DEBIT*03000224031001S032001G033012Copie Client";

/** Golden receipt (spec §5 layout as sent by the emulator), last line excluded. */
const GOLDEN_BODY = [
  "TKpay",
  "--------------------------------",
  "07/11/2026 00:11:31",
  "TKPAY DEMO",
  "CASABLANCA",
  "--------------------------------",
  "VISA",
  "516794******3315",
  "Terminal: 00000001",
  "Transaction: 653394",
  "Autorisation: AUTH",
  "STAN: 653394",
  "--------------------------------",
  "MONTANT: 10.00 MAD",
  "--------------------------------",
  "DEBIT",
];

function rendered(dp: string): string[] {
  return receiptToText(parseReceipt(dp)).split("\n").map((l) => l.trim());
}

describe("emulator receipts (golden)", () => {
  it("renders the merchant copy exactly, including the masked PAN line", () => {
    const golden = GOLDEN_BODY.map((l) => l.replace("AUTH", "379900"));
    expect(rendered(EMULATOR_MERCHANT_DP)).toEqual([...golden, "Copie Commercant"]);
  });

  it("renders the customer copy exactly", () => {
    const golden = GOLDEN_BODY.map((l) => l.replace("AUTH", "550432"));
    expect(rendered(EMULATOR_CUSTOMER_DP)).toEqual([...golden, "Copie Client"]);
  });

  it("keeps every line in order with its line number, bold and alignment", () => {
    const lines = parseReceipt(EMULATOR_CUSTOMER_DP);
    expect(lines.map((l) => l.lineNumber)).toEqual([
      "00", "02", "03", "04", "06", "07", "09", "10", "15", "17", "18", "19", "20", "21", "22", "23", "24",
    ]);
    expect(lines[0]).toMatchObject({ text: "TKpay", bold: true, alignment: "center" });
    expect(lines[7]).toMatchObject({ text: "516794******3315", bold: false, alignment: "left" });
  });
});

describe("parseReceipt framing", () => {
  it("keeps '*' and '?' that are part of a line's text", () => {
    const dp = line(1, "CARTE 516794******3315", "S", "G") + "*" + line(2, "MERCI ?", "S", "C") + "*" + line(3, "FIN", "S", "G");
    expect(parseReceipt(dp).map((l) => l.text)).toEqual(["CARTE 516794******3315", "MERCI ?", "FIN"]);
  });

  it("stops at a '?' end marker between lines", () => {
    const dp = line(1, "A", "S", "G") + "?" + line(2, "AFTER END", "S", "G");
    expect(parseReceipt(dp).map((l) => l.text)).toEqual(["A"]);
  });

  it("keeps empty lines rather than dropping them", () => {
    const dp = line(1, "A", "S", "G") + "*" + line(2, "", "S", "G") + "*" + line(3, "B", "S", "G");
    expect(parseReceipt(dp).map((l) => l.text)).toEqual(["A", "", "B"]);
  });

  it("masks a full PAN without blanking the line", () => {
    expect(parseReceipt(line(10, "5167941234563315", "S", "G"))[0].text).toBe("516794******3315");
  });
});
