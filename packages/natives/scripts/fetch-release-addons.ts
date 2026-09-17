#!/usr/bin/env bun
/**
 * Fetch the released linux-x64 pi_natives addons from the upstream
 * @oh-my-pi/pi-natives-linux-x64 npm leaf package into packages/natives/native.
 *
 * The GitHub release does not ship .node files (only omp binaries, the browser
 * relay zip, LICENSE, THIRD-PARTY-NOTICES.txt, SHA256SUMS.txt); the linux-x64
 * addons are published to npm as the @oh-my-pi/pi-natives-linux-x64 leaf. This
 * mirrors the CI PR path (.github/workflows/ci.yml "Fetch release native
 * addons (npm)") so a checkout that cannot bazel-build can still load the
 * shipped addons.
 *
 * Version resolution:
 *   - --ref <ver>  download exactly this version (e.g. 18.0.6). No network
 *                  version lookup; the tarball URL is deterministic.
 *   - --ref canary / --ref latest   the npm dist-tag of the leaf package
 *   - default      the workspace catalog version of @oh-my-pi/pi-natives in
 *                  the root package.json (what this checkout expects), fetched
 *                  via `npm view`.
 *
 * The destination defaults to packages/natives/native, overridable with
 * --dest. Downloads go to <dest>/.fetch-tmp/<name>.part and are resumed with
 * curl -C -; the tarball is verified against the registry's dist.integrity
 * (sha512) before extraction, and the fetched files only land as their final
 * names once a tar listing has verified the tarball contains exactly the two
 * expected addons. On-disk files are only considered up to date when they
 * carry the requested release's `__piNativesV…` version sentinel (exact
 * match, so `__piNativesV18_1_10` cannot satisfy a lookup for
 * `__piNativesV18_1_1`) — stale addons from an older checkout are refetched
 * rather than silently skipped, so a release build never embeds addons that
 * mismatch the loader.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { containsVersionSentinel, versionSentinelFor } from "../native/version-sentinel.js";

const repoRoot = path.join(import.meta.dir, "../../..");
const nativeDirDefault = path.join(repoRoot, "packages/natives/native");
const leafPackage = "@oh-my-pi/pi-natives-linux-x64";
const expectedFiles = ["pi_natives.linux-x64-baseline.node", "pi_natives.linux-x64-modern.node"] as const;

interface CliOptions {
	ref: string | null;
	dest: string;
	dryRun: boolean;
}

function parseCliArgs(argv: string[]): CliOptions {
	let ref: string | null = null;
	let dest: string | null = null;
	let dryRun = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--ref") {
			ref = argv[++i];
			if (!ref) throw new Error("--ref requires a version, dist-tag, or --latest/--canary");
		} else if (arg === "--latest" || arg === "--canary") {
			ref = arg.slice(2);
		} else if (arg === "--dest") {
			dest = argv[++i];
			if (!dest) throw new Error("--dest requires a directory argument");
		} else if (arg === "--dry-run") {
			dryRun = true;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return { ref, dest: dest ? path.resolve(dest) : nativeDirDefault, dryRun };
}

/** Read the workspace catalog version of @oh-my-pi/pi-natives from the root manifest. */
async function catalogVersion(): Promise<string> {
	const rootPkg = (await Bun.file(path.join(repoRoot, "package.json")).json()) as {
		workspaces?: { catalog?: Record<string, string> };
	};
	const version = rootPkg.workspaces?.catalog?.["@oh-my-pi/pi-natives"];
	if (!version) throw new Error("Could not find @oh-my-pi/pi-natives in root package.json workspaces.catalog");
	return version;
}

const tarballUrl = (version: string) =>
	`https://registry.npmjs.org/${leafPackage}/-/pi-natives-linux-x64-${version}.tgz`;

/** Resolve --ref to an exact npm version via the npm registry. */
async function resolveVersion(ref: string): Promise<string> {
	if (/^\d+\.\d+\.\d+(-\S*)?$/.test(ref)) return ref;
	const spec = `${leafPackage}@${ref}`;
	const proc = await $`npm view ${spec} version`.quiet().nothrow();
	if (proc.exitCode !== 0) {
		throw new Error(`Could not resolve ${spec}: ${proc.stderr.toString().trim() || "npm view failed"}`);
	}
	const version = proc.stdout.toString().trim();
	if (!version) throw new Error(`npm view ${spec} returned no version`);
	return version;
}

interface LeafDist {
	integrity: string | null;
	tarball: string | null;
}

/**
 * The registry's `dist` metadata (sha512 integrity + tarball URL) for an exact
 * leaf version. `npm view <pkg>@<version> dist --json` wraps the projected
 * dist object in a one-element array; accept the wrapped and unwrapped shapes.
 */
async function registryDist(version: string): Promise<LeafDist> {
	const spec = `${leafPackage}@${version}`;
	const proc = await $`npm view ${spec} dist --json`.quiet().nothrow();
	if (proc.exitCode !== 0) {
		throw new Error(
			`Could not read registry metadata for ${spec}: ${proc.stderr.toString().trim() || "npm view failed"}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(proc.stdout.toString());
	} catch {
		throw new Error(`npm view ${spec} --json returned unparseable output`);
	}
	const record = (Array.isArray(parsed) ? parsed[0] : parsed) as unknown;
	if (typeof record !== "object" || record === null) throw new Error(`Unexpected npm view output for ${spec}`);
	const props = record as Record<string, unknown>;
	const dist = ("dist" in props ? props.dist : record) as unknown;
	if (typeof dist !== "object" || dist === null) throw new Error(`No dist metadata for ${spec}`);
	const distProps = dist as Record<string, unknown>;
	return {
		integrity: typeof distProps.integrity === "string" ? distProps.integrity : null,
		tarball: typeof distProps.tarball === "string" ? distProps.tarball : null,
	};
}

/** Verify the downloaded tarball against the registry's sha512 dist.integrity. */
async function verifyIntegrity(tarballPath: string, integrity: string | null, version: string): Promise<void> {
	if (!integrity) {
		throw new Error(
			`Registry metadata for ${leafPackage}@${version} carries no dist.integrity; refusing to install unverified addons`,
		);
	}
	const m = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
	if (!m || Buffer.from(m[1], "base64").length !== 64) {
		throw new Error(`Unparseable dist.integrity for ${leafPackage}@${version}: ${integrity}`);
	}
	const expected = Buffer.from(m[1], "base64").toString("hex");
	const hasher = new Bun.CryptoHasher("sha512");
	hasher.update(await Bun.file(tarballPath).arrayBuffer());
	if (hasher.digest("hex") !== expected) {
		throw new Error(`Integrity mismatch for ${path.basename(tarballPath)}: expected ${integrity}, got ${expected}`);
	}
}
async function downloadTarball(url: string, partPath: string, dryRun: boolean): Promise<void> {
	if (dryRun) {
		console.log(`$ curl -fsSL --retry 3 -C - ${url} -o ${path.basename(partPath)}`);
		return;
	}
	const dir = path.dirname(partPath);
	await fs.mkdir(dir, { recursive: true });
	const proc = await $`curl -fsSL --retry 3 -C - ${url} -o ${partPath}`.nothrow();
	if (proc.exitCode !== 0) {
		await fs.unlink(partPath).catch(() => {});
		throw new Error(`Download failed (curl exit ${proc.exitCode}): ${proc.stderr.toString().trim()}`);
	}
}

async function installAddonFiles(tarballPath: string, destDir: string, dryRun: boolean): Promise<void> {
	if (dryRun) {
		console.log(`$ tar -tzf ${path.basename(tarballPath)}`);
		return;
	}
	const listing = await $`tar -tzf ${tarballPath}`.quiet().nothrow();
	if (listing.exitCode !== 0) {
		throw new Error(`Tarball listing failed: ${listing.stderr.toString().trim()}`);
	}
	const entries = listing.stdout
		.toString()
		.split("\n")
		.filter(Boolean)
		.map(entry => entry.replace(/^package\//, ""));
	const missing = expectedFiles.filter(file => !entries.includes(file));
	if (missing.length > 0) {
		throw new Error(
			`Tarball is missing expected addons: ${missing.join(", ")} (entries: ${entries.join(", ") || "<none>"})`,
		);
	}
	const tarArgs = expectedFiles.map(file => `package/${file}`);
	await fs.mkdir(destDir, { recursive: true });
	const proc = await $`tar -xzf ${tarballPath} -C ${destDir} --strip-components=1 ${tarArgs}`.nothrow();
	if (proc.exitCode !== 0) {
		throw new Error(`Extraction failed: ${proc.stderr.toString().trim()}`);
	}
	for (const file of expectedFiles) {
		if (!(await Bun.file(path.join(destDir, file)).exists())) {
			throw new Error(`Expected ${file} was not extracted to ${destDir}`);
		}
	}
}

/** True when the on-disk addon bytes carry the exact sentinel for `version`. */
async function carriesSentinel(filePath: string, sentinel: string): Promise<boolean> {
	try {
		return containsVersionSentinel(Buffer.from(await Bun.file(filePath).arrayBuffer()), sentinel);
	} catch {
		// Unreadable (e.g. dlopen-locked) — treat as absent so the fetch re-runs.
		return false;
	}
}

async function main(): Promise<void> {
	const options = parseCliArgs(process.argv.slice(2));
	const version = options.ref ? await resolveVersion(options.ref) : await catalogVersion();
	const destDir = options.dest;

	const sentinel = versionSentinelFor(version);
	const manifestName = `${leafPackage}@${version}`;
	const existing: string[] = [];
	for (const file of expectedFiles) {
		const filePath = path.join(destDir, file);
		if (!(await Bun.file(filePath).exists())) continue;
		existing.push((await carriesSentinel(filePath, sentinel)) ? file : `${file} (wrong version, refetching)`);
	}
	if (existing.length === expectedFiles.length && existing.every(entry => !entry.includes("refetching"))) {
		console.log(`addons for ${manifestName} already present in ${path.relative(repoRoot, destDir)} — skipping`);
		return;
	}
	if (existing.length > 0) {
		console.error(`Stale addon set in ${path.relative(repoRoot, destDir)}: ${existing.join(", ")}`);
	}

	const url = tarballUrl(version);
	console.log(`$ fetch ${leafPackage}@${version}`);
	console.log(`$ curl -fsSL --retry 3 ${url}`);

	const tmpDir = path.join(destDir, ".fetch-tmp");
	const tarballPath = path.join(tmpDir, `pi-natives-linux-x64-${version}.tgz`);
	const partPath = `${tarballPath}.part`;

	const tarballExists = await Bun.file(tarballPath).exists();
	if (!tarballExists) {
		await downloadTarball(url, partPath, options.dryRun);
		if (!options.dryRun) await fs.rename(partPath, tarballPath);
	}
	if (!options.dryRun) {
		const dist = await registryDist(version);
		if (dist.tarball && dist.tarball !== url) {
			throw new Error(`Registry tarball URL ${dist.tarball} does not match ${url} for ${version}`);
		}
		await verifyIntegrity(tarballPath, dist.integrity, version);
	}
	await installAddonFiles(tarballPath, destDir, options.dryRun);

	if (!options.dryRun) {
		await fs.rm(tmpDir, { recursive: true, force: true });
		for (const file of expectedFiles) {
			console.log(`installed ${file} → ${path.join(destDir, file)}`);
		}
	}
}

if (import.meta.main) {
	try {
		await main();
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
