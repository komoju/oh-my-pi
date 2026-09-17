# KOMOJU fork maintenance

This repo is a fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) maintained
komoju-internally. The workflow mirrors `~/r/buzz`: our work lives on the `komoju` branch,
`main` tracks upstream untouched, and `komoju` is rebased onto `upstream/main` explicitly.

## Remotes and branches

| Remote  | URL                            | Use                          |
|---------|--------------------------------|------------------------------|
| `origin`  | `git@github.com:komoju/oh-my-pi` | our fork (push)            |
| `upstream` | `https://github.com/can1357/oh-my-pi` | upstream (fetch only) |

- `main` — tracks `upstream/main`. Never committed to directly; only ever reset to
  `upstream/main` (`git switch -C main upstream/main`). Left as the GitHub default branch so
  the org's "Protect Default Branch" ruleset keeps guarding it; **do not** change the default
  branch to `komoju` — the `~DEFAULT_BRANCH` ref pattern would drag deletion/non-ff/PR/code-scanning
  rules onto our working branch.
- `komoju` — tracks `origin/komoju`. All KOMOJU changes land here.

## Updating from upstream (manual, explicit)

Rebases are maintainer operations — never automated on the devbox.

```sh
git fetch upstream main
git switch komoju
git rebase upstream/main
# resolve conflicts, then verify BEFORE pushing:
bun install --frozen-lockfile
bun run natives:fetch        # pulls the npm leaf matching the new catalog pin
bun --cwd=packages/coding-agent run build
./packages/coding-agent/dist/omp --version && ./packages/coding-agent/dist/omp --smoke-test
git push --force-with-lease origin komoju
```

Conflict notes from the 2026-09 rebase onto 18.2.3-era main:

- `docs/collab.md` / `docs/rpc.md` — additive conflicts; keep both sides (upstream reworked
  the surrounding sections, our collab-RPC subsections append).
- `package.json` — upstream reformatted to 2-space JSON; merge via `git show :2:`/`:3:`
  stages and `json.dumps(indent=2)`, keeping our `collab:worker:*` and `natives:fetch*`
  scripts plus the `packages/collab-relay` workspace entry.
- `biome.json` — upstream removed it (migrated to oxlint/oxfmt); drop our ignore entries
  with it and re-add equivalents in the oxlint config if needed.
- `packages/natives/native/version-sentinel.js` — upstream landed the same module; take
  upstream's copy verbatim.

### Known upstream breakage (as of 2026-09-17)

Upstream `16013e3ec1` ("precompiled bytecode support for compiled binaries", 2026-09-15)
breaks local `bun --cwd=packages/coding-agent run build` under bun 1.4.0: the produced
binary dies at startup with `SyntaxError: import.meta is only valid inside modules.`
Stock upstream at that commit fails identically, so this is not a fork artifact. Until it
is fixed upstream (or requires a newer bun), pin rebases to the last good upstream commit
(`0d2cfacefd`, v18.1.22) and re-pin forward once fixed. Released binaries
(e.g. `omp-linux-x64` from v18.2.3) are unaffected.

## Native addons

The linux-x64 `.node` addons are **not** in GitHub releases — they are published to npm as
`@oh-my-pi/pi-natives-linux-x64`. `bun run natives:fetch` downloads the version pinned by
the workspace catalog, verifies the tarball against the registry's `dist.integrity` (sha512),
and refuses addons whose `__piNativesV…` sentinel does not exactly match the package version.
`scripts/devbox-update.ts` and the binary build both go through it, so a checkout that cannot
bazel-build still embeds correct addons.

## Devbox deployment

The devbox (`ssh devbox@komoju-devbox`) keeps `~/oh-my-pi` with a single remote `origin` →
`https://github.com/komoju/oh-my-pi.git`, branch `komoju`. An hourly systemd user timer
(`omp-update.timer`, at :15) runs `scripts/devbox-update.ts`, which:

1. fetches `origin/komoju` and resolves the exact commit (rewritten history is fine),
2. builds in a scratch worktree (`~/.cache/omp-update`) — the live checkout is never built in,
3. `bun install --frozen-lockfile` + `natives:fetch` + coding-agent build,
4. smoke-tests the candidate binary (`--version`, `--smoke-test`),
5. deploys the collab relay worker (`collab:worker:deploy`) and health-checks
   `https://omp.snd.one/`,
6. atomically promotes the binary to `~/oh-my-pi/packages/coding-agent/dist/omp`
   (`.previous` kept for manual rollback), and records the deployed SHA in
   `~/.local/state/omp-update/deployed`.

A failure at any step aborts before promotion — the previous binary and relay stay live and
the next run retries. Monarch's `devbot run --omp` picks up the promoted binary on the next
container start; running containers are untouched. Logs: `~/.local/state/omp-update/update.log`
(`journalctl --user -u omp-update.service`).

To deploy immediately: `systemctl --user start omp-update.service` (on the devbox).
To pin/skip: the deployed SHA file makes redeploys idempotent; `--force` (edit the unit or run
the script directly) overrides.
