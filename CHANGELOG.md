# Changelog

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
