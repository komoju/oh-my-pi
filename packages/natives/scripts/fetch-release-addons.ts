#!/usr/bin/env bun
/**
 * Fetch the released linux-x64 pi_natives addons from the upstream
 * @oh-my-pi/pi-natives-linux-x64 npm leaf package into packages/natives/native.
 *
 * The GitHub release does not ship .node files (only omp binaries, the browser
 * relay zip, LICENSE/THIRD-PARTY-NOTICES.txt, SHA256SUMS.txt); the linux-x64
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
 * curl -C -; the fetched files only land as their final names once a tar
 * listing has verified the tarball contains exactly the two expected addons.
 * On-disk files are only considered up to date when they carry the requested
 * release's `__piNativesV…` version sentinel — stale addons from an older
 * checkout are refetched rather than silently skipped, so a release build
 * never embeds addons that mismatch the loader.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

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

function tarballUrl(version: string): string {
	return `https://registry.npmjs.org/${leafPackage}/-/${leafPackage.slice(leafPackage.lastIndexOf("/") + 1)}-${version}.tgz`;
}

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

/** The `__piNativesV{major}_{minor}_{patch}` sentinel exported by a given release's addons. */
function versionSentinel(version: string): string {
	return `__piNativesV${version.replace(/[^A-Za-z0-9]/g, "_")}`;
}

async function main(): Promise<void> {
	const options = parseCliArgs(process.argv.slice(2));
	const version = options.ref ? await resolveVersion(options.ref) : await catalogVersion();
	const destDir = options.dest;

	const sentinel = versionSentinel(version);
	const manifestName = `${leafPackage}@${version}`;
	const existing: string[] = [];
	for (const file of expectedFiles) {
		const filePath = path.join(destDir, file);
		if (!(await Bun.file(filePath).exists())) continue;
		let carriesSentinel = false;
		try {
			carriesSentinel = (await Bun.file(filePath).text()).includes(sentinel);
		} catch {
			// Unreadable (e.g. dlopen-locked) — treat as absent so the fetch re-runs.
		}
		existing.push(carriesSentinel ? file : `${file} (wrong version, refetching)`);
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
