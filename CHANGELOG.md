# Changelog

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
- **fix (PCI):** NCAR (007) is masked in `parseMessage`, so the full PAN never leaves the
  parser; 16-digit PANs are masked in receipt lines and in `receiptText` /
  `responseMessage`, including the totals and referencing receipts (`maskPansInText`).
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
