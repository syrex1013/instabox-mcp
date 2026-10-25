# instabox-mcp

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](https://modelcontextprotocol.io)

A [Model Context Protocol](https://modelcontextprotocol.io) server for [InstaBox](https://instabox.sh): disposable cloud Linux machines for AI agents. It wraps the InstaBox REST API (`https://api.instabox.sh`) in 30 tools, so any MCP client (Claude, Codex, Antigravity, oh-my-pi, Cursor, ...) can create a machine, run commands and edit files in it, snapshot it, expose a port and delete it again.

> **Unofficial.** This project is not affiliated with or endorsed by InstaBox.

## Features

- **Full machine lifecycle**: create, start, stop, pause (suspend), resume, rename, delete.
- **Run code**: `exec` with a shell string or argv, working directory, env vars, stdin and timeout.
- **Files**: read files, list directories, write files (binary-safe).
- **Snapshots**: save a machine, create new machines from it, browse snapshot files.
- **Networking**: publish ports as public HTTPS URLs, create short-lived SSH tokens.
- **Observability**: CPU/memory metrics, per-machine usage, account limits.
- **Org Secrets**: inspect and select which Secrets a machine may use (values are never exposed).
- **Safe by default**: asynchronous operations are awaited for you, every lifecycle call is idempotent, deletes need explicit confirmation, and a read-only mode removes every mutating tool.

## Requirements

- Node.js 18 or newer
- An InstaBox API key (dashboard, **API keys**). A key with `machines:read|write|delete` and `images:read|write|delete` covers every tool.

## Install

```bash
git clone https://github.com/syrex1013/instabox-mcp.git
cd instabox-mcp
npm install --include=dev
npm run build
```

`--include=dev` matters if your shell sets `NODE_ENV=production`, because the TypeScript compiler is a dev dependency.

Check that your key works (read-only, creates nothing):

```bash
INSTABOX_API_KEY=ibk_... npm run live-test
```

## Configure your MCP client

Replace `/absolute/path/to/instabox-mcp` with the clone location and `ibk_...` with your key.

### Claude Code

```bash
claude mcp add instabox --scope user --env INSTABOX_API_KEY=ibk_... -- node /absolute/path/to/instabox-mcp/dist/index.js
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "instabox": {
      "command": "node",
      "args": ["/absolute/path/to/instabox-mcp/dist/index.js"],
      "env": { "INSTABOX_API_KEY": "ibk_..." }
    }
  }
}
```

### Codex

Add to `~/.codex/config.toml` (or run `codex mcp add instabox --env INSTABOX_API_KEY=ibk_... -- node /absolute/path/to/instabox-mcp/dist/index.js`):

```toml
[mcp_servers.instabox]
command = "node"
args = ["/absolute/path/to/instabox-mcp/dist/index.js"]
startup_timeout_sec = 30

[mcp_servers.instabox.env]
INSTABOX_API_KEY = "ibk_..."
```

### Antigravity (`agy`)

Add to `~/.gemini/antigravity/mcp_config.json`:

```json
{
  "mcpServers": {
    "instabox": {
      "command": "node",
      "args": ["/absolute/path/to/instabox-mcp/dist/index.js"],
      "env": { "INSTABOX_API_KEY": "ibk_..." }
    }
  }
}
```

### oh-my-pi (`omp`)

Add to `~/.omp/agent/mcp.json`:

```json
{
  "mcpServers": {
    "instabox": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/instabox-mcp/dist/index.js"],
      "env": { "INSTABOX_API_KEY": "ibk_..." }
    }
  }
}
```

Config files are plain text. Keep them out of version control and use a restricted key where you can.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `INSTABOX_API_KEY` | required | `ibk_...` key, sent as `X-API-Key` |
| `INSTABOX_API_URL` | `https://api.instabox.sh` | API base URL |
| `INSTABOX_READ_ONLY` | off | `true` registers only the read-only tools |
| `INSTABOX_MAX_OUTPUT_CHARS` | `60000` | Cap on text returned per tool call |

## Tools

| Area | Tools |
|---|---|
| Account | `instabox_whoami`, `instabox_list_templates`, `instabox_get_usage` |
| Machines | `instabox_list_machines`, `instabox_get_machine`, `instabox_create_machine`, `instabox_update_machine`, `instabox_machine_power` (start / stop / suspend / resume), `instabox_delete_machine`, `instabox_get_operation`, `instabox_get_machine_metrics`, `instabox_get_machine_usage` |
| Commands and files | `instabox_exec`, `instabox_list_files`, `instabox_write_file` |
| Snapshots | `instabox_list_snapshots`, `instabox_get_snapshot`, `instabox_list_snapshot_files`, `instabox_create_snapshot`, `instabox_delete_snapshot` |
| Public ports | `instabox_list_ports`, `instabox_publish_port`, `instabox_unpublish_port` |
| SSH | `instabox_create_ssh_token`, `instabox_list_ssh_tokens`, `instabox_revoke_ssh_tokens` |
| Org Secrets | `instabox_list_org_secrets`, `instabox_get_machine_secrets`, `instabox_update_machine_secrets`, `instabox_refresh_machine_secrets` |

Example prompts: *"Create a machine, clone this repo into it and run the tests"*, *"Snapshot my dev machine, then start a fresh one from the snapshot"*, *"Publish port 3000 on dev and give me the URL"*.

## How it behaves

- **Operations.** Create, start, stop, suspend, resume and delete are asynchronous in the API. The tools long-poll `GET /v1/operations/{id}` until the operation finishes; pass `wait: false` to get the operation back immediately.
- **Idempotency.** Calls that need an `Idempotency-Key` get a fresh UUID, reused across automatic retries of that call. `exec` and SSH-token creation take none, so they are never retried after a response was received.
- **Delete confirmation.** `instabox_delete_machine` and `instabox_delete_snapshot` require `confirm` set to the exact ID or name and forward it as `X-Confirm-Delete`; the server rejects a mismatch with `409`.
- **Tool annotations** mark read, write and destructive tools so clients can ask for approval accordingly.
- **Errors** include the API error code, hint, request ID and required scopes, and network failures include the underlying cause.

## Security

- `instabox_exec` runs arbitrary code in a machine. Published ports are reachable by anyone with the URL, SSH tokens work for anyone holding them, and selecting org Secrets lets code in the machine send them to their allowed hosts.
- For machines that run untrusted code, create them with `vault: false` and no `secrets` / `envSecrets`.
- Use a restricted key, or set `INSTABOX_READ_ONLY=true`, when the model should only observe.
- Org Secret **values** cannot be created, read or changed with an API key; this server only reads metadata and manages per-machine selections.

## Testing

`scripts/live-test.mjs` drives the built server over stdio against the real API:

```bash
INSTABOX_API_KEY=ibk_... node scripts/live-test.mjs dist/index.js <phase>
```

| Phase | What it does |
|---|---|
| `read` | Account, templates, usage, machine / snapshot / port listings. Changes nothing. |
| `lifecycle` | Creates a throwaway machine (auto-deleted after 15 min), exercises exec, files, ports, power states, then deletes it. Needs a free machine slot. |
| `existing` | Non-destructive checks (exec, files, metrics, usage, secrets, delete-guard) on `MACHINE_ID`. |
| `existing-write` | Adds reversible writes on `MACHINE_ID`: a temp file, a port publish / unpublish, an SSH token, suspend / resume. |

Status against the live API: `read`, `existing` and `existing-write` pass. `lifecycle` (create, stop / start, delete with the correct confirmation), snapshots, `instabox_update_machine` and the `since` / `from` / `to` parameters of the metrics and usage tools are implemented from the API documentation but not yet exercised live.

## Not covered

Desktop/VNC control, SSH certificates (`/connections`), Vault items, file upload URLs and org/billing management are not exposed. Everything inside a machine can still be done with `instabox_exec`.

## Development

```bash
npm run dev       # tsc --watch
npm run inspect   # open the server in the MCP Inspector
```

## License

[MIT](LICENSE)
