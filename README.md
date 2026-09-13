# @tkpay/naps

**Node.js SDK for taking card payments on NAPS Pay terminals in Morocco.**

You call `naps.pay(125)`, the customer taps their card on the terminal, and you get back a
clear result — approved or declined, with the STAN, masked card number, and a printable
receipt. That's the whole idea. This README teaches you everything else from scratch.

- Works with **Sunmi P2/P3** terminals (over your local network — TCP) and **Ingenico Lane**
  terminals (over a USB cable — serial).
- Written in **TypeScript**, ships **ESM + CommonJS** and full type definitions.
- Conformant with the NapsPay ECR↔Terminal **TLV Protocol Specification v2.0** (NapsPay v5.4.4).

> Part of the NAPS SDK family — all speak the same M2M TLV protocol to the same terminals.
> The **[C# SDK](https://github.com/Belkouche/tkpay-sdk-pos-naps-csharp) is canonical**
> (reference implementation); this is the **Node.js port** (`@tkpay/naps`), at feature parity
> for the Node/TypeScript ecosystem — same transports (TCP + USB serial), Ingenico port
> discovery, two-phase payment, per-transport v1/v2 protocol default. Siblings:
> [Android](https://github.com/Belkouche/tkpay-sdk-pos-android) ·
> [iOS](https://github.com/Belkouche/tkpay-sdk-pos-ios) ·
> [React Native](https://github.com/Belkouche/tkpay-sdk-pos-rn).
> Test without hardware using the [emulator](https://github.com/Belkouche/tkpay-naps-emulator).
>
> _Formerly published as `@aslan/naps` ([aslan-naps-node](https://github.com/Belkouche/aslan-naps-node), now retired) — renamed to `@tkpay/naps` to join the canonical family._

---

## Table of contents

1. [The 30-second mental model](#1-the-30-second-mental-model)
2. [Install](#2-install)
3. [Your first payment (copy-paste)](#3-your-first-payment-copy-paste)
4. [How a payment actually works](#4-how-a-payment-actually-works-the-two-phase-flow)
5. [Reading the result](#5-reading-the-result)
6. [Connecting to your terminal](#6-connecting-to-your-terminal)
7. [Every operation, explained](#7-every-operation-explained)
8. [Handling declines and errors](#8-handling-declines-and-errors)
9. [v1 vs v2: the protocol switch](#9-v1-vs-v2-the-protocol-switch)
10. [Full options reference](#10-full-options-reference)
11. [Testing without a real terminal](#11-testing-without-a-real-terminal)
12. [Glossary](#12-glossary)

---

## 1. The 30-second mental model

Your code is the **ECR** (Electronic Cash Register — i.e. your POS app). The **terminal** is the
physical card reader. This SDK is the bridge between them:

```
┌──────────────┐   TLV messages    ┌────────────────┐   card network   ┌──────────┐
│  Your POS    │ ───────────────▶  │  NAPS terminal │ ───────────────▶ │   Bank   │
│ (@tkpay/naps)│ ◀───────────────  │  (Sunmi/Lane)  │ ◀─────────────── │  / NAPS  │
└──────────────┘   result + receipt └────────────────┘                  └──────────┘
```

You never talk to the bank or handle card data yourself — the terminal does that. You send it
short text commands ("take 125 MAD"), it drives the whole card interaction, and it hands you back
a result. The SDK turns those commands and results into clean JavaScript objects.

> **Amounts are in MAD** (Moroccan dirham). You pass `pay(125)` for 125.00 MAD — the SDK converts
> to the centimes the terminal expects. Under the hood, `125` becomes `12500` centimes.

---

## 2. Install

> **Not published to the public npm registry.** Install directly from GitHub.

```bash
# from GitHub (latest on the default branch)
npm install github:Belkouche/tkpay-sdk-pos-naps-node

# pin to a released version tag (recommended)
npm install github:Belkouche/tkpay-sdk-pos-naps-node#v1.1.0
```

Or add it to `package.json` and run `npm install`:

```json
{
  "dependencies": {
    "@tkpay/naps": "github:Belkouche/tkpay-sdk-pos-naps-node#v1.1.0"
  }
}
```

Then import it by its package name as usual:

```ts
import { NapsClient } from "@tkpay/naps";
```

If you use an **Ingenico Lane over USB**, also install the (optional, native) serial driver:

```bash
npm install serialport
```

You do **not** need `serialport` for Sunmi/TCP terminals — the package works without it.

---

## 3. Your first payment (copy-paste)

```ts
import { NapsClient } from "@tkpay/naps";

// A Sunmi terminal on your local network at 192.168.1.50.
const naps = new NapsClient({
  transport: "tcp",
  tcpHost: "192.168.1.50",
});

const result = await naps.pay(125.0); // charge 125.00 MAD

if (result.isSuccess) {
  console.log(`✅ Approved. STAN ${result.stan}, card ${result.cardNumber}`);
} else {
  console.log(`❌ ${result.responseCode} — ${result.responseMessage}`);
}
```

That's a complete, working payment. Run it while a customer has their card ready. Everything
below explains what just happened and how to go further.

---

## 4. How a payment actually works (the two-phase flow)

A single `pay()` call runs **two round-trips** to the terminal. This is by design and matters for
correctness — it's how NAPS avoids charging a customer without your POS recording the sale.

```
  your code                         terminal
     │                                 │
     │  ── pay(125) ───────────────▶   │   Phase 1: Authorization (TM 001)
     │                                 │   → terminal prompts card, talks to the bank
     │  ◀── approved, STAN=703062 ──   │   ← money is authorized, but not yet committed
     │                                 │
     │  ── confirm(STAN 703062) ───▶   │   Phase 2: Confirmation (TM 002)
     │                                 │   → records the sale in the NAPS back office
     │  ◀── confirmed + receipt ────   │   ← done
     │                                 │
```

**The SDK does both phases for you inside `pay()`.** You just `await` one call. But knowing the
two phases exist explains a few results you might see:

- If Phase 1 is **declined**, `pay()` returns immediately — no Phase 2, `isSuccess: false`.
- If Phase 1 is **approved** but Phase 2 **times out**, you get `isSuccess: true` with
  `responseMessage: "Confirmation timed out"` — the money was authorized; reconcile if needed.
- Phase 2 must happen within ~40 seconds (a protocol deadline). The SDK handles the timing.

---

## 5. Reading the result

Every payment returns a `PaymentResult`. Here is every field and when it's set:

```ts
const r = await naps.pay(125.0);

r.isSuccess;         // boolean — true only if the payment was approved AND confirmed
r.isCancelled;       // boolean — true if this was a cancellation/reversal outcome
r.responseCode;      // "000" = approved; anything else is a decline/error (see §8)
r.responseMessage;   // human text — the printed receipt, or the code's meaning

r.stan;              // System Trace Audit Number — the transaction's unique id.
                     // KEEP THIS. You need it to cancel/void or reprint later.

r.cardNumber;        // masked PAN, e.g. "516794******3315" (never the full number)
r.cardholderName;    // if the card provided it
r.cardExpiry;        // "YYMM" if the card was read
r.authorizationNumber; // bank authorization code
r.transactionDate;   // "DDMMYYYY" as recorded by the terminal
r.transactionTime;   // "HHMMSS"

r.receiptText;       // raw receipt payload
r.receiptLines;      // parsed, printable lines (see below)
```

### Printing the receipt

`receiptLines` is already parsed into lines with formatting hints, so you can drive a printer:

```ts
import { receiptToText } from "@tkpay/naps";

if (r.receiptLines) {
  for (const line of r.receiptLines) {
    // line.text, line.bold (boolean), line.alignment ("left" | "center" | "right")
    console.log(line.bold ? line.text.toUpperCase() : line.text);
  }
  // …or get a ready-to-print block in one call:
  console.log(receiptToText(r.receiptLines, 40)); // 40-column width
}
```

---

## 6. Connecting to your terminal

### Sunmi P2/P3 — over the network (TCP)

The terminal and your POS must be on the **same network**. The terminal listens on **port 4444**.

```ts
const naps = new NapsClient({
  transport: "tcp",
  tcpHost: "192.168.1.50", // the terminal's IP address
  tcpPort: 4444,           // default, can be omitted
});
```

### Ingenico Lane — over USB (serial)

Plug the terminal in via USB. You can let the SDK **find it automatically** (it looks for the
Ingenico USB vendor id `0x0B00`), or pass the port path yourself.

```ts
// Option A — auto-discover:
const naps = new NapsClient({ transport: "serial" }); // path resolved on connect()

// Option B — see what's connected, then choose:
const ports = await NapsClient.listPorts();
console.log(ports); // [{ path: "/dev/tty.usbmodem1401", vendorId: "0b00", ... }]

const found = await NapsClient.findPort(); // "/dev/tty.usbmodem1401" | null
const naps = new NapsClient({ transport: "serial", serialPath: found ?? undefined });
```

> Serial needs the optional `serialport` package (`npm install serialport`). If it's missing, the
> SDK throws a clear message telling you to install it.

The SDK connects lazily on your first operation, so you don't have to call `connect()` yourself —
though you can, and should `disconnect()` when you're done:

```ts
await naps.connect();      // optional — happens automatically otherwise
// … payments …
naps.disconnect();         // release the socket / serial port
```

---

## 7. Every operation, explained

```ts
// Take a payment (two-phase, see §4). orderId is your own reference, optional.
const pay = await naps.pay(125.0, "order-4711");

// Cancel / void a previous payment by its STAN.
// On NapsPay v5.4.4 you MUST pass the original amount too.
const voided = await naps.cancel(pay.stan!, 125.0);

// Health check — is the terminal ↔ bank link alive? Call before a busy period.
const test = await naps.networkTest();      // { isSuccess, responseCode, message }

// Load terminal parameters ("referencing"). "01" = merchant params, "02" = recharge.
const ref = await naps.referencing("01");   // { isSuccess, parameterSet, receiptText }

// End-of-day totals ticket.
const totals = await naps.totals();         // { isSuccess, receiptText }

// Reprint the last transaction's receipt.
const dup = await naps.duplicateReceipt();  // PaymentResult (with receiptLines)

// Reset the PIN pad.
await naps.resetPinPad();
```

### A realistic sale-then-refund

```ts
const naps = new NapsClient({ transport: "tcp", tcpHost: "192.168.1.50" });

// 1) Make sure the terminal is reachable.
if (!(await naps.networkTest()).isSuccess) {
  throw new Error("Terminal offline — check the network");
}

// 2) Take the payment.
const sale = await naps.pay(240.0);
if (!sale.isSuccess) {
  console.log(`Declined: ${sale.responseCode} ${sale.responseMessage}`);
  return;
}
console.log(`Paid. Keep this STAN for refunds: ${sale.stan}`);

// 3) Later — refund it. You need the STAN and the original amount.
const refund = await naps.cancel(sale.stan!, 240.0);
console.log(refund.isSuccess ? "Refunded" : `Refund failed: ${refund.responseCode}`);

naps.disconnect();
```

---

## 8. Handling declines and errors

There are three distinct things that can go "wrong", and you handle them differently:

**1. A decline** — the terminal answered, but the bank said no. This is a *normal result*, not an
exception. `isSuccess` is `false` and `responseCode` tells you why:

```ts
const r = await naps.pay(50);
if (!r.isSuccess) {
  switch (r.responseCode) {
    case "116": console.log("Insufficient funds"); break;
    case "101": console.log("Card expired"); break;
    case "117": console.log("Wrong PIN"); break;
    default:    console.log(r.responseMessage); // human text for any code
  }
}
```

You don't have to memorize codes — `responseMessage` already carries the meaning, and you can look
any code up:

```ts
import { describeResponse } from "@tkpay/naps";
describeResponse("116"); // "Insufficient funds"
describeResponse("909"); // "System failure"
```

The full list is the spec §6 table, exported as `RESPONSE_CODES`. Codes `000/001/003/007` mean
approved; everything else is a decline or error.

**2. A timeout** — the terminal didn't answer in time (customer walked away, cable unplugged). The
SDK returns a result with `responseCode: "TIMEOUT"` rather than throwing, so your flow stays simple:

```ts
const r = await naps.pay(50);
if (r.responseCode === "TIMEOUT") console.log("No response — retry or check the terminal");
```

**3. A transport failure** — the socket couldn't even connect. This *throws*. Wrap connection-time
code in try/catch:

```ts
try {
  await naps.connect();
} catch (err) {
  console.error("Could not reach the terminal:", err);
}
```

---

## 9. v1 vs v2: the protocol switch

NAPS terminals come in two protocol generations. They differ in one wire detail that matters: how
a response message ends.

| `protocolVersion` | Response ends with | Confirmation carries §4.2 fields | Terminals |
|---|---|---|---|
| `"v2"` | `!` | yes (`MT`/`DE`/`NCAR`/`DAEX`) | Sunmi P2/P3 — NapsPay **v5.4.4+** |
| `"v1"` | `?` | no | Ingenico Lane — legacy |

**The default is chosen for you based on the transport, so you normally set nothing:**

- `transport: "tcp"` (Sunmi) → defaults to **`"v2"`**
- `transport: "serial"` (Ingenico) → defaults to **`"v1"`**

Only pass `protocolVersion` if your terminal is unusual (e.g. a Sunmi still on the old protocol, or
an Ingenico that has been updated). An explicit value always wins:

```ts
// Ingenico on USB — already defaults to v1, nothing to set:
const lane = new NapsClient({ transport: "serial" });

// Force a version only if you need to override the transport default:
const naps = new NapsClient({ transport: "tcp", protocolVersion: "v1" });
```

Getting this wrong isn't catastrophic — the SDK has a 1-second fallback if it doesn't see the
expected terminator — but matching it makes every transaction instant instead of adding ~1s.

---

## 10. Full options reference

```ts
new NapsClient({
  transport: "tcp",          // "tcp" (Sunmi) | "serial" (Ingenico). Default "tcp".

  // TCP transport
  tcpHost: "192.168.1.50",   // required for tcp
  tcpPort: 4444,             // default 4444
  tcpConnectTimeoutMs: 120_000,

  // Serial transport
  serialPath: "/dev/tty.usbmodem1401", // omit to auto-discover (VID 0x0B00)
  serialBaudRate: 115_200,
  protocolVersion: "v2",     // "v1" | "v2" — defaults per transport (serial→v1, tcp→v2); see §9

  // Identity (goes into the NCAI field)
  registerId: "01",          // 2 digits
  cashierId: "00001",        // 5 digits

  // Timeouts (milliseconds)
  paymentTimeoutMs: 120_000,      // Phase 1 authorization
  confirmationTimeoutMs: 40_000,  // Phase 2 confirmation (protocol deadline)
  testTimeoutMs: 30_000,
  referencingTimeoutMs: 60_000,
});
```

Every field is optional except `tcpHost` (for TCP). Defaults shown above.

---

## 11. Testing without a real terminal

You don't need hardware to develop. The [`tkpay-naps-emulator`](https://github.com/Belkouche/tkpay-naps-emulator)
is a Python program that behaves like a real NAPS terminal on `localhost:4444`.

```bash
# In one terminal — start the emulator (approves everything by default):
python3 naps_emulator.py

# It can also simulate declines and edge cases:
python3 naps_emulator.py --mode decline                 # every payment declined
python3 naps_emulator.py --mode error --code insufficient_funds
python3 naps_emulator.py --protocol v1                  # legacy '?' terminator
```

Point the SDK at it:

```ts
const naps = new NapsClient({ transport: "tcp", tcpHost: "127.0.0.1", tcpPort: 4444 });
await naps.pay(10); // → approved by the emulator
```

### Running this SDK's own tests

```bash
npm test              # everything (unit + integration)
npm run test:unit     # pure logic — protocol, receipt, client, discovery
npm run test:integration  # drives the Python emulator (auto-skips if not installed)
```

Unit tests need nothing installed. The integration suite spawns the emulator automatically and is
skipped cleanly if it isn't present on your machine.

---

## 12. Glossary

| Term | Meaning |
|---|---|
| **ECR** | Electronic Cash Register — your POS application (this SDK's caller). |
| **STAN** | System Trace Audit Number — a transaction's unique id. Save it to cancel/reprint. |
| **TLV** | Tag-Length-Value — the compact text format messages are encoded in. The SDK hides it. |
| **NCAI** | Register + cashier identifier sent with each request (`registerId` + `cashierId`). |
| **TIDE** | Which parameter set to load during *referencing*: `01` merchant, `02` recharge. |
| **DATR / HETR** | Original transaction date / time — echoed back on a cancellation. |
| **Two-phase** | Authorization (TM 001) then Confirmation (TM 002) — see §4. |
| **Response code** | 3-digit outcome. `000` = approved. Look any code up with `describeResponse()`. |

---

## License

MIT
