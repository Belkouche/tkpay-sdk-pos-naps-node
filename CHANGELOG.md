# Changelog

## Unreleased — Ingenico Lane3600 fixes

Found on a live Lane3600 over USB. The terminal holds back every answer until about 30 s
after the port opens, so the first request of a session always answered at 30.1 s.

- **fix (USB serial, payment confirmation):** the first frame after the port opens waits until
  the port has been open 32 s. When a payment was the first frame, its TM 101 arrived 30 s late,
  after the terminal had stopped waiting for TM 002: it showed "attente validation caisse",
  timed out, and the authorised payment was not recorded. Keep the client connected between
  transactions so the wait happens once.
- **fix (network test):** `networkTest()` is USB serial only. Over TCP it sends nothing and
  returns `responseCode: "UNSUPPORTED"`: the NapsPay app on a Sunmi P2 answers TM 009 with
  TM 101 / CR 902 (it only handles payments and voids over the ECR link), and a test frame
  crashed the app.
- **fix (timeouts):** `testTimeoutMs` now defaults to 90 s (was 30 s). At 30 s, `cancel()`
  gave up on TM 003 just before the terminal answered, and the terminal then stayed on its
  void screen waiting for a TM 004 that never came.
- **fix (timeouts):** `duplicateReceipt()` and `resetPinPad()` use `testTimeoutMs` instead
  of a fixed 15 s, which was too short for the Lane3600.
- **fix (void receipt):** when TM 103 carries no receipt, as on the Lane3600, `cancel()` returns
  the TM 104 receipt (the only void receipt, "SIGNATURE CLIENT") as `merchantReceiptLines` and
  `receiptLines` instead of `customerReceiptLines`. Terminals that send a receipt with TM 103 are
  unchanged.
- **fix (USB serial, back-to-back operations):** after a reply the Lane3600 keeps showing or
  printing the result for a moment, and a request arriving then is lost (found with the C# SDK:
  a void sent right after a payment got no reply, and a payment sent 0.5 s after a network test
  was refused with CR 100 without a card prompt). A request that starts a new operation now
  waits 3 s after the terminal's last reply; the confirmations (TM 002, TM 004) wait 0.5 s.
- **change (USB serial):** the port opens with DTR/RTS asserted and keeps them on close
  (`hupcl: false`), and every frame ends with the protocol terminator (`!` v2, `?` v1).
- **fix (USB serial):** after a timeout or error the port is closed, so a reply that
  arrives late is never read as the answer to the next request. The next call reopens
  the port (and waits again for the Lane3600).
- **fix (reader, USB and TCP):** a reply ends only when the data received ends with a
  terminator (`!` or `?`), as in the C# reader. It used to stop at the first `!` anywhere, so a
  `!` inside receipt text cut the reply short; on the kept-open serial port the rest could be
  read as the next reply.
- **fix (USB serial):** `disconnect()` no longer crashes the process when the port is
  already gone (cable unplugged, terminal rebooted). It used to make serialport emit an
  unhandled "Port is not open" error.

## v1.2.1 — card number masking

- **fix (card number masking):** card numbers are masked (first 6 + last 4 digits) in
  `parseMessage`, before anything else sees the reply. NCAR (007) is always returned as
  first 6 + `*` + last 4 whatever its grouping; inside the DP (010) receipt text every run of
  13+ digits (adjacent, or separated by one space, dash, dot, tab or non-breaking space) keeps
  only its first 6 and last 4 digits, separators unchanged (`maskPansInText`). Receipt masking is done value by value so every line keeps its exact
  content otherwise. The full number is never exposed in a result, receipt, frame sent back
  to the terminal or error, and the SDK never logs it.

## v1.2.0 — NapsPay v5.4.4 sync with the canonical C# SDK

Brings the Node port in line with `tkpay-sdk-pos-naps-csharp` v1.5.0 (NapsPay v5.4.4,
TLV spec v2.0). Additive; no breaking changes.

- **feat:** `settlement()` — TM 010 telecollecte (TM + NCAI + DA + HE, no NS) →
  `SettlementResult` `{ isSuccess, responseCode, message, date, time }`; CR 052 maps to
  "Already settled today", 909 to "Terminal or server is down".
- **feat:** two-phase void per TLV spec v2.0 §4.3–4.4 (cross-checked with the live v5.4.4
  terminal test in `tkpay-sdk-pos-naps-rn` 5fcfeb0). `cancel(stan, amountMad?,
  originalSequence?)` sends TM 003 → TM 103, then **TM 004 (Cancellation Confirmation)** →
  TM 104 on the same connection. TM 103 CR=000 only means "transaction found"; TM 004
  executes the reversal.
  - TM 104 **CR 000 or 480** = void completed: `isSuccess`, void STAN and customer receipt
    (`customerReceiptText` / `customerReceiptLines`) from TM 104; merchant receipt from TM 103.
  - **Fails closed:** no TM 104 reply (timeout), or TM 104 **CR 995** (seen with completed
    voids on live terminals), returns `isSuccess: false` with **`isPending: true`**, keeping
    the STAN and the TM 103 merchant receipt — verify with `duplicateReceipt(stan)`.
  - Any other TM 104 code fails the void. A TM 103 with CR ≠ 000 (including 480) fails
    without sending TM 004; a terminal answering TM 003 directly with TM 104 000/480 is
    still accepted.
  - TM 004 frame: TM, NCAI, **NS = the TM 003 NS** (no NSA), STAN, MT echoed verbatim from
    TM 103 (the live terminal refuses TM 004 without it) + DE, DATR/HETR echoed from
    TM 103, DA, HE. The original sequence is sent as NSA (005) on TM 003 only.
  - New `buildCancellationConfirmation`, `TM.CANCELLATION_CONFIRMATION` ("004"),
    `TM.CANCELLATION_CONFIRMATION_RESPONSE` ("104") and `PaymentResult.isPending`;
    `TM.CANCELLATION_CORRECTION` is kept as a deprecated alias.
- **feat:** `duplicateReceipt(stan?)` sends the STAN (008) to reprint a specific payment
  of the current business day (spec §4.6); omitted = last transaction.
- **fix:** a refused payment confirmation (TM 102 with CR ≠ 000, e.g. 302 sale not found,
  482 already cancelled — the terminal auto-reverses) is now `isSuccess: false` with that
  `responseCode`, instead of an approval with a "Confirmation failed" message.
- **feat:** `pay()` now returns the Phase-2 (TM 102) DP as the customer receipt
  (`customerReceiptText` / `customerReceiptLines`), plus `entryMode` (EM 040), `ncai`
  and `sequence` from the response.
- **feat:** full v5.4.4 tag set (NHC 006, TYPA–MDLC 021–028, EM 040), `RECEIPT_TAG`
  sub-tags (030–033), response message types (101…113) in `TM`, and `buildSettlement`.
- **fix (PAN masking):** NCAR (007) is masked in `parseMessage`, so the full PAN never leaves the
  parser; 16-digit PANs are masked in receipt lines and in `receiptText` /
  `responseMessage`, including the totals and referencing receipts (`maskPansInText`).
- **fix (receipts):** the DP parser is now length-driven. It used to split the block on `*`,
  which cut the masked-PAN line (`516794******3315`) and returned it blank; any `*` or `?`
  inside a line's text is now kept. Every line is returned in order with its line number,
  bold and alignment; nothing is added, merged or dropped.
- **feat (receipts):** `merchantReceiptText` / `merchantReceiptLines` (TM 101 on payments,
  TM 103 on voids, kept on pending voids) alongside `customerReceiptText` /
  `customerReceiptLines` (TM 102 / TM 104); `totals()` and `referencing()` also return
  parsed `receiptLines`. Golden tests check the emulator's merchant and customer copies.
- **fix:** management operations (network test, referencing, totals, duplicate, reset)
  now send the client's NCAI and a fresh sequence instead of the hard-coded
  `0100001` / `000001`.
- **fix:** `duplicateReceipt()` reported `isSuccess: false` even on CR 000.
- **fix:** `referencing()` returns the requested TIDE as `parameterSet` when the terminal
  doesn't echo it.
- **fix:** TCP/serial reads end immediately on a chunk ending in either terminator
  (`!` or `?`), instead of waiting for the 1s silence fallback on a v1/v2 mismatch.
- **test:** integration suite emulator path and port are overridable via `NAPS_EMULATOR`
  and `NAPS_EMULATOR_PORT`; new suites cover the two-phase void and the emulator's
  `decline`, `error`, `confirm_error`, `void_480`, `void_995`, `void_no_confirm` and
  `void_refuse` (302, 482) modes (emulator `tkpay-naps-emulator` 5cc8536).

## v1.1.1 — installable from GitHub

- Added a `prepare` script (`tsup`) so `dist/` builds automatically on a git install
  (`dist/` is gitignored). `npm install github:Belkouche/tkpay-sdk-pos-naps-node#v1.1.1`
  now works out of the box — the v1.1.0 tag lacked this and shipped no build.
- README documents install-from-GitHub (not published to the public npm registry).
- No code/API changes.

## v1.1.0 — rebrand to @tkpay/naps

- **Renamed** from `@aslan/naps` to **`@tkpay/naps`** and moved to
  `tkpay-sdk-pos-naps-node`, joining the canonical NAPS SDK family (the C# SDK
  `tkpay-sdk-pos-naps-csharp` is the reference implementation). The previous package
  (`@aslan/naps` / `aslan-naps-node`) is retired.
- No API changes — same `NapsClient`, transports, and behavior. To migrate, change the
  install/import from `@aslan/naps` to `@tkpay/naps`.

## v1.0.1

- **fix:** the Ingenico (serial) transport now defaults to protocol **v1** (`?`
  terminator), while Sunmi (TCP) stays on **v2** (`!`). The protocol default is
  now chosen from the transport via `resolveOptions()` instead of a single global
  `v2` default; an explicit `protocolVersion` still overrides. A real Ingenico
  Lane needs v1, so the previous global v2 default was a latent bug for serial.
- **docs:** rewrote the README to be didactic (mental model, two-phase flow,
  per-field result reference, error handling, v1/v2, glossary); updated §9 and the
  options table for the per-transport default.

## v1.0.0

- Initial release. Node.js SDK for NAPS Pay M2M terminals (TypeScript, dual
  ESM+CJS). TCP (Sunmi P2/P3) + USB serial (Ingenico Lane) transports; TLV v2
  protocol with v1/v2 selectable; two-phase payment, cancel, network test,
  referencing (TIDE), totals, duplicate, reset; Ingenico port auto-discovery.
  47 tests (unit + emulator integration).
