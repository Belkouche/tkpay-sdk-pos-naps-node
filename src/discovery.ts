/**
 * Serial-port discovery for Ingenico Lane terminals and Sunmi terminals over USB.
 *
 * Port of the C# `PortDiscovery`. Uses the optional `serialport` package's
 * `SerialPort.list()` (cross-platform vendor/product ids), so no per-OS ioreg /
 * registry scraping is needed. Ingenico terminals enumerate under USB VID 0x0B00.
 */

/** Ingenico USB vendor id (0x0B00 = 2816), as the hex string serialport reports. */
export const INGENICO_VENDOR_ID = "0b00";

/**
 * USB vendor id of a Sunmi P2 (0x05C6, Qualcomm, the chip maker), as serialport reports it. A
 * live P2 enumerated as manufacturer "SUNMI", vendor 05c6, product 901f.
 */
export const SUNMI_VENDOR_ID = "05c6";

function isSunmi(p: PortInfo): boolean {
  return /sunmi/i.test(p.manufacturer ?? "") || p.vendorId?.toLowerCase() === SUNMI_VENDOR_ID;
}

export interface PortInfo {
  path: string;
  vendorId?: string;
  productId?: string;
  manufacturer?: string;
}

/**
 * Choose the most likely Ingenico port from a list. Prefers an exact vendor-id
 * match; otherwise falls back to the first CDC-ACM style device (usbmodem/ttyACM) that is not a
 * Sunmi. Pure and synchronous so it is unit-testable without hardware.
 */
export function pickIngenicoPort(ports: PortInfo[]): string | null {
  const byVid = ports.find((p) => p.vendorId?.toLowerCase() === INGENICO_VENDOR_ID);
  if (byVid) return byVid.path;

  const cdcAcm = ports.find((p) => /usbmodem|ttyACM/i.test(p.path) && !isSunmi(p));
  return cdcAcm ? cdcAcm.path : null;
}

/**
 * Choose the Sunmi port from a list: manufacturer "SUNMI", or the Sunmi vendor id (05c6). No
 * fallback to any other port, which could be an Ingenico.
 */
export function pickSunmiPort(ports: PortInfo[]): string | null {
  const bySunmi = ports.find((p) => /sunmi/i.test(p.manufacturer ?? ""));
  if (bySunmi) return bySunmi.path;
  const byVid = ports.find((p) => p.vendorId?.toLowerCase() === SUNMI_VENDOR_ID);
  return byVid ? byVid.path : null;
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

/** Auto-discover the Sunmi USB port, or null if none is found. */
export async function findSunmiPort(): Promise<string | null> {
  const ports = await listPorts();
  return pickSunmiPort(ports);
}
