import { describe, it, expect } from "vitest";
import { parseReceipt } from "../src/protocol/receipt.js";

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

  it("returns empty for empty input", () => {
    expect(parseReceipt("")).toEqual([]);
  });
});
