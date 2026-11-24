import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 4398;
const base = `http://127.0.0.1:${port}`;
const shaA = "a".repeat(40);
const shaB = "b".repeat(40);

async function api(endpoint, method = "GET", body, headers = {}) {
  return fetch(base + endpoint, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("GitHub watcher through the board and signed webhook", { timeout: 35000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zstack-github-"));
  const cache = path.join(dir, ".zstack-cache");
  const input = path.join(dir, "github.json");
  const write = (name, value) => fs.writeFileSync(name, JSON.stringify(value));
  let child;
  const received = [];
  const receiver = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ raw: Buffer.concat(chunks), signature: req.headers["x-zstack-signature"] });
    res.writeHead(204).end();
  });
  t.after(async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    receiver.closeAllConnections();
    await new Promise(resolve => receiver.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");

  for (const entry of ["scripts", ".zstack-cache", "projects/example", "tasks/active/example-2", "bin"]) {
    fs.mkdirSync(path.join(dir, entry), { recursive: true });
  }
  for (const file of ["zstack", "board-core.mjs", "dashboard-server.mjs", "dashboard-ui.html", "github-poller.mjs"]) {
    fs.copyFileSync(path.join(root, "scripts", file), path.join(dir, "scripts", file));
  }
  const secret = "local-test-signature-fixture";
  write(path.join(cache, "webhook.json"), { webhook_url: `http://127.0.0.1:${receiver.address().port}`, secret });
  write(path.join(cache, "github-watch.json"), { intervalSeconds: 3600 });
  fs.writeFileSync(path.join(dir, "projects/example/project.yaml"), 'repository:\n  canonical: "github.com/owner/repo"\n');
  write(path.join(dir, "tasks/active/example-2/state.json"), {
    task_id: "example-2", project_slug: "example", phase: "in_progress",
    pull_request: { url: "https://github.com/owner/repo/pull/2" },
  });
  fs.writeFileSync(path.join(dir, "bin/gh"), `#!${process.execPath}
const fs = require("node:fs");
const crypto = require("node:crypto");
const argv = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(process.env.ZSTACK_TEST_GITHUB, "utf8"));
if (argv.includes("user")) {
  if (fixture.unauthenticated) process.exit(1);
  console.log("your-org");
  process.exit(0);
}
const key = argv[argv.indexOf("--include") + 1];
const data = fixture[key];
if (data === undefined) process.exit(1);
const payload = JSON.stringify(data);
const tag = '"' + crypto.createHash("sha256").update(payload).digest("hex") + '"';
if (argv.includes("If-None-Match: " + tag)) {
  process.stdout.write("HTTP/2.0 304 Not Modified\\r\\n\\r\\n");
  process.exit(1);
}
const link = key === "repos/owner/repo/pulls?state=open&per_page=100"
  ? "Link: <https://api.github.com/repos/owner/repo/pulls?page=2>; rel=\\"next\\"\\r\\n" : "";
process.stdout.write("HTTP/2.0 200 OK\\r\\nETag: " + tag + "\\r\\n" + link + "\\r\\n" + payload);
`, { mode: 0o700 });

  const list = "repos/owner/repo/pulls?state=open&per_page=100";
  const page2 = "repos/owner/repo/pulls?page=2";
  const head = "repos/owner/repo/pulls/2";
  const issue = "repos/owner/repo/issues/2/comments?per_page=100";
  const inline = "repos/owner/repo/pulls/2/comments?per_page=100";
  const reviews = "repos/owner/repo/pulls/2/reviews?per_page=100";
  const reviewer = { login: "your-org" };
  const pr = (number, field) => ({ number, head: { sha: shaA }, [field]: [reviewer] });
  const comment = (id, login = "another-user") => ({ id, user: { login }, body: "untrusted test comment" });
  const fixture = {
    [list]: [pr(1, "requested_reviewers"), pr(2, "assignees")],
    [page2]: [],
    [head]: { state: "open", head: { sha: shaA } },
    [issue]: [comment(10)],
    [inline]: [comment(11)],
    [reviews]: [{ ...comment(12), submitted_at: "2026-01-01T00:00:00Z" }],
  };
  write(input, fixture);

  async function start() {
    child = spawn(process.execPath, ["scripts/zstack", "serve", "--port", String(port)], {
      cwd: dir, env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, ZSTACK_TEST_GITHUB: input },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ready = await Promise.race([
      once(child.stdout, "data").then(([data]) => data.toString()),
      once(child, "exit").then(([code]) => `exit ${code}`),
    ]);
    assert.match(ready, /127\.0\.0\.1:4398/);
  }
  const sync = async () => (await api("/api/github/sync", "POST", {})).json();
  const status = async () => (await api("/api/github/status")).json();
  await start();
  assert.equal((await sync()).events, 0);
  assert.equal(received.length, 0);
  assert.deepEqual((await status()).repos, ["owner/repo"]);
  assert.equal((await sync()).allNotModified, true);

  fixture[page2].push(pr(3, "requested_reviewers"), pr(4, "assignees"));
  fixture[head].head.sha = shaB;
  fixture[issue].push(comment(13, "your-org"), comment(14));
  fixture[inline].push(comment(14));
  fixture[reviews].push({ ...comment(15), submitted_at: "2026-01-02T00:00:00Z" });
  write(input, fixture);
  assert.equal((await sync()).events, 6);
  assert.deepEqual(received.map(({ raw }) => JSON.parse(raw).action.kind), [
    "github_pr_review_requested", "github_pr_review_requested", "github_pr_synchronized",
    "github_pr_commented", "github_pr_commented", "github_pr_commented",
  ]);
  const inbox = fs.readFileSync(path.join(cache, "inbox.jsonl"), "utf8");
  for (const { raw, signature } of received) {
    const payload = JSON.parse(raw);
    assert.equal(signature, "sha256=" + createHmac("sha256", secret).update(raw).digest("hex"));
    assert.equal(payload.source, "zstack-dashboard");
    assert.equal(payload.action.source, "github-poller");
    assert.equal(payload.action_id, payload.action.id);
    assert.ok(inbox.includes(payload.action_id));
    assert.doesNotMatch(raw.toString(), /untrusted test comment|"comment_id":13/);
  }
  assert.equal((await sync()).events, 0);
  assert.equal((await api("/api/github/config", "PATCH", { intervalSeconds: 0 })).status, 400);
  assert.equal((await api("/api/github/config", "PATCH", { enabled: false }, { Origin: "https://example.com" })).status, 403);
  assert.equal((await (await api("/api/github/config", "PATCH", { enabled: false, intervalSeconds: 120 })).json()).state, "paused");
  assert.equal((await sync()).notModified, 0);
  assert.equal((await (await api("/api/github/config", "PATCH", { enabled: true })).json()).intervalSeconds, 120);
  assert.equal((await sync()).allNotModified, true);

  let exit = once(child, "exit");
  child.kill();
  await exit;
  await start();
  assert.equal((await sync()).allNotModified, true);
  assert.equal(received.length, 6);
  assert.equal((await status()).stats.events, 6);

  delete fixture[head];
  write(input, fixture);
  assert.match((await sync()).error, /request failed/);
  assert.equal((await status()).state, "degraded");
  fixture[head] = { state: "open", head: { sha: shaB } };
  write(input, fixture);
  assert.equal((await sync()).allNotModified, true);
  assert.equal((await status()).state, "active");

  const page = await (await api("/")).text();
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  new Script(script);
  assert.match(page, /class="github-trigger" id="github-trigger" aria-expanded="false" aria-controls="github-panel"/);
  for (const pattern of [/api\/github\/status/, /api\/github\/sync/, /api\/github\/config/, /立即同步/, /暂停监听/]) {
    assert.match(page, pattern);
  }

  exit = once(child, "exit");
  child.kill();
  await exit;
  fixture.unauthenticated = true;
  write(input, fixture);
  await start();
  assert.match((await sync()).error, /gh auth status/);
  assert.equal((await status()).state, "degraded");
  assert.equal((await api("/api/health")).status, 200);
});

test("daemon dry run generates a valid loopback launch agent", { skip: process.platform !== "darwin" }, () => {
  const plist = execFileSync(process.execPath, ["scripts/zstack", "daemon", "install", "--port", "4398", "--dry-run"], { cwd: root });
  const result = execFileSync("plutil", ["-lint", "-"], { input: plist, encoding: "utf8" });
  assert.match(result, /OK/);
  for (const pattern of [/dev\.zstack\.daemon/, /KeepAlive.*true/, /RunAtLoad.*true/, /127\.0\.0\.1/, /4398/, /daemon\.log/, /<key>HOME<\/key>/, /<key>PATH<\/key>/]) {
    assert.match(plist.toString(), pattern);
  }
});
