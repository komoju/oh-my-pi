import { describe, expect, test } from "bun:test";
import { containsVersionSentinel, versionSentinelFor } from "../native/version-sentinel.js";

describe("containsVersionSentinel", () => {
	test("accepts a sentinel followed by a non-identifier byte", () => {
		expect(containsVersionSentinel(Buffer.from("__piNativesV18_0_5"), "__piNativesV18_0_5")).toBe(true);
		expect(containsVersionSentinel(Buffer.from("x\x00__piNativesV18_0_5\x00y"), "__piNativesV18_0_5")).toBe(true);
	});

	test("rejects a longer sentinel that only shares the prefix", () => {
		// Regression: the substring check previously accepted this, letting an
		// 18.1.10 addon satisfy a lookup for 18.1.1.
		expect(containsVersionSentinel(Buffer.from("__piNativesV18_1_10"), "__piNativesV18_1_1")).toBe(false);
	});

	test("rejects a sentinel that is only a prefix of the expected one", () => {
		expect(containsVersionSentinel(Buffer.from("__piNativesV18_1_1"), "__piNativesV18_1_10")).toBe(false);
	});

	test("reports the last match when earlier matches are prefix-insulated", () => {
		// "__piNativesV18_1_1__piNativesV18_1_1z" — the first occurrence is a
		// valid exact match even though a later one is a prefix of a longer
		// sentinel; the scan must keep going after a rejected candidate.
		const bytes = Buffer.from("garbage__piNativesV18_1_1\x01__piNativesV18_1_1z");
		expect(containsVersionSentinel(bytes, "__piNativesV18_1_1")).toBe(true);
	});

	test("rejects an absent sentinel", () => {
		expect(containsVersionSentinel(Buffer.from("__piNativesV18_0_4"), "__piNativesV18_0_5")).toBe(false);
		expect(containsVersionSentinel(Buffer.alloc(0), "__piNativesV18_0_5")).toBe(false);
		expect(containsVersionSentinel(Buffer.from("data"), "")).toBe(false);
	});
});

describe("versionSentinelFor", () => {
	test("maps non-alphanumerics to underscores", () => {
		expect(versionSentinelFor("18.0.5")).toBe("__piNativesV18_0_5");
		expect(versionSentinelFor("18.0.5-beta.1")).toBe("__piNativesV18_0_5_beta_1");
	});
});
