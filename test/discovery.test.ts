import { describe, it, expect } from "vitest";
import { pickIngenicoPort, pickSunmiPort, INGENICO_VENDOR_ID } from "../src/discovery.js";

describe("pickIngenicoPort", () => {
  const ingenico = { path: "/dev/cu.usbmodem1401", vendorId: "0b00", productId: "0060" };
  const other = { path: "/dev/cu.Bluetooth", vendorId: undefined, productId: undefined };
  const ftdi = { path: "/dev/cu.usbserial-A1", vendorId: "0403", productId: "6001" };

  it("knows the Ingenico vendor id", () => {
    expect(INGENICO_VENDOR_ID.toLowerCase()).toBe("0b00");
  });

  it("matches an Ingenico port by vendor id (case-insensitive)", () => {
    expect(pickIngenicoPort([other, ingenico, ftdi])).toBe("/dev/cu.usbmodem1401");
    expect(pickIngenicoPort([{ ...ingenico, vendorId: "0B00" }])).toBe("/dev/cu.usbmodem1401");
  });

  it("falls back to a usbmodem port when no vendor id matches", () => {
    const bareModem = { path: "/dev/cu.usbmodem9999", vendorId: undefined, productId: undefined };
    expect(pickIngenicoPort([other, bareModem])).toBe("/dev/cu.usbmodem9999");
  });

  it("returns null when nothing plausible is present", () => {
    expect(pickIngenicoPort([other, ftdi])).toBeNull();
    expect(pickIngenicoPort([])).toBeNull();
  });
});

describe("pickSunmiPort", () => {
  // As serialport listed a live Sunmi P2 on macOS.
  const sunmi = { path: "/dev/tty.usbmodemPD092513023394", manufacturer: "SUNMI", vendorId: "05c6", productId: "901f" };
  const lane = { path: "/dev/cu.usbmodem1401", vendorId: "0b00", productId: "0060" };
  const bareModem = { path: "/dev/cu.usbmodem9999" };

  it("matches the Sunmi by manufacturer, or by vendor id (e.g. a Windows COM port)", () => {
    expect(pickSunmiPort([lane, sunmi])).toBe(sunmi.path);
    expect(pickSunmiPort([lane, { path: "COM5", vendorId: "05C6", productId: "901F" }])).toBe("COM5");
  });

  it("never falls back to another port", () => {
    expect(pickSunmiPort([lane, bareModem])).toBeNull();
  });

  it("is skipped by the Ingenico fallback", () => {
    expect(pickIngenicoPort([sunmi])).toBeNull();
    expect(pickIngenicoPort([sunmi, bareModem])).toBe(bareModem.path);
    expect(pickIngenicoPort([sunmi, lane])).toBe(lane.path);
  });
});
