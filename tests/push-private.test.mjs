import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zstack-private-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "repo");
  const origin = path.join(dir, "private.git");
  const template = path.join(dir, "public.git");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: "pipe" }).trim();
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  for (const file of ["zstack", "board-core.mjs", "push-private.mjs"]) {
    fs.copyFileSync(new URL(`../scripts/${file}`, import.meta.url), path.join(root, "scripts", file));
  }
  git("init", "-b", "main");
  git("init", "--bare", "-b", "main", origin);
  git("init", "--bare", "-b", "main", template);
  git("remote", "add", "origin", origin);
  git("remote", "add", "template", template);
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  const write = (name, content) => fs.writeFileSync(path.join(root, name), content);
  const commit = () => {
    git("add", "-A");
    git("commit", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  const initial = commit();
  git("push", "origin", "main");

  const run = (...args) => {
    const run = spawnSync(process.execPath, [path.join(root, "scripts", "zstack"), "push-private", ...args], {
      cwd: dir,
      env,
      encoding: "utf8",
    });
    return { status: run.status, output: JSON.parse(run.stdout) };
  };
  const remoteHead = () => git("--git-dir", origin, "rev-parse", "refs/heads/main");
  return { git, run, write, commit, initial, remoteHead, template, origin };
}

test("dry run scans and reports the remote without updating it", t => {
  const f = fixture(t);
  f.write("update.md", "safe content");
  const local = f.commit();
  const { status, output } = f.run("--dry-run");
  assert.equal(status, 0);
  assert.equal(output.ok, true);
  assert.equal(output.mode, "dry-run");
  assert.equal(output.local_sha, local);
  assert.equal(output.remote_sha_before, f.initial);
  assert.equal(output.remote_sha_after, f.initial);
  assert.equal(output.pushed, false);
  assert.ok(output.check_secrets.scanned_files > 0);
  assert.deepEqual(output.check_secrets.hits, []);
  assert.equal(f.remoteHead(), f.initial);
});

test("rejects the template by name and by normalized effective push URL", t => {
  const f = fixture(t);
  assert.match(f.run("--remote", "template").output.error, /template remote is public/);
  f.git("remote", "set-url", "--push", "origin", pathToFileURL(f.template).href + "/");
  const { status, output } = f.run();
  assert.equal(status, 1);
  assert.match(output.error, /matches the public template/);
});

test("rejects SSH and HTTPS spellings of the same template repository", t => {
  const f = fixture(t);
  f.git("remote", "set-url", "template", "https://example.test/Owner/Repo.git");
  f.git("remote", "set-url", "--push", "origin", "git@EXAMPLE.test:owner/repo");
  assert.match(f.run().output.error, /matches the public template/);
});

test("rejects dirty, mismatched, and detached worktrees", t => {
  const f = fixture(t);
  assert.match(f.run("--branch", "other").output.error, /Current branch/);
  f.git("checkout", "--detach");
  assert.match(f.run().output.error, /checked-out branch/);
  f.git("checkout", "main");
  f.write("uncommitted.md", "untracked");
  assert.match(f.run().output.error, /working tree must be clean/);
  assert.equal(f.remoteHead(), f.initial);
});

test("rejects a scanner hit in a clean committed worktree", t => {
  const f = fixture(t);
  f.write("fixture.md", "ghp_" + "x".repeat(30));
  f.commit();
  const { status, output } = f.run();
  assert.equal(status, 1);
  assert.equal(output.ok, false);
  assert.equal(output.check_secrets.hits.length, 1);
  assert.equal(output.check_secrets.hits[0].file, "fixture.md");
  assert.equal(f.remoteHead(), f.initial);
});

test("pushes a fast-forward and reports an unchanged second run", t => {
  const f = fixture(t);
  f.write("update.md", "safe content");
  const local = f.commit();
  const { status, output } = f.run("--remote", "origin", "--branch", "main");
  assert.equal(status, 0);
  assert.equal(output.pushed, true);
  assert.equal(output.remote_sha_before, f.initial);
  assert.equal(output.remote_sha_after, local);
  assert.equal(f.remoteHead(), local);
  const again = f.run();
  assert.equal(again.status, 0);
  assert.equal(again.output.up_to_date, true);
  assert.equal(again.output.pushed, false);
});

test("rejects a non-fast-forward even with mirror mode configured", t => {
  const f = fixture(t);
  f.write("update.md", "safe content");
  const newer = f.commit();
  f.git("push", "origin", "main");
  f.git("reset", "--hard", f.initial);
  f.git("config", "remote.origin.mirror", "true");
  const { status, output } = f.run();
  assert.equal(status, 1);
  assert.match(output.error, /fast-forward/);
  assert.equal(f.remoteHead(), newer);
});
