import { describe, expect, test } from "bun:test";
import { containsLegacyVersionSentinel, containsVersionStamp } from "../native/version-sentinel.js";

describe("containsVersionStamp", () => {
	test("accepts a stamp carrying exactly the release version", () => {
		const addon = Buffer.from(`garbage\x00PI_NATIVES_VERSION_STAMP:18.1.10\x00${"\0".repeat(64)}`, "utf8");
		expect(containsVersionStamp(addon, "18.1.10")).toBe(true);
	});

	test("rejects a stamp for a different release", () => {
		const addon = Buffer.from(`PI_NATIVES_VERSION_STAMP:18.1.10\x00${"\0".repeat(64)}`, "utf8");
		expect(containsVersionStamp(addon, "18.1.1")).toBe(false);
		expect(containsVersionStamp(addon, "")).toBe(false);
	});
});

describe("containsLegacyVersionSentinel", () => {
	test("accepts a sentinel followed by a non-identifier byte", () => {
		expect(containsLegacyVersionSentinel(Buffer.from("__piNativesV18_0_5"), "18.0.5")).toBe(true);
		expect(containsLegacyVersionSentinel(Buffer.from("x\x00__piNativesV18_0_5\x00y"), "18.0.5")).toBe(true);
	});

	test("rejects a longer sentinel that only shares the prefix", () => {
		// Regression: a substring check previously accepted this, letting an
		// 18.1.10 addon satisfy a lookup for 18.1.1.
		expect(containsLegacyVersionSentinel(Buffer.from("__piNativesV18_1_10"), "18.1.1")).toBe(false);
	});

	test("rejects a sentinel that is only a prefix of the expected one", () => {
		expect(containsLegacyVersionSentinel(Buffer.from("__piNativesV18_1_1"), "18.1.10")).toBe(false);
	});

	test("reports a later exact match when an earlier one is a prefix of a longer sentinel", () => {
		// The first occurrence is a valid exact match even though a later one
		// is a prefix of a longer sentinel; the scan must keep going after a
		// rejected candidate.
		const bytes = Buffer.from("garbage__piNativesV18_1_1\x01__piNativesV18_1_1z");
		expect(containsLegacyVersionSentinel(bytes, "18.1.1")).toBe(true);
	});

	test("rejects an absent sentinel", () => {
		expect(containsLegacyVersionSentinel(Buffer.from("__piNativesV18_0_4"), "18.0.5")).toBe(false);
		expect(containsLegacyVersionSentinel(Buffer.alloc(0), "18.0.5")).toBe(false);
		expect(containsLegacyVersionSentinel(Buffer.from("data"), "")).toBe(false);
	});
});
