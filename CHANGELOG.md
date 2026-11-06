# Changelog

## v1.2.0 — NapsPay v5.4.4 sync with the canonical C# SDK

Brings the Node port in line with `tkpay-sdk-pos-naps-csharp` v1.4.0 (NapsPay v5.4.4,
TLV spec v2.0). Additive; no breaking changes.

- **feat:** `settlement()` — TM 010 telecollecte (TM + NCAI + DA + HE, no NS) →
  `SettlementResult` `{ isSuccess, responseCode, message, date, time }`; CR 052 maps to
  "Already settled today", 909 to "Terminal or server is down".
- **feat:** `cancel(stan, amountMad?, originalSequence?)` — the original sequence is sent
  as NSA (005), as in the C# cancellation frame. TM 103 and TM 104 both count as success.
- **feat:** `pay()` now returns the Phase-2 (TM 102) DP as the customer receipt
  (`customerReceiptText` / `customerReceiptLines`), plus `entryMode` (EM 040), `ncai`
  and `sequence` from the response.
- **feat:** full v5.4.4 tag set (NHC 006, TYPA–MDLC 021–028, EM 040), `RECEIPT_TAG`
  sub-tags (030–033), response message types (101…113) in `TM`, and `buildSettlement`.
- **fix (PCI):** NCAR (007) is masked in `parseMessage`, so the full PAN never leaves the
  parser; 16-digit PANs are masked in receipt lines and in `receiptText` /
  `responseMessage` (`maskPansInText`).
- **fix:** management operations (network test, referencing, totals, duplicate, reset)
  now send the client's NCAI and a fresh sequence instead of the hard-coded
  `0100001` / `000001`.
- **fix:** `duplicateReceipt()` reported `isSuccess: false` even on CR 000.
- **fix:** `referencing()` returns the requested TIDE as `parameterSet` when the terminal
  doesn't echo it.
- **fix:** TCP/serial reads end immediately on a chunk ending in either terminator
  (`!` or `?`), instead of waiting for the 1s silence fallback on a v1/v2 mismatch.
- **test:** integration suite port is overridable via `NAPS_EMULATOR_PORT`.

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
