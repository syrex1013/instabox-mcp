import { spawn } from "node:child_process";

// Usage: node scripts/live-test.mjs <dist/index.js> <read|lifecycle|existing|existing-write>
const [, , server, phase = "read"] = process.argv;
const p = spawn("node", [server], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const pending = new Map();
p.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id && pending.has(m.id)) pending.get(m.id)(m);
  }
});
p.stderr.on("data", () => {});
let n = 0;
const rpc = (method, params) =>
  new Promise((res) => {
    const id = ++n;
    pending.set(id, res);
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const call = async (name, args = {}) => {
  const r = (await rpc("tools/call", { name, arguments: args })).result;
  const text = r.content?.[0]?.text ?? "";
  let data = text;
  try { data = JSON.parse(text); } catch {}
  return { isError: !!r.isError, data };
};
const show = (label, r, pick) => {
  const body = r.isError ? r.data : pick ? pick(r.data) : r.data;
  console.log(`${r.isError ? "FAIL" : "ok  "} ${label}:`, typeof body === "string" ? body : JSON.stringify(body));
};

await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "live", version: "0" } });
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

if (phase === "read") {
  show("whoami", await call("instabox_whoami"), (d) => ({ login: d.login, admin: d.admin, orgId: d.orgId, allowedSpecs: d.allowedSpecs, manualLifecycle: d.manualLifecycle }));
  show("templates", await call("instabox_list_templates"), (d) => d.templates.map((t) => `${t.id}${t.creatable === false ? "(not creatable)" : ""}`));
  show("usage", await call("instabox_get_usage"), (d) => ({ machines: d.machines, snapshots: d.snapshots, limits: { maxMachines: d.limits.maxMachines, maxSnapshots: d.limits.maxSnapshots, maxStoredGiB: d.limits.maxStoredGiB } }));
  const list = await call("instabox_list_machines");
  show("list_machines", list, (d) => d.machines.map((m) => ({ id: m.id, name: m.name, state: m.state, template: m.template?.id })));
  show("list_snapshots", await call("instabox_list_snapshots"), (d) => d.snapshots.map((s) => ({ id: s.id, name: s.name, status: s.status })));
  show("list_ports(all)", await call("instabox_list_ports"), (d) => ({ enabled: d.enabled, count: d.ports.length }));
}

if (phase === "lifecycle") {
  const name = "mcp-test-" + Math.random().toString(36).slice(2, 8);
  const c = await call("instabox_create_machine", { name, deleteAfterSeconds: 900, metadata: { purpose: "mcp-smoke-test" }, waitTimeoutSeconds: 420 });
  show("create_machine", c, (d) => ({ op: d.operation, id: d.machine?.id, state: d.machine?.state, ready: d.machine?.runtime?.ready, spec: d.machine?.spec, template: d.machine?.template?.id }));
  if (!c.isError) {
    const id = c.data.machine?.id ?? name;
    try {
      show("get_machine", await call("instabox_get_machine", { id: name }), (d) => ({ id: d.id, state: d.state, guestUser: d.guestUser }));
      show("list_machines(filter)", await call("instabox_list_machines", { metadata: { purpose: "mcp-smoke-test" } }), (d) => d.machines.map((m) => m.name));
      show("exec(cmd)", await call("instabox_exec", { id, cmd: "echo hello; whoami; pwd; uname -sr; echo err >&2; exit 3" }), (d) => ({ stdout: d.stdout, stderr: d.stderr, exitCode: d.exitCode }));
      show("exec(argv)", await call("instabox_exec", { id, argv: ["printf", "%s|", "a b", "$X"] }), (d) => ({ stdout: d.stdout, exitCode: d.exitCode }));
      show("exec(stdin+env)", await call("instabox_exec", { id, cmd: 'cat; echo "$FOO"', stdin: "from-stdin\n", envs: { FOO: "bar" } }), (d) => ({ stdout: d.stdout, exitCode: d.exitCode }));
      show("write_file", await call("instabox_write_file", { id, path: "mcp-test/hello.txt", content: "héllo wörld ✓\nline2\n", mode: "0644" }));
      show("exec(cat file)", await call("instabox_exec", { id, cmd: "cat mcp-test/hello.txt; ls -l mcp-test/hello.txt" }), (d) => d.stdout);
      show("list_files(dir)", await call("instabox_list_files", { id, path: "/data/home/mcp-test" }), (d) => ({ type: d.type, entries: d.entries?.map((e) => `${e.name}:${e.size}`) }));
      show("list_files(file)", await call("instabox_list_files", { id, path: "/data/home/mcp-test/hello.txt" }), (d) => ({ type: d.type, content: d.content }));
      show("update_machine(labels)", await call("instabox_update_machine", { id, metadata: { purpose: "mcp-smoke-test", step: "updated" } }), (d) => d.metadata);
      show("publish_port", await call("instabox_publish_port", { id, port: 8080, name: "mcp test" }), (d) => ({ port: d.port, url: d.url }));
      show("list_ports(machine)", await call("instabox_list_ports", { id }), (d) => d.ports.map((x) => x.port));
      show("unpublish_port", await call("instabox_unpublish_port", { id, port: 8080 }));
      show("get_machine_metrics", await call("instabox_get_machine_metrics", { id }), (d) => ({ samples: d.metrics?.length }));
      show("get_machine_usage", await call("instabox_get_machine_usage", { id }), (d) => ({ runningSeconds: d.runningSeconds, vcpuSeconds: d.vcpuSeconds }));
      show("get_machine_secrets", await call("instabox_get_machine_secrets", { id }), (d) => ({ proxy: d.proxy?.state, guest: d.guest?.state, items: d.items?.length }));
      show("suspend", await call("instabox_machine_power", { id, action: "suspend" }), (d) => ({ op: d.operation, state: d.machine?.state }));
      show("resume", await call("instabox_machine_power", { id, action: "resume" }), (d) => ({ op: d.operation, state: d.machine?.state }));
      show("exec after resume", await call("instabox_exec", { id, cmd: "cat mcp-test/hello.txt | head -1" }), (d) => d.stdout);
      show("stop", await call("instabox_machine_power", { id, action: "stop" }), (d) => ({ op: d.operation, state: d.machine?.state }));
      show("exec on stopped (expect error)", await call("instabox_exec", { id, cmd: "true" }));
    } finally {
      show("delete (wrong confirm, expect refusal)", await call("instabox_delete_machine", { id, confirm: "not-the-name" }));
      show("delete (correct confirm)", await call("instabox_delete_machine", { id, confirm: name }), (d) => ({ op: d.operation }));
      show("get_machine after delete (expect not_found)", await call("instabox_get_machine", { id: name }));
    }
  }
}

if (phase === "existing") {
  const id = process.env.MACHINE_ID;
  show("get_machine", await call("instabox_get_machine", { id }), (d) => ({ id: d.id, state: d.state, guestUser: d.guestUser }));
  show("exec(cmd)", await call("instabox_exec", { id, cmd: "echo hello; whoami; uname -sr; echo err >&2; exit 3" }), (d) => ({ stdout: d.stdout, stderr: d.stderr, exitCode: d.exitCode }));
  show("exec(argv)", await call("instabox_exec", { id, argv: ["printf", "%s|", "a b", "$X"] }), (d) => ({ stdout: d.stdout, exitCode: d.exitCode }));
  show("exec(stdin+env)", await call("instabox_exec", { id, cmd: 'cat; echo "$FOO"', stdin: "from-stdin\n", envs: { FOO: "bar" } }), (d) => ({ stdout: d.stdout, exitCode: d.exitCode }));
  show("exec(cmd+argv, expect error)", await call("instabox_exec", { id, cmd: "a", argv: ["b"] }));
  show("list_files(dir)", await call("instabox_list_files", { id, path: "/data/home" }), (d) => ({ type: d.type, n: d.entries?.length }));
  show("list_files(file)", await call("instabox_list_files", { id, path: "/etc/hostname" }), (d) => ({ type: d.type, content: d.content }));
  show("list_ports(machine)", await call("instabox_list_ports", { id }), (d) => d.ports.length);
  show("get_machine_metrics", await call("instabox_get_machine_metrics", { id }), (d) => d);
  show("get_machine_usage", await call("instabox_get_machine_usage", { id }), (d) => d);
  show("get_machine_secrets", await call("instabox_get_machine_secrets", { id }), (d) => d);
  show("delete wrong confirm (expect refusal, nothing deleted)", await call("instabox_delete_machine", { id, confirm: "not-the-name" }));
}

if (phase === "existing-write") {
  const id = process.env.MACHINE_ID;
  show("write_file", await call("instabox_write_file", { id, path: "/tmp/mcp-test/hello.txt", content: "héllo wörld ✓\nline2\n", mode: "0644" }));
  show("read back", await call("instabox_list_files", { id, path: "/tmp/mcp-test/hello.txt" }), (d) => d.content);
  show("cleanup", await call("instabox_exec", { id, argv: ["rm", "-rf", "/tmp/mcp-test"] }), (d) => d.exitCode);
  show("publish_port", await call("instabox_publish_port", { id, port: 8080, name: "mcp test" }), (d) => ({ port: d.port, hasUrl: !!d.url }));
  show("list_ports", await call("instabox_list_ports", { id }), (d) => d.ports.map((x) => x.port));
  show("unpublish_port", await call("instabox_unpublish_port", { id, port: 8080 }));
  const t = await call("instabox_create_ssh_token", { id, name: "mcp-test", ttlSeconds: 300 });
  show("create_ssh_token", t, (d) => ({ keys: Object.keys(d), id: d.id ?? d.token?.id }));
  const tid = t.data?.id ?? t.data?.token?.id;
  show("list_ssh_tokens", await call("instabox_list_ssh_tokens", { id }), (d) => JSON.stringify(d).replace(/ssh [^"]*/g, "ssh <redacted>").slice(0, 300));
  if (tid) show("revoke_ssh_token", await call("instabox_revoke_ssh_tokens", { id, tokenId: tid }));
  show("suspend", await call("instabox_machine_power", { id, action: "suspend" }), (d) => ({ op: d.operation, state: d.machine?.state }));
  show("resume", await call("instabox_machine_power", { id, action: "resume" }), (d) => ({ op: d.operation, state: d.machine?.state }));
  show("exec after resume", await call("instabox_exec", { id, cmd: "echo alive" }), (d) => d.stdout);
}

p.kill();
