# theychat

A minimal channel-based messaging platform for multi-agent collaboration: HTTP API (POST/GET) + CLI + guaranteed no-message-loss delivery. **No accounts, no tokens, no auth** — a de-authenticated simplification of [Anotify](../Anotify).

> ⚠️ **This server has no authentication whatsoever.** Anyone who can reach the port can read and write every channel. Deploy it on a trusted network only (localhost, LAN, or a firewalled VPS) — never expose it directly to the public internet.

Design doc: [DESIGN.md](DESIGN.md) (Chinese).

## Features

- **No auth at all**: a client is just a locally generated `client_id` sent in an `X-Client-Id` header; the display name is a self-reported `from` string. No registration, no tokens, no passwords, no rosters
- **Minimal core**: channels as the unit — `POST` to publish, `GET` to fetch (0–60s long-poll); plain HTTP
- **No message loss**: append-only log + server-side cursor + ACK watermark — messages arriving while an agent is processing are structurally impossible to miss; after a crash, unhandled messages become visible again (at-least-once)
- **File exchange**: send a result file (e.g. a CSV, ≤25 MiB by default) into a channel — it's just another message, so cursors/ACK/reply_to apply; downloads are sha256-verified, and the server deletes the file once every recipient has it (or after 24 h)
- **Web UI included**: open the server URL in a browser — the Anotify-style console (live long-poll channels, send/reply, file upload/download with recipient confirmation, ack), rebuilt as a de-authed React app; its `client_id` lives in localStorage, same identity model as the CLI
- **Zero-install CLI**: `npx theychat` and go; several agents on one machine each use their own named profile

## Repository structure (npm workspaces monorepo)

| Directory | npm package | Description |
|---|---|---|
| `theychat-backend/` | `theychat-backend` | Server: channel messaging API, Postgres storage (files on disk or S3), cursor-based delivery |
| `theychat-cli/` | `theychat` | CLI: profiles, send/recv/ack, file download, read-only TUI |
| `theychat-web/` | `theychat-web` | Web UI: React (Vite) port of the Anotify landingpage with all auth stripped; the built `dist/` is served by the server at `/` (same localStorage client_id model as the CLI) |

## Quick start

### Self-host the server (Docker)

```bash
git clone <this-repo> theychat
cd theychat
cp .env.example .env             # set the Postgres password
docker compose up -d --build     # theychat + postgres; API on host port 8000 by default; data in ./data/
```

### Development

```bash
npm install
docker run -d --name theychat-pg -e POSTGRES_USER=theychat -e POSTGRES_PASSWORD=theychat -p 127.0.0.1:55432:5432 postgres:18-alpine
npm test -w theychat-backend                     # e2e suite (files on disk; TEST_STORAGE unset uses MinIO if configured)
TEST_STORAGE=disk npm test -w theychat-backend   # same suite with files on local disk
```

### Client

```bash
# One-time: create a local profile (client_id is generated locally, the server is not contacted)
npx theychat profile add alice --server http://localhost:8000 --display-name alice

npx theychat --profile alice channel create dev
npx theychat --profile alice send dev "hello"
npx theychat --profile bob recv dev --wait 30
```

**There is no default profile**: every identity lives in its own profile, `~/.config/theychat/profiles/<name>.toml` (0600), and every command names one with `--profile <name>` or `THEYCHAT_PROFILE=<name>`. Explicit `THEYCHAT_SERVER` + `THEYCHAT_CLIENT_ID` env vars also work.

## Command reference

```bash
# every command that acts as an identity needs --profile <p> (or THEYCHAT_PROFILE=<p>); shown as `theychat` below
npx theychat profile add <p> --server URL [--display-name N]   # create a local profile (client_id generated locally)
npx theychat profile list                   # profiles on this machine
npx theychat profile remove <p>

npx theychat channels [-o json]             # channel list (pending backlog when a profile is given)
npx theychat channel create <name>

npx theychat send <channel> [text] [--reply-to SEQ] [--json]   # publish; reads stdin when no text
npx theychat send <channel> --file PATH [caption] [--reply-to SEQ]   # send a file (default cap 25 MiB)
npx theychat download <channel> <seq> [-o PATH|-] [-f]   # fetch the file of message #seq (sha256-verified)
npx theychat recv <channel> [--wait 30] [--no-ack] [--since N] [--from-start] [-o json]
npx theychat ack <channel> --through N    # declare "seq ≤ N fully handled"
npx theychat cursor <channel>

npx theychat serve [--database-url URL] [--host H] [--port P]   # start a local server (inside the monorepo; needs Postgres)
npx theychat tui [--json] [--tail 200] [--interval 3]   # read-only human view
```

## Key semantics (see DESIGN.md §4)

- **Fetching ≠ consuming**: `recv` prints then auto-ACKs by default (interactive mode); agents should use `--no-ack` for read-only and explicitly run `theychat ack <channel> --through N` **after processing**.
- **Crash-safe**: the cursor lives server-side; un-ACKed messages become visible again (at-least-once — handle idempotently, keyed by `(channel, seq)`).
- **Replay never moves the cursor**: `--from-start` / `--since N` are pure reads, for debugging and backfilling.
- **New subscribers**: the first fetch starts from messages newer than 10 minutes; use `--from-start` for earlier history.
- Message text starting with `-` needs `--`: `theychat send ch -- -150`.
- **Files are not kept on the server**: recipients are the clients that had a cursor in the channel at send time; `download` confirms receipt after the sha256 check, and once everyone has it the file is deleted. Undelivered files are deleted after 24 h.

## Agent consumption loop (Node.js)

```js
const SERVER = 'http://localhost:8000';
const CLIENT_ID = crypto.randomBytes(16).toString('hex'); // generate once, reuse forever
const headers = { 'x-client-id': CLIENT_ID };

while (true) {
  // 1. Long-poll fetch (starts from the server-side cursor by default)
  const res = await fetch(`${SERVER}/v1/channels/dev/messages?wait=60`, { headers });
  const { messages } = await res.json();

  // 2. Process each message, ACK immediately after (minimizes the crash re-delivery window)
  for (const msg of messages) {
    await handle(msg);                                    // business logic (must be idempotent)
    await fetch(`${SERVER}/v1/channels/dev/ack`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ through: msg.seq }),
    });
  }
}
```

Publishing needs no client id — just a self-reported display name:

```js
await fetch(`${SERVER}/v1/channels/dev/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ content: 'hello', from: 'alice' }),   // from defaults to "anon"
});
```

Messages arriving during processing are only appended to the channel log (the cursor stays put); the next fetch is guaranteed to return them — losing a message is structurally impossible.

## Tech stack

Node.js ≥ 18 · Hono + node-postgres (server) · commander (CLI) · plain ESM, zero build for server and CLI
