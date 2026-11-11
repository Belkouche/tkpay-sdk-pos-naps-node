# @tkpay/naps

Node.js SDK for card payments on NAPS Pay terminals in Morocco. Your application (the cash
register, "ECR") sends a command such as "pay 125.00 MAD"; the terminal handles the card and the
bank, and the SDK gives you back a typed result: approved or not, the transaction id (STAN), the
masked card number and a printable receipt. It implements the NapsPay ECR ↔ Terminal TLV Protocol
Specification v2.0 (NapsPay v5.4.4).

**Terminals and connections supported by this SDK**

| Terminal (spec §2) | Connection | In this SDK |
|---|---|---|
| Sunmi P2, P3, P2 Smart PAD | Wi-Fi, TCP port 4444 | `transport: "tcp"` |
| Sunmi P2, P3, P2 Smart PAD | USB | Not supported — use Wi-Fi |
| Ingenico Lane 3600 | USB only | `transport: "serial"`, port auto-discovered |
| Ingenico Self 5000 | USB only | Same USB serial path as the Lane; not tested separately |

Written in TypeScript; ships ESM + CommonJS with type definitions. Node.js 18 or later. It is the
Node port of the canonical [C# SDK](https://github.com/Belkouche/tkpay-sdk-pos-naps-csharp).

---

## Contents

1. [Install](#1-install)
2. [Quickstart](#2-quickstart)
3. [How a payment works](#3-how-a-payment-works)
4. [How a void works](#4-how-a-void-works)
5. [Other operations](#5-other-operations)
6. [Receipts, PAN masking, response codes](#6-receipts-pan-masking-response-codes)
7. [Errors and timeouts](#7-errors-and-timeouts)
8. [Connecting and options](#8-connecting-and-options)
9. [Testing with the emulator](#9-testing-with-the-emulator)
10. [Troubleshooting](#10-troubleshooting)
11. [Changelog](#11-changelog)

---

## 1. Install

The package is not on the public npm registry. Install it from GitHub:

```bash
npm install github:Belkouche/tkpay-sdk-pos-naps-node
# or pin a tag / commit:
npm install github:Belkouche/tkpay-sdk-pos-naps-node#<tag-or-commit>
```

`dist/` is built automatically on install (`prepare` script). Then:

```ts
import { NapsClient } from "@tkpay/naps";
```

For an Ingenico terminal over USB, also install the optional native serial driver. TCP (Sunmi)
does not need it:

```bash
npm install serialport
```

---

## 2. Quickstart

Start the emulator (see [§9](#9-testing-with-the-emulator)), then run this. It is the same code as
[`examples/quickstart.mjs`](examples/quickstart.mjs).

```ts
import { NapsClient, receiptToText } from "@tkpay/naps";

// The emulator (or a Sunmi terminal on Wi-Fi) listens on TCP port 4444.
const naps = new NapsClient({
  transport: "tcp",
  tcpHost: process.env.NAPS_HOST ?? "127.0.0.1",
  tcpPort: Number(process.env.NAPS_PORT ?? 4444),
});

const result = await naps.pay(12.5); // 12.50 MAD
if (result.isSuccess) {
  console.log(`Approved — STAN ${result.stan}, card ${result.cardNumber}`);
  console.log(receiptToText(result.customerReceiptLines ?? [])); // customer copy
} else {
  console.log(`Declined — ${result.responseCode}: ${result.responseMessage}`);
}
naps.disconnect();
```

From a clone of this repo: `npm install && npm run build && node examples/quickstart.mjs`.
Against the emulator it prints:

```
Approved — STAN 791883, card 516794******3315
                 TKpay
--------------------------------
06/11/2026 23:39:13
TKPAY DEMO
CASABLANCA
--------------------------------
VISA
516794******3315
...
MONTANT: 12.50 MAD
--------------------------------
DEBIT
Copie Client
```

Amounts are in MAD: `pay(12.5)` sends 1250 centimes. The register and cashier ids default to
`"01"` and `"00001"` (see [§8](#8-connecting-and-options)).

---

## 3. How a payment works

`pay()` runs two request/response exchanges on the **same connection**:

```
  your app (ECR)                         terminal
       │  TM 001  payment request (MT, NCAI, NS) ─▶│  customer presents card,
       │                                           │  terminal contacts the bank
       │◀─ TM 101  payment response (CR, STAN, card, merchant receipt)
       │
       │  only if CR is an approval code:
       │  TM 002  confirmation (STAN, MT, NCAR, DAEX) ─▶│  within 40 s, same connection
       │◀─ TM 102  confirmation response (CR, customer receipt)
```

What `pay()` returns in each case:

| Situation | `isSuccess` | `responseCode` | Notes |
|---|---|---|---|
| TM 101 declined | `false` | the decline code, e.g. `116` | no TM 002 is sent |
| TM 101 approved, TM 102 CR 000 | `true` | `000` | merchant + customer receipts |
| TM 102 refused (e.g. 302, 482) | `false` | the TM 102 code | not an approval; with 482 the terminal has reversed the sale |
| No TM 101 reply in `paymentTimeoutMs` | `false` | `"TIMEOUT"` | |
| No TM 102 reply in `confirmationTimeoutMs` | `true` | approval code | `responseMessage` is `"Confirmation timed out"` — reconcile |

The result fields:

```ts
import { NapsClient } from "@tkpay/naps";

const naps = new NapsClient({ tcpHost: "127.0.0.1" });
const r = await naps.pay(125);

r.isSuccess;            // approved and confirmed
r.responseCode;         // CR (013): "000" = approved
r.responseMessage;      // receipt text, or the meaning of the code
r.stan;                 // STAN (008) — keep it: needed to void or reprint
r.sequence;             // NS (004) of the payment
r.cardNumber;           // masked PAN, e.g. "516794******3315"
r.cardExpiry;           // DAEX (017), YYMM
r.cardholderName;       // NPRT (016), when the card provides it
r.entryMode;            // EM (040), e.g. "CC" contactless
r.authorizationNumber;  // NA (009)
r.transactionDate;      // DA (014), DDMMYYYY
r.transactionTime;      // HE (015), HHMMSS
r.merchantReceiptLines; // merchant copy (TM 101), parsed — see §6
r.customerReceiptLines; // customer copy (TM 102), parsed
naps.disconnect();
```

`pay(amount, orderId)` accepts an `orderId` argument for your own bookkeeping; it is not sent to
the terminal.

---

## 4. How a void works

`cancel(stan, amountMad, originalSequence?)` voids a payment of the current day. It is also two
exchanges on the same connection (spec §4.3–4.4):

```
  your app (ECR)                         terminal
       │  TM 003  cancellation (STAN, MT, new NS) ─▶│  looks the payment up
       │◀─ TM 103  CR 000 = transaction found (merchant receipt)
       │
       │  TM 004  cancellation confirmation ───────▶│  executes the reversal
       │          (same NS as TM 003, STAN, MT/DE and DATR/HETR echoed from TM 103)
       │◀─ TM 104  CR 000 or 480 = void completed (customer receipt)
```

TM 103 CR 000 only means the payment was found. The reversal happens on TM 004, so the result
depends on TM 104:

| TM 104 | Result |
|---|---|
| CR `000` or `480` | **success**: `isSuccess: true`, `isCancelled: true` |
| CR `995`, or no TM 104 reply within `confirmationTimeoutMs` | **pending**: `isSuccess: false`, `isPending: true` — the reversal may or may not have run |
| any other CR | **failure**: `isSuccess: false` |
| — (TM 103 refused, e.g. `302`) | **failure**, no TM 004 is sent |

Always pass the original amount: NapsPay v5.4.4 expects it in the void frames, and a live terminal
refused a TM 004 without it (CR 909).

```ts
import { NapsClient } from "@tkpay/naps";

const naps = new NapsClient({ tcpHost: "127.0.0.1" });
const sale = await naps.pay(20);

const voided = await naps.cancel(sale.stan!, 20, sale.sequence);
if (voided.isSuccess) {
  console.log(`Voided (CR ${voided.responseCode}), void STAN ${voided.stan}`);
} else if (voided.isPending) {
  // Unknown outcome. Do not report the void as done, and do not blindly retry.
  // The STAN and the TM 103 merchant receipt are kept on the result.
  const check = await naps.duplicateReceipt(sale.stan!); // reprint the payment by STAN
  console.log(`Void unconfirmed (${voided.responseCode}); check receipt:`, check.receiptText);
} else {
  console.log(`Void failed: ${voided.responseCode} ${voided.responseMessage}`);
}
naps.disconnect();
```

On a success, `voided.merchantReceiptLines` is the merchant copy (TM 103) and
`voided.customerReceiptLines` the customer copy (TM 104; the terminal sends no receipt with CR 480).
The Ingenico Lane3600 sends no receipt with TM 103: its only void receipt comes with TM 104, and the
SDK returns it as the merchant copy (`merchantReceiptLines` and `receiptLines`), with no customer copy.
A pending or refused void keeps the TM 103 merchant copy (none on the Lane3600).
`originalSequence`, when given, is sent as NSA (005) on TM 003 only. A timeout on TM 003 itself
returns `responseCode: "TIMEOUT"`.

---

## 5. Other operations

Each opens (or reuses) the connection, sends one frame with your NCAI (and a fresh sequence number,
except settlement) and reads one response.

**Network test** (TM 009) — checks the terminal ↔ host link. USB serial only: over TCP nothing
is sent and `responseCode` is `"UNSUPPORTED"`, because the NapsPay app on Sunmi terminals does not
implement TM 009 (it answers 902) and a test frame crashed the app on a Sunmi P2.

```ts
import { NapsClient } from "@tkpay/naps";
const naps = new NapsClient({ transport: "serial" });
const test = await naps.networkTest(); // { isSuccess, responseCode, message }
console.log(test.isSuccess ? "Network OK" : test.message);
naps.disconnect();
```

**Duplicate receipt** (TM 008) — reprints the last transaction, or a given STAN from today:

```ts
import { NapsClient } from "@tkpay/naps";
const naps = new NapsClient({ tcpHost: "127.0.0.1" });
const last = await naps.duplicateReceipt();          // PaymentResult
const byStan = await naps.duplicateReceipt("703062"); // CR ≠ 000 if not found
console.log(last.isSuccess, byStan.responseCode);
naps.disconnect();
```

**Totals** (TM 010) — the running totals ticket:

```ts
import { NapsClient, receiptToText } from "@tkpay/naps";
const naps = new NapsClient({ tcpHost: "127.0.0.1" });
const totals = await naps.totals(); // { isSuccess, responseCode, receiptText, receiptLines }
console.log(receiptToText(totals.receiptLines ?? []));
naps.disconnect();
```

**Settlement** (TM 010, telecollecte) — uploads the day's batch to the host. The terminal must be
idle and referenced:

```ts
import { NapsClient } from "@tkpay/naps";
const naps = new NapsClient({ tcpHost: "127.0.0.1" });
const s = await naps.settlement(); // { isSuccess, responseCode, message, date, time }
console.log(s.isSuccess ? `Settled ${s.date} ${s.time}` : s.message); // CR 052 = already settled today
naps.disconnect();
```

**Referencing** (TM 013) — loads a parameter set: `"01"` merchant (default), `"02"` recharge:

```ts
import { NapsClient, TIDE } from "@tkpay/naps";
const naps = new NapsClient({ tcpHost: "127.0.0.1" });
const ref = await naps.referencing(TIDE.MERCHANT); // { isSuccess, responseCode, parameterSet, receiptText, receiptLines }
console.log(ref.parameterSet, ref.isSuccess);
naps.disconnect();
```

**Reset PIN pad** (TM 012) — maintenance command, returns nothing:

```ts
import { NapsClient } from "@tkpay/naps";
const naps = new NapsClient({ tcpHost: "127.0.0.1" });
await naps.resetPinPad();
naps.disconnect();
```

**Port discovery** (USB serial only):

```ts
import { NapsClient } from "@tkpay/naps";
const ports = await NapsClient.listPorts(); // [{ path, vendorId, productId, manufacturer }]
const ingenico = await NapsClient.findPort(); // path or null
console.log(ports, ingenico);
```

---

## 6. Receipts, PAN masking, response codes

### Receipts

The receipt is the DP (010) block the terminal sends. The SDK prints it as
sent: it parses every line, keeps them in order and adds, merges or drops nothing.

**Which copy comes from where**

| Operation | Merchant copy ("Copie Commercant") | Customer copy ("Copie Client") |
|---|---|---|
| `pay()` approved | `merchantReceiptLines` ← TM 101 | `customerReceiptLines` ← TM 102 |
| `cancel()` completed | `merchantReceiptLines` ← TM 103 (Lane3600: ← TM 104) | `customerReceiptLines` ← TM 104 (none with CR 480; none on the Lane3600) |
| `cancel()` pending or refused at TM 104 | `merchantReceiptLines` ← TM 103 | — |

Everything else returns the receipt as sent in `receiptLines`: declines (TM 101), `duplicateReceipt()`
(TM 108), `totals()` (TM 110) and `referencing()` (TM 113). On payments and voids `receiptLines` is
the same as `merchantReceiptLines`. Each `…Lines` field has a `…Text` sibling holding the raw DP
block (card numbers masked).

**Printing.** Each `ReceiptLine` carries `lineNumber` (DP1, sub-tag 030), `bold` (DP2/031: `G` =
bold, `S` = simple), `alignment` (DP3/032: `C` → `"center"`, `D` → `"right"`, `G` → `"left"`) and
`text` (DP4/033). Drive a printer from those, or use `receiptToText(lines, width = 40)` for plain
text with centred / right-aligned lines:

```ts
import { NapsClient, receiptToText, type ReceiptLine } from "@tkpay/naps";

function printLines(lines: ReceiptLine[] = []): void {
  for (const l of lines) console.log(l.lineNumber, l.bold ? "bold" : "    ", l.alignment.padEnd(6), l.text);
}

const naps = new NapsClient({ tcpHost: "127.0.0.1" });
const r = await naps.pay(10);
console.log(receiptToText(r.merchantReceiptLines ?? [])); // hand to the merchant
console.log(receiptToText(r.customerReceiptLines ?? [])); // hand to the customer
printLines(r.customerReceiptLines);                        // with formatting metadata
naps.disconnect();
```

A 10.00 MAD payment on the emulator renders the customer copy as (each line trimmed):

```
TKpay
--------------------------------
07/11/2026 00:13:51
TKPAY DEMO
CASABLANCA
--------------------------------
VISA
516794******3315
Terminal: 00000001
Transaction: 650759
Autorisation: 223927
STAN: 650759
--------------------------------
MONTANT: 10.00 MAD
--------------------------------
DEBIT
Copie Client
```

The merchant copy ends with `Copie Commercant`; void copies end with `ANNULATION` and then the copy
label. `parseReceipt(dp)` parses any DP block yourself.

How the block is parsed: line groups are separated by `*`, each made of sub-tags 030–033, and `?`
ends the block. Values are read by their TLV length, so a `*` or `?` inside a line's text (such as
the masked PAN `516794******3315`) stays part of that line.

**Card numbers are masked.** The SDK masks card numbers as soon as it parses the terminal's reply
— first 6 + last 4 digits. The card field (NCAR, 007) is always returned as `516794******3315`,
whatever grouping it arrived in. In receipt text, any run of 13 or more digits — adjacent, or
separated by single spaces, dashes, dots, tabs or non-breaking spaces — keeps only its first 6 and
last 4 digits, with the separators left in place: `5167 9400 0012 3315` becomes
`5167 94** **** 3315`. Dates, times, amounts and shorter numbers (STAN, terminal, authorisation) are
left as they are, and the rest of each receipt line stays exactly as sent. The full number
is never exposed in a result, a receipt, a frame sent back to the terminal or an error, and the SDK
never logs it. The helpers are exported as `maskPan` and `maskPansInText`.

**Response codes.** CR (013) is a 3-digit code. `000`, `001`, `003` and `007` are approvals for a
payment. The full table from spec §6 is exported as `RESPONSE_CODES`:

```ts
import { RESPONSE_CODES, describeResponse, isApproved } from "@tkpay/naps";
describeResponse("116");        // "Insufficient funds"
isApproved("000");              // true
Object.keys(RESPONSE_CODES).length;
```

---

## 7. Errors and timeouts

There are three kinds of outcome:

1. **A decline or refusal** — a normal result: `isSuccess: false` and the terminal's
   `responseCode`. Nothing is thrown.
2. **A timeout** — handled differently per operation:

   | Operation | Timeout option (default) | On timeout |
   |---|---|---|
   | `pay()` TM 001 | `paymentTimeoutMs` (120 s) | returns `responseCode: "TIMEOUT"` |
   | `pay()` TM 002 | `confirmationTimeoutMs` (40 s) | returns the approval, `responseMessage: "Confirmation timed out"` |
   | `cancel()` TM 003 | `testTimeoutMs` (90 s) | returns `responseCode: "TIMEOUT"` |
   | `cancel()` TM 004 | `confirmationTimeoutMs` (40 s) | returns `isPending: true`, `responseCode: "TIMEOUT"` |
   | `networkTest()`, `totals()` | `testTimeoutMs` (90 s) | **throws** `TerminalTimeoutError` |
   | `referencing()` | `referencingTimeoutMs` (60 s) | **throws** `TerminalTimeoutError` |
   | `settlement()` | `paymentTimeoutMs` (120 s) | **throws** `TerminalTimeoutError` |
   | `duplicateReceipt()`, `resetPinPad()` | `testTimeoutMs` (90 s) | **throws** `TerminalTimeoutError` |
   | connecting | `tcpConnectTimeoutMs` (120 s) | **throws** `TerminalTimeoutError` |

3. **A transport error** — connection refused, socket closed before a response, serial port
   missing: the operation **throws** (a Node.js `Error`, e.g. `ECONNREFUSED`).

```ts
import { NapsClient, TerminalTimeoutError } from "@tkpay/naps";

const naps = new NapsClient({ tcpHost: "127.0.0.1" });
try {
  const r = await naps.pay(50);
  if (r.responseCode === "TIMEOUT") console.log("No answer from the terminal");
  else if (!r.isSuccess) console.log(`Declined: ${r.responseCode} ${r.responseMessage}`);
} catch (err) {
  if (err instanceof TerminalTimeoutError) console.log("Timed out:", err.message);
  else console.log("Cannot reach the terminal:", (err as Error).message);
} finally {
  naps.disconnect();
}
```

**Response framing.** Responses end with `!` (protocol v2) or `?` (v1). The SDK reads up to either
one; if neither arrives — the live v5.4.4 terminal sends TM 103/104 without one — it treats 1 second
of silence as the end of the message. A void therefore takes about 2 seconds longer than its network
round-trips.

---

## 8. Connecting and options

The client connects on the first operation and keeps the connection open for the next ones. Call
`disconnect()` when you are done. `connect()` is available if you want to connect up front.

**Sunmi over Wi-Fi (TCP).** The POS and the terminal must be on the same network; NapsPay listens on
port 4444.

```ts
import { NapsClient } from "@tkpay/naps";
const naps = new NapsClient({ transport: "tcp", tcpHost: "192.168.1.50", tcpPort: 4444 });
await naps.connect();
```

**Ingenico over USB (serial).** Requires `serialport`. Omit `serialPath` to auto-discover the port
(USB vendor id `0x0B00`, falling back to the first `usbmodem` / `ttyACM` device).

```ts
import { NapsClient } from "@tkpay/naps";
const lane = new NapsClient({ transport: "serial" });                                    // auto-discover
const lane2 = new NapsClient({ transport: "serial", serialPath: "/dev/tty.usbmodem1401" }); // explicit
```

The Lane3600 holds back its answers until about 30 s after the port opens, so the first request
after opening waits until the port has been open 32 s. A payment sent earlier would get its
approval too late to confirm. Connect once when the app starts and keep the client connected
between transactions, so only the first request waits.

**Run a network test when the point-of-sale app starts (USB only).** It takes that wait while no customer
is waiting, checks the terminal and the bank host, and leaves the port open, so the first sale goes
straight to the card prompt:

```ts
const naps = new NapsClient({ transport: "serial" });
await naps.networkTest(); // at app start: ~30 s on a Lane3600 over USB
```

**Protocol version.** `protocolVersion` selects the expected terminator: `"v2"` (`!`, NapsPay
v5.4.4) or `"v1"` (`?`, legacy). It defaults to `"v2"` for TCP and `"v1"` for serial; an explicit
value wins. A mismatch still works, because the reader accepts either terminator.

**All options** (every one is optional except `tcpHost` for TCP):

```ts
import { NapsClient } from "@tkpay/naps";
const naps = new NapsClient({
  transport: "tcp",                    // "tcp" | "serial"
  tcpHost: "192.168.1.50",
  tcpPort: 4444,
  tcpConnectTimeoutMs: 120_000,
  serialPath: undefined,               // serial: omit to auto-discover
  serialBaudRate: 115_200,
  protocolVersion: "v2",               // default per transport
  registerId: "01",                    // 2 digits  } sent as NCAI (003)
  cashierId: "00001",                  // 5 digits  }
  paymentTimeoutMs: 120_000,
  confirmationTimeoutMs: 40_000,       // protocol deadline for TM 002 / TM 004
  testTimeoutMs: 90_000,
  referencingTimeoutMs: 60_000,
});
```

---

## 9. Testing with the emulator

The [`tkpay-naps-emulator`](https://github.com/Belkouche/tkpay-naps-emulator) is a Python 3
(standard library only) program that behaves like a NapsPay terminal over TCP.

```bash
python3 ../tkpay-naps-emulator/naps_emulator.py --port 4444
```

Useful `--mode` values:

| Mode | Behaviour |
|---|---|
| `approve` (default) | every payment and void succeeds |
| `decline` | TM 101 returns CR 100 |
| `error --code 116` | TM 101 returns the given code (number or name, e.g. `insufficient_funds`) |
| `timeout` | TM 001 gets no reply |
| `no_confirm` | TM 002 gets no reply |
| `confirm_error --code 482` | TM 101 approves, TM 102 refuses with the code |
| `void_refuse --code 302` | TM 103 refuses the void |
| `void_480` | TM 104 returns CR 480 (success) |
| `void_995` | TM 104 returns CR 995 (pending) |
| `void_no_confirm` | TM 004 gets no reply (pending) |

`--protocol v1` switches responses to the `?` terminator; `--debug` prints every TLV field.

**This repo's tests:**

```bash
npm run build
npm run typecheck
npm run test:unit          # protocol, receipts, client logic, transport — no emulator needed
npm run test:integration   # starts the emulator itself, one process per mode
npm test                   # everything
```

The integration suite starts the emulator on port 4471 by default and skips itself if the emulator
file is missing. Override the location and port with:

```bash
NAPS_EMULATOR=/path/to/naps_emulator.py NAPS_EMULATOR_PORT=4453 npm test
```

---

## 10. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `ECONNREFUSED` thrown | Wrong IP or port, terminal not on the same network, or NapsPay not running / not on its waiting screen. Check the terminal IP and port 4444. |
| `pay()` returns `"TIMEOUT"` | Nobody presented a card within `paymentTimeoutMs`, or the terminal is busy. Check the terminal screen before retrying. |
| `TerminalTimeoutError` thrown | A management operation (network test, totals, referencing, settlement, duplicate, reset) got no reply. |
| Every response takes ~1 s longer | The terminal ends responses with the other terminator; set `protocolVersion` to match. Expected on voids (TM 103/104 carry no terminator). |
| CR `909` | System failure on the terminal or host. A live terminal also returned it for a void without the amount — always pass it to `cancel()`. |
| CR `302` | Record not found: wrong STAN, or the payment is not from the current day. |
| CR `482` | Transaction already cancelled. On TM 102 the terminal reversed the sale itself. |
| CR `052` on `settlement()` | Already settled today. |
| `cancel()` returns `isPending: true` | TM 104 was CR 995 or never arrived. The void may have gone through: reprint the payment with `duplicateReceipt(stan)` and reconcile before doing anything else. |
| `serialport` error | Install it: `npm install serialport` (only for USB). |
| `No Ingenico serial port found` | Cable not connected, or the port is not detected; pass `serialPath` explicitly (`NapsClient.listPorts()` lists candidates). |

---

## 11. Changelog

See [CHANGELOG.md](CHANGELOG.md). v1.2.0 brings the SDK in line with NapsPay v5.4.4 (two-phase
void, settlement, customer receipts, PAN masking at parse).

## License

MIT
