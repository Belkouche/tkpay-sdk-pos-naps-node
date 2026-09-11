import { describe, it, expect } from "vitest";
import { pickIngenicoPort, INGENICO_VENDOR_ID } from "../src/discovery.js";

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
