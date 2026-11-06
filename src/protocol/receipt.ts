/**
 * Parses the DP (010) print block into discrete receipt lines.
 *
 * The DP value is a sequence of line groups separated by '*', each group made of
 * four sub-tags (v2 §5): DP1(030) line number, DP2(031) format (S=simple, G=bold),
 * DP3(032) alignment (C=centre, D=right, G/other=left), DP4(033) content. The whole
 * block may end with a '?' marker, which is ignored.
 *
 * Port of the Aslan.Naps C# `ReceiptParser`. Any 16-digit PAN in a line is masked.
 */

import { maskPansInText } from "./tlv.js";

export type ReceiptAlignment = "left" | "center" | "right";

export interface ReceiptLine {
  lineNumber: string;
  text: string;
  bold: boolean;
  alignment: ReceiptAlignment;
}

export function parseReceipt(dp: string): ReceiptLine[] {
  const lines: ReceiptLine[] = [];

  for (const entry of dp.split("*")) {
    if (entry.length < 6) continue;

    let lineNumber = "";
    let format = "S";
    let alignment = "G";
    let content = "";

    let i = 0;
    while (i + 6 <= entry.length) {
      const tag = entry.slice(i, i + 3);
      const lenStr = entry.slice(i + 3, i + 6);
      const len = Number(lenStr);
      if (!/^\d{3}$/.test(lenStr) || Number.isNaN(len)) break;
      if (i + 6 + len > entry.length) break;

      const value = entry.slice(i + 6, i + 6 + len);
      switch (tag) {
        case "030":
          lineNumber = value;
          break;
        case "031":
          format = value;
          break;
        case "032":
          alignment = value;
          break;
        case "033":
          content = value;
          break;
      }
      i += 6 + len;
    }

    if (lineNumber.length === 0) continue;

    lines.push({
      lineNumber,
      text: maskPansInText(content),
      bold: format === "G",
      alignment: alignment === "C" ? "center" : alignment === "D" ? "right" : "left",
    });
  }

  return lines;
}

/** Render receipt lines as plain text for printing or logging. */
export function receiptToText(lines: ReceiptLine[], width = 40): string {
  const out: string[] = [];
  for (const line of lines) {
    let text = line.text;
    if (line.alignment === "center") {
      const pad = Math.max(0, Math.floor((width - text.length) / 2));
      text = " ".repeat(pad) + text;
    } else if (line.alignment === "right") {
      text = text.padStart(width);
    }
    out.push(text);
  }
  return out.join("\n");
}
