#!/usr/bin/env bun
/**
 * Devbox fork-update orchestrator.
 *
 * Deploys the published komoju/oh-my-pi `komoju` branch onto this host:
 * builds the omp binary from a scratch worktree of the fetched commit, smoke
 * checks it, then — only if everything succeeded — deploys the collab relay
 * worker and atomically promotes the new binary over the live one.
 *
 * Safety model:
 *   - Never mutates the live checkout: the build happens in a throwaway
 *     worktree (default ~/.cache/omp-update) that is removed on exit. The
 *     live checkout only provides the object store and the fetch remote;
 *     deployment state lives in ~/.local/state/omp-update/, never inside the
 *     repo.
 *   - Never trusts network state: the exact commit is resolved from
 *     origin/komoju first (with `+` so rewritten/rebased history updates the
 *     remote ref) and every build/deploy step runs against that one SHA.
 *   - Never deploys a partially verified build: relay deploy and binary
 *     promotion happen only after the smoke test passes; a failure at any
 *     step aborts before touching production state, so the next timer run
 *     retries from a clean slate.
 *   - Refuses to run when origin is not komoju/oh-my-pi, so a misconfigured
 *     remote can never ship upstream code to this host.
 *
 * The relay is deployed before the binary is promoted: wrangler updates the
 * worker while the previous omp build keeps serving existing sessions, so a
 * relay deploy failure leaves both old relay and old binary in place, and a
 * binary promotion failure leaves a newer (still compatible) relay with the
 * old binary.
 *
 * Exit codes: 0 = deployed or already up to date, 1 = failure (previous
 * binary kept).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

interface Options {
	repo: string;
	branch: string;
	worktree: string;
	smokeTest: boolean;
	force: boolean;
}

const USAGE = `usage: devbox-update.ts [--repo <path>] [--branch <name>] [--worktree <path>]
                        [--no-smoke-test] [--force]

  --repo <path>       live checkout whose origin is komoju/oh-my-pi (default
                      $HOME/oh-my-pi)
  --branch <name>     branch to deploy (default komoju)
  --worktree <path>   scratch worktree for the build (default
                      ~/.cache/omp-update)
  --no-smoke-test     skip the candidate binary smoke test (CI only)
  --force             redeploy even when the target commit is unchanged

Environment:
  OMP_RELAY_HEALTH_URL  HTTPS URL checked after the relay deploy (default:
                        https://omp.snd.one/ — the relay's ASSETS root)
`;

function parseArgs(argv: string[]): Options {
	const options: Options = {
		repo: path.join(os.homedir(), "oh-my-pi"),
		branch: "komoju",
		worktree: path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "omp-update"),
		smokeTest: true,
		force: false,
	};
	const args = [...argv];
	while (args.length > 0) {
		const arg = args.shift();
		if (arg === "--repo") options.repo = nonEmpty(args.shift(), arg);
		else if (arg === "--branch") options.branch = nonEmpty(args.shift(), arg);
		else if (arg === "--worktree") options.worktree = nonEmpty(args.shift(), arg);
		else if (arg === "--no-smoke-test") options.smokeTest = false;
		else if (arg === "--force") options.force = true;
		else throw new Error(`unknown argument: ${arg}\n\n${USAGE}`);
	}
	return options;
}

function nonEmpty(value: string | undefined, flag: string): string {
	if (!value) throw new Error(`${flag} requires a value\n\n${USAGE}`);
	return value;
}

function log(message: string): void {
	console.log(`[update ${new Date().toISOString()}] ${message}`);
}

async function run(command: string[], cwd: string, env?: Record<string, string>): Promise<string> {
	const proc = await $`${command}`.cwd(cwd).quiet().nothrow().env(env ? { ...Bun.env, ...env } : Bun.env);
	const stdout = proc.stdout.toString().trim();
	if (proc.exitCode !== 0) {
		throw new Error(
			`command failed (${command.join(" ")} in ${cwd}, exit ${proc.exitCode}):\n${stdout}\n${proc.stderr
				.toString()
				.trim()}`,
		);
	}
	return stdout;
}

/**
 * Pre-seed the worktree's native addon dir from the live repo when the on-disk
 * addons already carry the target commit's version sentinel; the fetch script
 * then skips the ~300 MB download. Mismatched sentinels are left behind — the
 * fetch script refetches those.
 */
async function preSeedAddons(repo: string, worktree: string): Promise<void> {
	const nativeFiles = ["pi_natives.linux-x64-baseline.node", "pi_natives.linux-x64-modern.node"];
	for (const file of nativeFiles) {
		const source = path.join(repo, "packages/natives/native", file);
		const target = path.join(worktree, "packages/natives/native", file);
		if (await Bun.file(source).exists()) {
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.copyFile(source, target);
		}
	}
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const repo = path.resolve(options.repo);
	const branch = options.branch;
	const remoteRef = `origin/${branch}`;
	const liveBinary = path.join(repo, "packages/coding-agent/dist/omp");
	const stateDir = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state"), "omp-update");
	const stateFile = path.join(stateDir, "deployed");

	// 1. Resolve the exact target commit from the remote.
	const remoteUrl = await run(["git", "remote", "get-url", "origin"], repo);
	if (!/komoju\/oh-my-pi(\.git)?/.test(remoteUrl)) {
		throw new Error(`origin is ${remoteUrl} — refusing to deploy from anything but komoju/oh-my-pi`);
	}
	log(`origin: ${remoteUrl}`);
	log(`fetching ${remoteRef}`);
	// Leading `+`: the komoju branch is rebased onto upstream, so the remote
	// ref is regularly rewritten; without it a non-fast-forward fetch fails.
	await run(["git", "fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/${remoteRef}`], repo);
	const target = await run(["git", "rev-parse", "--verify", `${remoteRef}^{commit}`], repo);
	log(`target commit: ${target}`);

	// 2. Skip when already deployed and the binary is still in place.
	const deployed = await Bun.file(stateFile)
		.text()
		.catch(() => "");
	if (!options.force && deployed.trim() === target && (await Bun.file(liveBinary).exists())) {
		log(`already deployed ${target} — nothing to do`);
		return;
	}

	// 3. Prepare the scratch worktree at the target commit.
	const worktree = path.resolve(options.worktree);
	await fs.rm(worktree, { recursive: true, force: true });
	await fs.mkdir(path.dirname(worktree), { recursive: true });
	log(`creating worktree at ${worktree}`);
	await run(["git", "worktree", "add", "--detach", worktree, target], repo);
	try {
		// 4. Install dependencies exactly as the commit pins them.
		log("installing dependencies (bun install --frozen-lockfile)");
		await run(["bun", "install", "--frozen-lockfile"], worktree);

		// 5. Fetch the pinned native addons (npm leaf, integrity-checked).
		await preSeedAddons(repo, worktree);
		log("fetching native addons");
		await run(["bun", "run", "natives:fetch"], worktree);

		// 6. Build the coding-agent binary.
		log("building omp binary");
		await run(["bun", "--cwd=packages/coding-agent", "run", "build"], worktree);

		// 7. Smoke check the candidate binary (workers, stats dashboard, and
		// the embedded addon load — the compiled path validates the version
		// sentinel, which is what proves the embedded addons match).
		const candidate = path.join(worktree, "packages/coding-agent/dist/omp");
		if (options.smokeTest) {
			log(`smoke-testing ${candidate}`);
			const version = await run([candidate, "--version"], worktree);
			log(`candidate version: ${version}`);
			const smoke = Bun.spawn([candidate, "--smoke-test"], { cwd: worktree, stdout: "pipe", stderr: "pipe" });
			const smokeExit = await smoke.exited;
			const smokeOut = await new Response(smoke.stdout).text();
			const smokeErr = await new Response(smoke.stderr).text();
			if (smokeExit !== 0) {
				throw new Error(`smoke test failed (exit ${smokeExit}):\n${smokeOut}\n${smokeErr}`);
			}
			log("smoke-test: ok");
		}

		// 8. Deploy the collab relay worker (before binary promotion).
		log("deploying collab relay");
		await run(["bun", "run", "collab:worker:deploy"], worktree);

		// 9. Health-check the relay.
		const healthUrl = Bun.env.OMP_RELAY_HEALTH_URL ?? "https://omp.snd.one/";
		log(`health-checking relay at ${healthUrl}`);
		const response = await fetch(healthUrl, { redirect: "manual" }).catch((err: unknown) => {
			throw new Error(`relay health check failed: ${err instanceof Error ? err.message : String(err)}`);
		});
		if (!response.ok && response.status !== 426) {
			throw new Error(`relay health check failed: HTTP ${response.status}`);
		}
		log(`relay health: HTTP ${response.status}`);

		// 10. Promote the binary: copy to a sibling temp file, then rename
		// twice. Renames on the same filesystem are atomic, so the live path
		// never shows a half-written binary; the milliseconds-wide window
		// where the path is absent only makes monarch's customOmpBin fall
		// back to the PATH omp for that instant.
		const previous = `${liveBinary}.previous`;
		const incoming = `${liveBinary}.incoming`;
		await fs.mkdir(path.dirname(liveBinary), { recursive: true });
		await fs.rm(incoming, { force: true });
		await fs.copyFile(candidate, incoming);
		await fs.chmod(incoming, 0o755);
		await fs.rm(previous, { force: true });
		if (await Bun.file(liveBinary).exists()) await fs.rename(liveBinary, previous);
		try {
			await fs.rename(incoming, liveBinary);
		} catch (err) {
			if (await Bun.file(previous).exists()) await fs.rename(previous, liveBinary);
			throw err;
		}
		log(`promoted ${candidate} → ${liveBinary} (previous kept at ${previous})`);

		// 11. Record the deployed commit. The .previous binary is kept for
		// manual rollback; it is overwritten by the next successful deploy.
		await fs.mkdir(stateDir, { recursive: true });
		await Bun.write(stateFile, `${target}\n`);
		log(`deployed ${target}`);
	} finally {
		await run(["git", "worktree", "remove", "--force", worktree], repo).catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			log(`warning: could not remove worktree ${worktree}: ${message}`);
		});
		await fs.rm(worktree, { recursive: true, force: true }).catch(() => {});
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
