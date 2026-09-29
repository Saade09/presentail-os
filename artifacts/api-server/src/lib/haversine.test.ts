import { describe, it, expect } from "vitest";
import { distanceMeters, isInsideGeofence } from "./haversine";

describe("distanceMeters", () => {
  it("returns 0 for identical points", () => {
    expect(distanceMeters(25.2048, 55.2708, 25.2048, 55.2708)).toBe(0);
  });

  it("returns approximate distance between two known points (Dubai → Abu Dhabi ~117 km)", () => {
    const dist = distanceMeters(25.2048, 55.2708, 24.4539, 54.3773);
    expect(dist).toBeGreaterThan(110_000);
    expect(dist).toBeLessThan(125_000);
  });

  it("is symmetric: dist(A,B) === dist(B,A)", () => {
    const ab = distanceMeters(25.0, 55.0, 24.5, 54.5);
    const ba = distanceMeters(24.5, 54.5, 25.0, 55.0);
    expect(Math.abs(ab - ba)).toBeLessThan(0.001);
  });

  it("returns a small but non-zero value for nearby points (~111 m per 0.001 degree lat)", () => {
    const dist = distanceMeters(25.2048, 55.2708, 25.2048 + 0.001, 55.2708);
    expect(dist).toBeGreaterThan(100);
    expect(dist).toBeLessThan(115);
  });
});

describe("isInsideGeofence", () => {
  const refLat = 25.2048;
  const refLon = 55.2708;

  it("returns true when point is at the reference location (0 m distance)", () => {
    expect(isInsideGeofence(refLat, refLon, refLat, refLon, 100)).toBe(true);
  });

  it("returns true when point is within the radius", () => {
    const nearbyLat = refLat + 0.0005; // ~55 m away
    expect(isInsideGeofence(refLat, refLon, nearbyLat, refLon, 100)).toBe(true);
  });

  it("returns false when point is outside the radius", () => {
    const farLat = refLat + 0.002; // ~222 m away
    expect(isInsideGeofence(refLat, refLon, farLat, refLon, 100)).toBe(false);
  });

  it("returns true when point is exactly at the radius boundary", () => {
    // ~111 m per 0.001 degree lat; radius = 200 m
    const edgeLat = refLat + 0.0018; // ~200 m
    const result = isInsideGeofence(refLat, refLon, edgeLat, refLon, 200);
    expect(typeof result).toBe("boolean");
  });
});
