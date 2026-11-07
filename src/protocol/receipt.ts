/**
 * Parses the DP (010) print block into discrete receipt lines (v2 §5).
 *
 * The DP value is a sequence of line groups, each made of four sub-tags: DP1(030) line
 * number, DP2(031) format (S=simple, G=bold), DP3(032) alignment (C=centre, D=right,
 * G/other=left), DP4(033) content. Groups are separated by '*' and the block may end
 * with '?'.
 *
 * Parsing is length-driven: each sub-tag's value is consumed by its LENGTH, so a '*' or
 * '?' inside a value (e.g. the masked PAN "516794******3315") stays part of the line.
 * '*' and '?' only act as separator / end marker between sub-tags. Every line is kept,
 * in order, exactly as sent; any card number in a line is masked (first 6 + last 4 digits).
 */

import { RECEIPT_TAG, maskPansInText } from "./tlv.js";

export type ReceiptAlignment = "left" | "center" | "right";

export interface ReceiptLine {
  lineNumber: string;
  text: string;
  bold: boolean;
  alignment: ReceiptAlignment;
}

export function parseReceipt(dp: string): ReceiptLine[] {
  const lines: ReceiptLine[] = [];
  let group: { lineNumber?: string; format: string; alignment: string; content: string } | null = null;

  const flush = () => {
    if (group?.lineNumber !== undefined) {
      lines.push({
        lineNumber: group.lineNumber,
        text: maskPansInText(group.content),
        bold: group.format === "G",
        alignment: group.alignment === "C" ? "center" : group.alignment === "D" ? "right" : "left",
      });
    }
    group = null;
  };

  let i = 0;
  while (i < dp.length) {
    const ch = dp[i];
    if (ch === "*") {
      flush();
      i++;
      continue;
    }
    if (ch === "?") break; // end of block

    const tag = dp.slice(i, i + 3);
    const lenStr = dp.slice(i + 3, i + 6);
    const len = Number(lenStr);
    if (!/^\d{3}$/.test(tag) || !/^\d{3}$/.test(lenStr) || i + 6 + len > dp.length) {
      // Malformed sub-tag: resume at the next line group.
      flush();
      const next = dp.indexOf("*" + RECEIPT_TAG.LINE_NUMBER, i + 1);
      if (next < 0) break;
      i = next;
      continue;
    }

    const value = dp.slice(i + 6, i + 6 + len);
    if (tag === RECEIPT_TAG.LINE_NUMBER && group?.lineNumber !== undefined) flush(); // new group without '*'
    group ??= { format: "S", alignment: "G", content: "" };
    switch (tag) {
      case RECEIPT_TAG.LINE_NUMBER:
        group.lineNumber = value;
        break;
      case RECEIPT_TAG.FORMAT:
        group.format = value;
        break;
      case RECEIPT_TAG.ALIGNMENT:
        group.alignment = value;
        break;
      case RECEIPT_TAG.CONTENT:
        group.content = value;
        break;
    }
    i += 6 + len;
  }
  flush();

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
