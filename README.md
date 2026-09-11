# @aslan/naps

Node.js SDK for **NAPS Pay M2M** payment terminals — Sunmi P2/P3 over **TCP** and Ingenico Lane over **USB serial**. ASCII TLV protocol, conformant with the NapsPay ECR↔Terminal TLV Protocol **Specification v2.0** (NapsPay v5.4.4).

TypeScript, dual ESM + CJS. Port of the `Aslan.Naps` C# SDK.

## Install

```bash
npm install @aslan/naps
# USB serial is optional (native module); only needed for Ingenico Lane:
npm install serialport
```

## Quickstart (TCP — Sunmi P2/P3)

```ts
import { NapsClient } from "@aslan/naps";

const naps = new NapsClient({ transport: "tcp", tcpHost: "192.168.1.50", tcpPort: 4444 });

// Two-phase payment (authorization + confirmation)
const res = await naps.pay(125.0); // 125.00 MAD
if (res.isSuccess) {
  console.log("Approved", res.stan, res.cardNumber);
} else {
  console.log("Declined", res.responseCode, res.responseMessage);
}
```

## USB serial (Ingenico Lane) — with v1/v2 protocol switch

```ts
import { NapsClient } from "@aslan/naps";

// Explicit port, or omit serialPath to auto-discover the Ingenico terminal:
const port = await NapsClient.findPort(); // → "/dev/tty.usbmodem1401" | null

const naps = new NapsClient({
  transport: "serial",
  serialPath: port ?? undefined,   // undefined → discovered on connect()
  protocolVersion: "v2",           // "v1" (legacy '?' terminator) | "v2" (default, '!')
});

await naps.pay(50.0);
```

`protocolVersion` selects the NAPS TLV generation for the terminal:

| | Response terminator | Confirmation §4.2 fields |
|---|---|---|
| `"v1"` | `?` | ignored by the terminal |
| `"v2"` (default) | `!` | `MT`/`DE`/`NCAR`/`DAEX` echoed |

## API

```ts
const naps = new NapsClient(options);

await naps.pay(amountMad, orderId?)      // PaymentResult — two-phase (TM 001 → 002)
await naps.cancel(stan, amountMad?)      // PaymentResult — void by STAN (amount required on v5.4.4)
await naps.networkTest()                 // TestResult    — TM 009
await naps.referencing(tide?)            // ReferencingResult — TM 013; tide "01" merchant | "02" recharge
await naps.totals()                      // TotalsResult  — TM 010
await naps.duplicateReceipt()            // PaymentResult — TM 008
await naps.resetPinPad()                 // void          — TM 012

NapsClient.findPort()                    // Promise<string | null> — auto-discover Ingenico port
NapsClient.listPorts()                   // Promise<PortInfo[]>
```

### Options

| Option | Default | Notes |
|---|---|---|
| `transport` | `"tcp"` | `"tcp"` (Sunmi) or `"serial"` (Ingenico) |
| `tcpHost` / `tcpPort` | — / `4444` | TCP transport |
| `serialPath` | auto-discover | omit to find the Ingenico port by USB VID `0x0B00` |
| `serialBaudRate` | `115200` | |
| `protocolVersion` | `"v2"` | `"v1"` \| `"v2"` (serial + TCP terminator) |
| `registerId` / `cashierId` | `"01"` / `"00001"` | NCAI field |
| `paymentTimeoutMs` | `120000` | |
| `confirmationTimeoutMs` | `40000` | protocol deadline |

## Testing

Unit tests are pure (no hardware). The integration suite drives the Python
[`tkpay-naps-emulator`](https://github.com/Belkouche/tkpay-naps-emulator); it is
skipped automatically if the emulator is not present locally.

```bash
npm test              # all tests
npm run test:unit     # tlv / receipt / client / discovery
npm run test:integration
```

## License

MIT
