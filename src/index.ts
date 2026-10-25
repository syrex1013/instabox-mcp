#!/usr/bin/env node
/**
 * MCP server for InstaBox (https://instabox.sh).
 *
 * InstaBox gives each agent a Linux machine ("sandbox") in the cloud. This
 * server maps the documented REST API (https://api.instabox.sh, see
 * https://instabox.sh/llms.txt) onto MCP tools.
 *
 * Config (environment):
 *   INSTABOX_API_KEY           required, an `ibk_...` key
 *   INSTABOX_API_URL           optional, default https://api.instabox.sh
 *   INSTABOX_READ_ONLY         optional, "true" hides every tool that changes state
 *   INSTABOX_MAX_OUTPUT_CHARS  optional, cap on text returned per tool call
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_URL = (process.env.INSTABOX_API_URL ?? "https://api.instabox.sh").replace(/\/+$/, "");
const API_KEY = process.env.INSTABOX_API_KEY;
const READ_ONLY = /^(1|true|yes|on)$/i.test(process.env.INSTABOX_READ_ONLY ?? "");
const MAX_OUTPUT = Math.max(1000, Number(process.env.INSTABOX_MAX_OUTPUT_CHARS ?? 60_000));
const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: {
      requestId?: string;
      retryable?: boolean;
      operationId?: string | null;
      hint?: string;
      requiredScopes?: string[];
    } = {},
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ReqOpts {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Adds a fresh Idempotency-Key (required by every lifecycle/snapshot/delete call). */
  idempotent?: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

async function api<T = any>(method: string, path: string, o: ReqOpts = {}): Promise<T> {
  if (!API_KEY) {
    throw new ApiError(
      0,
      "missing_api_key",
      "INSTABOX_API_KEY is not set. Create a key in the InstaBox dashboard (API keys) and add it to this MCP server's environment.",
    );
  }
  const url = new URL(API_URL + path);
  for (const [k, v] of Object.entries(o.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = {
    "X-API-Key": API_KEY,
    Accept: "application/json",
    "User-Agent": `instabox-mcp/${VERSION}`,
    ...o.headers,
  };
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  // Generated once so retries of the same call replay instead of acting twice.
  if (o.idempotent) headers["Idempotency-Key"] = randomUUID();
  const retriable = method === "GET" || !!o.idempotent;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
        signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
      });
    } catch (e) {
      if (retriable && attempt < 2) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      // fetch() reports only "fetch failed"; the real reason (DNS, TLS, proxy, timeout) is in `cause`.
      const err = e as { message?: string; name?: string; cause?: { code?: string; message?: string } };
      const cause = err.cause ? ` (${err.cause.code ?? err.cause.message ?? "unknown cause"})` : "";
      const msg = err.name === "TimeoutError" ? "request timed out" : `${err.message ?? String(e)}${cause}`;
      throw new ApiError(0, "network_error", `Request to ${method} ${path} failed: ${msg}`, { retryable: true });
    }
    if (retriable && [502, 503, 504].includes(res.status) && attempt < 2) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    let json: any = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const e = json?.error ?? {};
      throw new ApiError(res.status, e.code ?? `http_${res.status}`, e.message ?? (text.slice(0, 300) || res.statusText), {
        requestId: e.requestId,
        retryable: e.retryable,
        operationId: e.operationId,
        hint: e.hint,
        requiredScopes: e.requiredScopes,
      });
    }
    return (json ?? { ok: true, status: res.status }) as T;
  }
}

const mref = (id: string) => `/v1/machines/${encodeURIComponent(id)}`;

/** Long-poll an operation until it succeeds (returns it) or fails (throws). */
async function waitForOperation(opId: string, timeoutSeconds = 300): Promise<any> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new ApiError(
        0,
        "operation_timeout",
        `Operation ${opId} is still running after ${timeoutSeconds}s. Check it with instabox_get_operation.`,
        { operationId: opId, retryable: true },
      );
    }
    const waitS = Math.max(1, Math.min(25, Math.floor(remaining / 1000)));
    const op = await api("GET", `/v1/operations/${encodeURIComponent(opId)}`, {
      query: { wait: `${waitS}s` },
      timeoutMs: (waitS + 15) * 1000,
    });
    if (op.state === "succeeded") return op;
    if (op.state === "failed") {
      throw new ApiError(409, op.error?.code ?? "operation_failed", op.error?.message ?? `Operation ${opId} failed`, {
        operationId: opId,
        retryable: op.error?.retryable,
      });
    }
  }
}

/** Result of a lifecycle call: either the accepted operation or, when waiting, the finished one plus the machine. */
async function settle(op: any, wait: boolean, timeoutSeconds: number) {
  if (!wait) return { operation: op, note: "Accepted, not waited for. Poll with instabox_get_operation." };
  const done = await waitForOperation(op.id, timeoutSeconds);
  let machine = done.machine;
  if (!machine && done.type !== "delete" && done.machineId) {
    machine = await api("GET", mref(done.machineId)).catch(() => undefined);
  }
  return { operation: { id: done.id, type: done.type, state: done.state }, machine };
}

// ---------------------------------------------------------------------------
// MCP plumbing
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "instabox", version: VERSION });

function clip(s: string): string {
  return s.length <= MAX_OUTPUT ? s : s.slice(0, MAX_OUTPUT) + `\n… [truncated ${s.length - MAX_OUTPUT} characters]`;
}
const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: clip(typeof data === "string" ? data : JSON.stringify(data, null, 2)) }],
});
function fail(e: unknown) {
  if (e instanceof ApiError) {
    const parts = [`${e.code}${e.status ? ` (HTTP ${e.status})` : ""}: ${e.message}`];
    if (e.extra.hint) parts.push(`Hint: ${e.extra.hint}`);
    if (e.extra.requiredScopes?.length) parts.push(`Key needs one of these scopes: ${e.extra.requiredScopes.join(", ")}`);
    if (e.extra.operationId) parts.push(`Operation: ${e.extra.operationId}`);
    if (e.extra.retryable) parts.push("This error is retryable.");
    if (e.extra.requestId) parts.push(`Request ID: ${e.extra.requestId}`);
    return { isError: true, content: [{ type: "text" as const, text: parts.join("\n") }] };
  }
  return { isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] };
}

type Kind = "read" | "write" | "destructive";

function tool<S extends z.ZodRawShape>(
  name: string,
  cfg: { title: string; description: string; inputSchema: S; kind: Kind; openWorld?: boolean },
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>,
) {
  if (READ_ONLY && cfg.kind !== "read") return;
  server.registerTool(
    name,
    {
      title: cfg.title,
      description: cfg.description,
      inputSchema: cfg.inputSchema,
      annotations: {
        readOnlyHint: cfg.kind === "read",
        destructiveHint: cfg.kind === "destructive",
        idempotentHint: cfg.kind === "read",
        openWorldHint: cfg.openWorld ?? false,
      },
    },
    (async (args: any) => {
      try {
        return ok(await handler(args));
      } catch (e) {
        return fail(e);
      }
    }) as any,
  );
}

// Reusable schema pieces
const machineId = z.string().min(1).describe("Machine ID (m_...) or its unique name");
const snapshotId = z.string().min(1).describe("Snapshot ID (sn_..., or im_... for older ones)");
const wait = z.boolean().default(true).describe("Wait for the operation to finish before returning (default true)");
const waitTimeout = z.number().int().min(5).max(1800).default(300).describe("Max seconds to wait (default 300)");
const secretSelection = z
  .union([z.literal("all"), z.array(z.string())])
  .describe('Proxy Secret names, or "all" for every current and future proxy Secret; [] selects none');

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

tool(
  "instabox_whoami",
  {
    title: "Who am I",
    description:
      "Show which user/org the configured API key belongs to, including `allowedSpecs` (machine sizes this account may create) and lifecycle policy. Any key may call this, so it is the cheapest way to check that credentials work.",
    inputSchema: {},
    kind: "read",
  },
  () => api("GET", "/v1/me"),
);

tool(
  "instabox_list_templates",
  {
    title: "List templates",
    description:
      "List the templates a machine can start from (e.g. agent-browser, universal, herdr, orca) with their software and default size. Only templates with `creatable: true` can be used; the free plan can create from agent-browser only. Needs machines:read or images:read.",
    inputSchema: {},
    kind: "read",
  },
  () => api("GET", "/v1/templates"),
);

tool(
  "instabox_get_usage",
  {
    title: "Get account usage and limits",
    description:
      "Account-wide counts of machines and snapshots, stored data (measured about hourly) and plan limits (max machines, snapshots, storage). Check this before creating machines when you may be near a limit.",
    inputSchema: {},
    kind: "read",
  },
  () => api("GET", "/v1/usage"),
);

// ---------------------------------------------------------------------------
// Machines
// ---------------------------------------------------------------------------

tool(
  "instabox_list_machines",
  {
    title: "List machines",
    description:
      "List your machines (any state except deleted), one page at a time. Optionally filter by metadata labels. Returns `nextCursor`; pass it back as `cursor` for the next page.",
    inputSchema: {
      metadata: z
        .record(z.string())
        .optional()
        .describe('Only machines having every one of these labels, e.g. {"task": "review"}'),
      limit: z.number().int().min(1).max(200).optional().describe("Page size"),
      cursor: z.string().optional().describe("`nextCursor` from the previous page"),
    },
    kind: "read",
  },
  async ({ metadata, limit, cursor }) => {
    // The API takes `metadata=key:value`, repeated for several labels.
    const url = `/v1/machines`;
    if (!metadata || Object.keys(metadata).length === 0) {
      return api("GET", url, { query: { limit, cursor } });
    }
    // URLSearchParams in api() sets a single value per key, so build the repeated query here.
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(metadata)) q.append("metadata", `${k}:${v}`);
    if (limit) q.set("limit", String(limit));
    if (cursor) q.set("cursor", cursor);
    return api("GET", `${url}?${q.toString()}`);
  },
);

tool(
  "instabox_get_machine",
  {
    title: "Get a machine",
    description:
      "Get one machine by ID or name: state (creating, starting, running, stopping, stopped, suspending, suspended = paused, resuming, deleting, error), spec, template, auto-pause setting, labels, guest user and whether its runtime is ready.",
    inputSchema: { id: machineId },
    kind: "read",
  },
  ({ id }) => api("GET", mref(id)),
);

tool(
  "instabox_create_machine",
  {
    title: "Create a machine",
    description:
      "Create a Linux machine (Firecracker microVM, Debian, root, Docker, 20 GiB persistent /data; home is /data/home) from a template or one of your snapshots. Starts as an asynchronous operation; by default this waits until the machine is running. Give `templateId` OR `snapshotId` (neither: agent-browser). Leave size fields out for the default 4 vCPU / 8 GiB; other sizes must be ones your plan allows (see instabox_whoami `allowedSpecs`). Counts against your machine limit even when stopped or paused.",
    inputSchema: {
      name: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
        .optional()
        .describe("1-63 lowercase letters, digits or '-', starting with a letter or digit; unique. Omit for box-<random>"),
      templateId: z.string().optional().describe("Template ID, e.g. universal or agent-browser"),
      snapshotId: z.string().optional().describe("Create from this snapshot instead of a template"),
      metadata: z.record(z.string()).optional().describe("Up to 32 string labels. Stored in plain text: never put secrets here"),
      autoSuspendAfterSeconds: z
        .number()
        .int()
        .min(0)
        .max(86400)
        .optional()
        .describe("Idle seconds before auto-pause (120-86400, 0 = never). Only honoured on accounts with manual lifecycle; otherwise fixed at 1800"),
      vcpus: z.number().int().optional().describe("vCPUs of one of your allowed sizes"),
      memMiB: z.number().int().optional().describe("Memory in MiB of one of your allowed sizes"),
      guestUser: z
        .string()
        .regex(/^[a-z_][a-z0-9_-]{0,31}$/)
        .optional()
        .describe("Linux user inside the machine (default 'user'). Fixed at creation"),
      deleteAfterSeconds: z
        .number()
        .int()
        .min(60)
        .max(86400)
        .optional()
        .describe("Delete the machine automatically after this long (60-86400). Good for throwaway sandboxes"),
      desiredState: z.enum(["running", "stopped"]).optional().describe("'stopped' stops it once set up"),
      vault: z.boolean().optional().describe("false disables personal Vault delivery. Use false for machines that run untrusted code"),
      secrets: secretSelection.optional().describe("Org proxy Secrets to enrol. SECURITY: code in the machine can send these to their allowed hosts"),
      envSecrets: z
        .array(z.string())
        .optional()
        .describe("Org env Secrets (real values enter the machine and are readable by any process). Use sparingly"),
      wait,
      waitTimeoutSeconds: waitTimeout,
    },
    kind: "write",
  },
  async ({ wait, waitTimeoutSeconds, ...body }) => {
    if (body.templateId && body.snapshotId) {
      throw new ApiError(400, "bad_request", "Give templateId or snapshotId, not both.");
    }
    const op = await api("POST", "/v1/machines", { body, idempotent: true });
    return settle(op, wait, waitTimeoutSeconds);
  },
);

tool(
  "instabox_update_machine",
  {
    title: "Update a machine",
    description:
      "Change a machine's idle auto-pause time and/or labels. Applies immediately in any state. `metadata` REPLACES all labels ({} clears them). Fields you leave out are unchanged. Auto-pause is only honoured on accounts with manual lifecycle; the reply shows the effective value.",
    inputSchema: {
      id: machineId,
      autoSuspendAfterSeconds: z.number().int().min(0).max(86400).optional().describe("120-86400, or 0 to turn idle pause off"),
      metadata: z.record(z.string()).optional().describe("Replacement labels"),
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional().describe("Rename the machine"),
    },
    kind: "write",
  },
  ({ id, ...body }) => api("PATCH", mref(id), { body, idempotent: true }),
);

tool(
  "instabox_machine_power",
  {
    title: "Start, stop, pause or resume a machine",
    description:
      "Change a machine's power state. `start`: boot a stopped machine (resumes a paused one). `stop`: shut down; processes end, files kept (a paused machine cannot be stopped: resume or delete it). `suspend`: pause, keeping memory and running processes. `resume`: continue a paused machine where it left off. A machine runs one operation at a time (409 operation_conflict otherwise). Commands, files and SSH wake an idle-paused machine automatically, but a machine you paused or stopped stays off until you start/resume it.",
    inputSchema: {
      id: machineId,
      action: z.enum(["start", "stop", "suspend", "resume"]),
      stopTimeoutSeconds: z.number().int().min(0).max(600).optional().describe("stop only: seconds to wait for clean shutdown before forcing off (default 60)"),
      wait,
      waitTimeoutSeconds: waitTimeout,
    },
    kind: "write",
  },
  async ({ id, action, stopTimeoutSeconds, wait, waitTimeoutSeconds }) => {
    const body = action === "stop" && stopTimeoutSeconds !== undefined ? { timeoutSeconds: stopTimeoutSeconds } : undefined;
    const op = await api("POST", `${mref(id)}/${action}`, { body, idempotent: true });
    return settle(op, wait, waitTimeoutSeconds);
  },
);

tool(
  "instabox_delete_machine",
  {
    title: "Delete a machine",
    description:
      "PERMANENTLY delete a machine and its disks (snapshots saved from it are kept). Cannot be undone. To guard against deleting the wrong machine, `confirm` must be the machine's exact ID or name; the server rejects anything else with 409 delete_confirmation_required. Needs the machines:delete scope.",
    inputSchema: {
      id: machineId,
      confirm: z.string().min(1).describe("The machine's exact ID or name, repeated to confirm"),
      wait,
      waitTimeoutSeconds: waitTimeout,
    },
    kind: "destructive",
  },
  async ({ id, confirm, wait, waitTimeoutSeconds }) => {
    const op = await api("DELETE", mref(id), {
      headers: { "X-Confirm-Delete": confirm },
      idempotent: true,
    });
    return settle(op, wait, waitTimeoutSeconds);
  },
);

tool(
  "instabox_get_operation",
  {
    title: "Get an operation",
    description:
      "Get the status of an operation (create, start, stop, suspend, resume, delete) returned by a lifecycle call: state queued, running, succeeded or failed, plus phase and error. With `waitSeconds` it long-polls until the operation changes or finishes.",
    inputSchema: {
      id: z.string().describe("Operation ID (op_...)"),
      waitSeconds: z.number().int().min(0).max(30).default(0).describe("Long-poll up to this many seconds (max 30)"),
    },
    kind: "read",
  },
  ({ id, waitSeconds }) =>
    api("GET", `/v1/operations/${encodeURIComponent(id)}`, {
      query: waitSeconds ? { wait: `${waitSeconds}s` } : undefined,
      timeoutMs: (waitSeconds + 15) * 1000,
    }),
);

tool(
  "instabox_get_machine_metrics",
  {
    title: "Get machine metrics",
    description:
      "CPU and memory samples (one per 30 s, oldest first) measured on the host for a machine. Empty while the machine is not running; a new machine's first sample appears after ~90 s. Default window is the last 5 minutes, at most 24 h back.",
    inputSchema: {
      id: machineId,
      since: z.string().optional().describe("RFC 3339 start of window, e.g. 2026-10-25T10:00:00Z"),
    },
    kind: "read",
  },
  ({ id, since }) => api("GET", `${mref(id)}/metrics`, { query: { since } }),
);

tool(
  "instabox_get_machine_usage",
  {
    title: "Get machine usage",
    description:
      "Resource usage of one machine over a window (running seconds, vCPU-seconds, GiB-seconds of memory and disk), for billing or cost checks. Defaults to the current UTC month; the window may span at most 366 days. Works for deleted machines too (by ID).",
    inputSchema: {
      id: machineId,
      from: z.string().optional().describe("RFC 3339 window start (default: start of this UTC month)"),
      to: z.string().optional().describe("RFC 3339 window end (default: now)"),
    },
    kind: "read",
  },
  ({ id, from, to }) => api("GET", `${mref(id)}/usage`, { query: { from, to } }),
);

// ---------------------------------------------------------------------------
// Commands and files
// ---------------------------------------------------------------------------

tool(
  "instabox_exec",
  {
    title: "Run a command in a machine",
    description:
      "Run a command inside a RUNNING machine and return stdout, stderr and the exit code once it exits (a non-zero exit is still a normal result). Output is collected, not streamed, and each stream is cut at 1 MiB. Give `cmd` (a shell string, run with `bash -lc`) OR `argv` (program + arguments, no shell, no expansion). Runs as the machine's user in /data/home by default. Max 600 s per call: for long jobs start them in the background (e.g. `nohup … > /data/home/job.log 2>&1 &`) and poll the log. Not idempotent: a retry runs the command again. A machine paused for idleness is woken first; a machine you stopped returns 409 machine_not_running. This executes arbitrary code with root-capable access in the machine.",
    inputSchema: {
      id: machineId,
      cmd: z.string().max(65536).optional().describe("Shell command (bash -lc). Set this or argv"),
      argv: z.array(z.string()).min(1).optional().describe("Program and arguments, run without a shell. Set this or cmd"),
      cwd: z.string().optional().describe("Working directory (default /data/home)"),
      envs: z.record(z.string()).optional().describe("Environment variables to set. Names match [A-Za-z_][A-Za-z0-9_]*"),
      stdin: z.string().max(1_048_576).optional().describe("Text fed to the command, then EOF (max 1 MiB)"),
      timeoutSeconds: z.number().int().min(1).max(600).default(60).describe("Kill after this long (exit code 124). Default 60, max 600"),
    },
    kind: "destructive",
    openWorld: true,
  },
  async ({ id, cmd, argv, cwd, envs, stdin, timeoutSeconds }) => {
    if ((cmd ? 1 : 0) + (argv ? 1 : 0) !== 1) {
      throw new ApiError(400, "bad_request", "Provide exactly one of `cmd` and `argv`.");
    }
    return api("POST", `${mref(id)}/exec`, {
      body: { cmd, argv, cwd, envs, stdin, timeoutSeconds },
      timeoutMs: (timeoutSeconds + 30) * 1000,
    });
  },
);

tool(
  "instabox_list_files",
  {
    title: "Read a file or list a directory in a machine",
    description:
      "List a directory (up to 5000 entries, directories first) or read a text file (up to 256 KiB) from a machine, live and as root. Binary files come back with `binary: true` and no content. Use instabox_exec for larger files. The machine must be running (an idle-paused one is woken).",
    inputSchema: {
      id: machineId,
      path: z.string().default("/").describe("Absolute path (default /)"),
    },
    kind: "read",
  },
  ({ id, path }) => api("GET", `${mref(id)}/files`, { query: { path } }),
);

tool(
  "instabox_write_file",
  {
    title: "Write a file in a machine",
    description:
      "Create or replace a file inside a RUNNING machine, creating parent directories. Implemented over exec (base64 on stdin), so it is limited to about 700 KB of content; for bigger files use instabox_exec with curl/git inside the machine. Overwrites without asking. Relative paths start at /data/home.",
    inputSchema: {
      id: machineId,
      path: z.string().min(1).describe("Absolute path, or relative to /data/home"),
      content: z.string().describe("File content"),
      encoding: z.enum(["utf8", "base64"]).default("utf8").describe("How `content` is encoded (use base64 for binary)"),
      mode: z.string().regex(/^[0-7]{3,4}$/).optional().describe("Octal permissions to apply, e.g. 0755"),
    },
    kind: "write",
  },
  async ({ id, path, content, encoding, mode }) => {
    const b64 = encoding === "base64" ? content.replace(/\s+/g, "") : Buffer.from(content, "utf8").toString("base64");
    if (b64.length > 1_048_000) {
      throw new ApiError(400, "too_large", "Content is too large for write_file (about 700 KB max). Download it inside the machine with instabox_exec instead.");
    }
    const script =
      'set -e; mkdir -p -- "$(dirname -- "$IB_PATH")"; base64 -d > "$IB_PATH"; ' +
      '[ -z "$IB_MODE" ] || chmod "$IB_MODE" "$IB_PATH"; wc -c < "$IB_PATH"';
    const r = await api("POST", `${mref(id)}/exec`, {
      body: { cmd: script, stdin: b64, envs: { IB_PATH: path, IB_MODE: mode ?? "" }, timeoutSeconds: 60 },
    });
    if (r.exitCode !== 0) {
      throw new ApiError(500, "write_failed", `Writing ${path} failed (exit ${r.exitCode}): ${String(r.stderr).trim()}`);
    }
    return { path, bytesWritten: Number(String(r.stdout).trim()) || undefined };
  },
);

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

tool(
  "instabox_list_snapshots",
  {
    title: "List snapshots",
    description: "List your snapshots, oldest first. A snapshot is a saved copy of a machine's software and /data files (not memory or processes); new machines can start from it.",
    inputSchema: {},
    kind: "read",
  },
  () => api("GET", "/v1/snapshots"),
);

tool(
  "instabox_get_snapshot",
  {
    title: "Get a snapshot",
    description: "Get one snapshot by ID. `status` is ready (usable), pending (a live snapshot still uploading) or failed (see `error`).",
    inputSchema: { id: snapshotId },
    kind: "read",
  },
  ({ id }) => api("GET", `/v1/snapshots/${encodeURIComponent(id)}`),
);

tool(
  "instabox_list_snapshot_files",
  {
    title: "Browse a snapshot's files",
    description: "List a directory or read a text file from a snapshot's installed software without starting a machine. Files under /data are not shown.",
    inputSchema: { id: snapshotId, path: z.string().default("/").describe("Absolute path (default /)") },
    kind: "read",
  },
  ({ id, path }) => api("GET", `/v1/snapshots/${encodeURIComponent(id)}/files`, { query: { path } }),
);

tool(
  "instabox_create_snapshot",
  {
    title: "Save a snapshot of a machine",
    description:
      "Save a machine as a private snapshot, then start new machines from it with instabox_create_machine `snapshotId`. A stopped machine is saved at once; a running one is saved live (if the server allows) and the snapshot is `pending` until uploaded; data programs had not yet written to disk is not included. By default this waits until the snapshot is ready. Counts against your snapshot and storage limits. Needs images:write.",
    inputSchema: {
      id: machineId,
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).describe("Unique snapshot name: lowercase letters, digits, '-'"),
      description: z.string().optional(),
      rootOnly: z.boolean().optional().describe("Save installed software only; machines from it start with an empty home"),
      wait,
      waitTimeoutSeconds: waitTimeout,
    },
    kind: "write",
  },
  async ({ id, name, description, rootOnly, wait, waitTimeoutSeconds }) => {
    let snap = await api("POST", `${mref(id)}/snapshots`, { body: { name, description, rootOnly }, idempotent: true });
    if (!wait || snap.status !== "pending") return snap;
    const deadline = Date.now() + waitTimeoutSeconds * 1000;
    while (snap.status === "pending" && Date.now() < deadline) {
      await sleep(3000);
      snap = await api("GET", `/v1/snapshots/${encodeURIComponent(snap.id)}`);
    }
    if (snap.status === "failed") throw new ApiError(500, "snapshot_failed", snap.error ?? "Snapshot failed");
    return snap;
  },
);

tool(
  "instabox_delete_snapshot",
  {
    title: "Delete a snapshot",
    description:
      "PERMANENTLY delete a snapshot. Machines already created from it are not affected. `confirm` must be the snapshot's exact ID or name (server-checked). Needs images:delete.",
    inputSchema: {
      id: snapshotId,
      confirm: z.string().min(1).describe("The snapshot's exact ID or name, repeated to confirm"),
    },
    kind: "destructive",
  },
  async ({ id, confirm }) => {
    await api("DELETE", `/v1/snapshots/${encodeURIComponent(id)}`, {
      headers: { "X-Confirm-Delete": confirm },
      idempotent: true,
    });
    return { deleted: id };
  },
);

// ---------------------------------------------------------------------------
// Public ports
// ---------------------------------------------------------------------------

tool(
  "instabox_list_ports",
  {
    title: "List public ports",
    description: "List published ports (public HTTPS URLs) of one machine, or of all your machines when `id` is omitted.",
    inputSchema: { id: machineId.optional().describe("Machine ID or name; omit for all machines") },
    kind: "read",
  },
  ({ id }) => api("GET", id ? `${mref(id)}/ports` : "/v1/ports"),
);

tool(
  "instabox_publish_port",
  {
    title: "Publish a port",
    description:
      "Give a port of a machine a public HTTPS URL. WARNING: the URL is not secret; anyone who has it can reach the whole service on that port until you unpublish it. It does not start a server. A visit wakes an idle-paused machine. Max 16 per machine, ports 1024-65535. Publishing again keeps the URL and renames it.",
    inputSchema: {
      id: machineId,
      port: z.number().int().min(1024).max(65535),
      name: z.string().max(100).optional().describe("Display name (default 'Port N')"),
    },
    kind: "write",
    openWorld: true,
  },
  ({ id, port, name }) => api("POST", `${mref(id)}/ports`, { body: { port, name } }),
);

tool(
  "instabox_unpublish_port",
  {
    title: "Unpublish a port",
    description: "Remove a port's public URL and close its open connections. The server inside the machine keeps running.",
    inputSchema: { id: machineId, port: z.number().int().min(1).max(65535) },
    kind: "write",
  },
  async ({ id, port }) => {
    await api("DELETE", `${mref(id)}/ports/${port}`);
    return { unpublished: port };
  },
);

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------

tool(
  "instabox_create_ssh_token",
  {
    title: "Create an SSH token",
    description:
      "Create a ready-to-run `ssh` command for a machine (no key or CLI needed). SECURITY: the token is a secret; anyone holding it can log in to the machine until it expires or is revoked, and it is shown only in this response. Prefer a short ttl. Not idempotent: each call makes another token.",
    inputSchema: {
      id: machineId,
      name: z.string().max(100).optional().describe("Label to recognise the token by"),
      ttlSeconds: z.number().int().min(1).max(2_592_000).optional().describe("Lifetime in seconds (default 7 days, max 30 days)"),
    },
    kind: "write",
  },
  ({ id, name, ttlSeconds }) => api("POST", `${mref(id)}/ssh-tokens`, { body: { name, ttlSeconds } }),
);

tool(
  "instabox_list_ssh_tokens",
  {
    title: "List SSH tokens",
    description: "List a machine's SSH tokens (newest first), without their secrets.",
    inputSchema: { id: machineId },
    kind: "read",
  },
  ({ id }) => api("GET", `${mref(id)}/ssh-tokens`),
);

tool(
  "instabox_revoke_ssh_tokens",
  {
    title: "Revoke SSH tokens",
    description: "Revoke one SSH token (give `tokenId`) or every token of the machine (omit it), closing their connections.",
    inputSchema: { id: machineId, tokenId: z.string().optional().describe("Token ID (cn_...); omit to revoke all") },
    kind: "destructive",
  },
  ({ id, tokenId }) =>
    api("DELETE", tokenId ? `${mref(id)}/ssh-tokens/${encodeURIComponent(tokenId)}` : `${mref(id)}/ssh-tokens`),
);

// ---------------------------------------------------------------------------
// Org Secrets (metadata and sandbox selections; values can never be read or written with an API key)
// ---------------------------------------------------------------------------

tool(
  "instabox_list_org_secrets",
  {
    title: "List org Secret metadata",
    description:
      "List the names, delivery mode (proxy or env), allowed hosts and versions of an org's Secrets. Values are never returned. Get the org ID from instabox_whoami or a machine's `orgId`.",
    inputSchema: { orgId: z.string().describe("Org ID (org_...)") },
    kind: "read",
  },
  ({ orgId }) => api("GET", `/v1/orgs/${encodeURIComponent(orgId)}/secrets`),
);

tool(
  "instabox_get_machine_secrets",
  {
    title: "Inspect a machine's Secrets",
    description: "Show which org Secrets a machine has selected and the delivery status of the outbound proxy and the guest environment (metadata only).",
    inputSchema: { id: machineId },
    kind: "read",
  },
  ({ id }) => api("GET", `${mref(id)}/secrets`),
);

tool(
  "instabox_update_machine_secrets",
  {
    title: "Change a machine's Secret selection",
    description:
      "Replace the org Secrets a machine may use. Each field you pass replaces that whole selection; omitted fields stay as they are. SECURITY: `secrets` lets code in the machine send those credentials to their allowed hosts, and `envSecrets` puts real values into the machine. Delivery then updates in the background; refresh with instabox_refresh_machine_secrets.",
    inputSchema: {
      id: machineId,
      secrets: secretSelection.optional(),
      envSecrets: z.array(z.string()).optional().describe("Explicit env Secret names; [] clears"),
    },
    kind: "write",
  },
  ({ id, secrets, envSecrets }) => {
    if (secrets === undefined && envSecrets === undefined) {
      throw new ApiError(400, "bad_request", "Pass `secrets` and/or `envSecrets`.");
    }
    return api("PATCH", `${mref(id)}/secrets`, { body: { secrets, envSecrets } });
  },
);

tool(
  "instabox_refresh_machine_secrets",
  {
    title: "Refresh a machine's Secret delivery",
    description: "Push the current Secret selection to a RUNNING machine now (installs the environment and CA, requests proxy reconciliation). Check the returned proxy and guest statuses.",
    inputSchema: { id: machineId },
    kind: "write",
  },
  ({ id }) => api("POST", `${mref(id)}/secrets`),
);

// ---------------------------------------------------------------------------
// Prompts (slash commands in clients that support MCP prompts, e.g. /mcp__instabox__status)
// ---------------------------------------------------------------------------

function prompt<S extends z.ZodRawShape>(
  name: string,
  cfg: { title: string; description: string; argsSchema?: S },
  text: (args: z.objectOutputType<S, z.ZodTypeAny>) => string,
) {
  server.registerPrompt(
    name,
    { title: cfg.title, description: cfg.description, argsSchema: cfg.argsSchema as any },
    ((args: any) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: text(args ?? {}) } }],
    })) as any,
  );
}

prompt(
  "status",
  { title: "InstaBox status", description: "Summarise the account, limits, machines, snapshots and public ports." },
  () =>
    "Use the InstaBox tools to give me a short status report: who I am (instabox_whoami), usage against plan limits (instabox_get_usage), every machine with its state, template and labels (instabox_list_machines), snapshots (instabox_list_snapshots) and published ports (instabox_list_ports). Finish with anything that looks wrong or close to a limit. Change nothing.",
);

prompt(
  "run",
  {
    title: "Run a command",
    description: "Run a shell command on a machine and show the result.",
    argsSchema: {
      machine: z.string().describe("Machine ID or name"),
      command: z.string().describe("Shell command to run"),
    },
  },
  ({ machine, command }) =>
    `Run this shell command on InstaBox machine "${machine}" with instabox_exec (cmd, not argv) and show stdout, stderr and the exit code. If the machine is not running, tell me instead of starting it.\n\nCommand:\n${command}`,
);

prompt(
  "new-sandbox",
  {
    title: "New throwaway sandbox",
    description: "Create a short-lived machine, optionally run a setup command, and report how to use it.",
    argsSchema: {
      name: z.string().optional().describe("Machine name (default: random)"),
      template: z.string().optional().describe("Template ID (default: agent-browser)"),
      lifetime_minutes: z.string().optional().describe("Auto-delete after this many minutes (default 60, max 1440)"),
      setup: z.string().optional().describe("Shell command to run once the machine is up"),
    },
  },
  ({ name, template, lifetime_minutes, setup }) => {
    const mins = Math.min(1440, Math.max(1, Number(lifetime_minutes) || 60));
    return [
      "Check instabox_get_usage first; if I am at my machine limit, stop and tell me which machine is in the way instead of deleting anything.",
      `Otherwise create a machine with instabox_create_machine${name ? ` named "${name}"` : ""}${template ? `, templateId "${template}"` : ""}, deleteAfterSeconds ${mins * 60}.`,
      setup ? `Then run this with instabox_exec and show the output:\n${setup}` : "",
      `Finish with the machine ID, state and when it will be deleted (${mins} minutes).`,
    ]
      .filter(Boolean)
      .join("\n");
  },
);

prompt(
  "expose",
  {
    title: "Publish a port",
    description: "Publish a machine port as a public HTTPS URL and check something is listening.",
    argsSchema: {
      machine: z.string().describe("Machine ID or name"),
      port: z.string().describe("Port number (1024-65535)"),
    },
  },
  ({ machine, port }) =>
    `On InstaBox machine "${machine}", first check with instabox_exec (for example \`ss -ltn\`) that something listens on port ${port}. If nothing does, say so and ask before publishing. Otherwise publish it with instabox_publish_port and give me the URL. Remind me that the URL is public until unpublished.`,
);

prompt(
  "backup",
  {
    title: "Snapshot a machine",
    description: "Save a machine as a snapshot and wait until it is ready.",
    argsSchema: {
      machine: z.string().describe("Machine ID or name"),
      name: z.string().optional().describe("Snapshot name (default: <machine>-backup)"),
    },
  },
  ({ machine, name }) =>
    `Check instabox_get_usage for snapshot limits, then save InstaBox machine "${machine}" as a snapshot named "${name || `${machine}-backup`}" with instabox_create_snapshot (wait for it). If a snapshot with that name exists or I am at the limit, stop and tell me. Report the snapshot ID and status.`,
);

prompt(
  "cleanup",
  {
    title: "Find machines to clean up",
    description: "List machines and snapshots that look unused and propose what to delete (never deletes without asking).",
  },
  () =>
    "List my InstaBox machines (with instabox_list_machines and instabox_get_machine_usage for each) and snapshots. Identify what looks idle, stopped or forgotten, and propose what to delete or stop. Do NOT delete or stop anything: present the list with IDs and wait for me to confirm each item.",
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only: stdout is the MCP protocol channel.
  console.error(
    `instabox-mcp ${VERSION} ready (api: ${API_URL}, key: ${API_KEY ? "set" : "MISSING"}, mode: ${READ_ONLY ? "read-only" : "read-write"})`,
  );
}

main().catch((e) => {
  console.error("instabox-mcp failed to start:", e);
  process.exit(1);
});
