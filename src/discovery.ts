/**
 * Serial-port discovery for Ingenico Lane terminals.
 *
 * Port of the C# `PortDiscovery`. Uses the optional `serialport` package's
 * `SerialPort.list()` (cross-platform vendor/product ids), so no per-OS ioreg /
 * registry scraping is needed. Ingenico terminals enumerate under USB VID 0x0B00.
 */

/** Ingenico USB vendor id (0x0B00 = 2816), as the hex string serialport reports. */
export const INGENICO_VENDOR_ID = "0b00";

export interface PortInfo {
  path: string;
  vendorId?: string;
  productId?: string;
  manufacturer?: string;
}

/**
 * Choose the most likely Ingenico port from a list. Prefers an exact vendor-id
 * match; otherwise falls back to the first CDC-ACM style device (usbmodem/ttyACM).
 * Pure and synchronous so it is unit-testable without hardware.
 */
export function pickIngenicoPort(ports: PortInfo[]): string | null {
  const byVid = ports.find((p) => p.vendorId?.toLowerCase() === INGENICO_VENDOR_ID);
  if (byVid) return byVid.path;

  const cdcAcm = ports.find((p) => /usbmodem|ttyACM/i.test(p.path));
  return cdcAcm ? cdcAcm.path : null;
}

async function loadSerialPortList(): Promise<() => Promise<PortInfo[]>> {
  try {
    const mod = (await import("serialport")) as {
      SerialPort: { list(): Promise<PortInfo[]> };
    };
    return () => mod.SerialPort.list();
  } catch {
    throw new Error(
      "The 'serialport' package is required for port discovery. Install it with: npm install serialport",
    );
  }
}

/** List all available serial ports (requires the optional `serialport` package). */
export async function listPorts(): Promise<PortInfo[]> {
  const list = await loadSerialPortList();
  return list();
}

/** Auto-discover the Ingenico Lane port, or null if none is found. */
export async function findIngenicoPort(): Promise<string | null> {
  const ports = await listPorts();
  return pickIngenicoPort(ports);
}
