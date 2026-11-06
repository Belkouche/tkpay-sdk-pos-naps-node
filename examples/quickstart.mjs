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
  console.log(receiptToText(result.receiptLines ?? []));
} else {
  console.log(`Declined — ${result.responseCode}: ${result.responseMessage}`);
}
naps.disconnect();
