#!/usr/bin/env bun
/**
 * Deploy the collab relay worker: build collab-web, then run wrangler deploy.
 *
 * Wrangler must run under a real Node.js runtime. bun 1.4's nested `bun run`
 * script chains inject a `node -> bun` shim into PATH (the `--bun` behavior
 * applied implicitly at nesting depth), which makes wrangler exit silently
 * after its banner. Resolving node via PATH here skips bun's injected
 * `node -> bun` shim and returns the real node, so wrangler is spawned with
 * that executable explicitly.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const packageDir = path.join(import.meta.dir, "..");
const wranglerBin = path.join(packageDir, "../../node_modules/wrangler/bin/wrangler.js");

/**
 * Find a real Node.js executable on PATH, skipping bun's `node -> bun` shim
 * (bun 1.4 injects a temp dir with a `node` symlink to bun into PATH for
 * nested `bun run` script chains). Wrangler silently bails when its runtime is
 * bun, so it must run under an actual node binary.
 */
function resolveRealNode(): string | null {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const candidate = path.join(dir, "node");
		let realPath: string;
		try {
			realPath = fs.realpathSync(candidate);
		} catch {
			continue;
		}
		const name = path.basename(realPath);
		if (name === "node" && realPath !== process.execPath && !realPath.includes("bun")) {
			// A real node binary (never a bun runtime or shim).
			try {
				const probe = Bun.spawnSync([realPath, "--version"]);
				if (probe.exitCode === 0 && /^v\d+\./.test(probe.stdout.toString())) return realPath;
			} catch {
				// Fall through to the next candidate.
			}
		}
	}
	return null;
}

async function main(): Promise<void> {
	const build = Bun.spawn(["bun", `--cwd=${path.join(packageDir, "../collab-web")}`, "run", "build"], {
		stdio: ["inherit", "inherit", "inherit"],
	});
	const buildExit = await build.exited;
	if (buildExit !== 0) process.exit(buildExit ?? 1);

	const nodeBin = resolveRealNode();
	if (!nodeBin) throw new Error("Could not resolve a real `node` on PATH to run wrangler");
	console.log(`wrangler via ${nodeBin}`);

	const proc = Bun.spawn([nodeBin, wranglerBin, "deploy"], {
		cwd: packageDir,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) process.exit(exitCode ?? 1);
}

if (import.meta.main) {
	try {
		await main();
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
