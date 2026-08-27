# @oh-my-pi/collab-relay

Cloudflare Worker for [omp collab sessions](../../docs/collab.md). Serves the [`collab-web`](../collab-web) guest client at `/` and routes `GET /r/<roomId>?role=host|guest` WebSocket upgrades into one Durable Object per room.

The Worker is content-blind: it forwards sealed envelopes and TEXT control frames, and never sees room keys or plaintext.

## Quick start

```sh
# local Worker + collab-web assets — http://localhost:8787
bun run dev

# tests (builds collab-web dist if missing)
bun test
```

Host a session with `/collab ws://localhost:8787` (or the deployed `wss://` origin) and open the printed browser link.

## Deploy

```sh
bun run deploy
```

Rebuilds `packages/collab-web` then deploys the Worker with that `dist/` SPA. After changing Durable Object bindings, run `bun run cf-typegen`.

This package covers the live collab WebSocket contract (`/` + `/r/<roomId>`). It does not implement `/share` blob upload or `/healthz`.
