import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const transientNetworkError = /\b(?:TLS|SSL|EOF|timed? ?out|timeout)\b|connection (?:reset|closed)|remote end hung up unexpectedly/i;

function remoteIdentity(url, root) {
  const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(url);
  if (url.includes("://") || scp) {
    const parsed = new URL(url.includes("://") ? url : `ssh://${scp[1]}/${scp[2]}`);
    if (parsed.protocol === "file:") return remoteIdentity(fileURLToPath(parsed), root);
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol) || parsed.search || parsed.hash) {
      throw new Error("Unsupported remote URL");
    }
    const repoPath = path.posix.normalize("/" + decodeURIComponent(parsed.pathname))
      .replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
    return `network:${parsed.hostname.toLowerCase().replace(/\.$/, "")}${repoPath}`;
  }

  if (url.includes(":")) throw new Error("Unsupported remote URL");
  return `local:${fs.realpathSync(path.resolve(root, url))}`;
}

function displayUrl(url) {
  if (!url.includes("://")) return url;
  const parsed = new URL(url);
  if (!parsed.username && !parsed.password) return url;
  parsed.username = "";
  parsed.password = "";
  return parsed.href;
}

export async function runPushPrivate(args, { root, scanSecrets }) {
  const result = {
    ok: false,
    mode: "push",
    remote: "origin",
    remote_url: null,
    branch: "main",
    local_sha: null,
    remote_sha_before: null,
    remote_sha_after: null,
    pushed: false,
    up_to_date: false,
    check_secrets: { scanned_files: 0, hits: [] },
  };

  const env = { ...process.env };
  for (const name of [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
    "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
  ]) delete env[name];

  const git = (args) => execFileSync("git", args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  async function gitNetwork(args, failure, beforeAttempt = () => {}) {
    for (let retries = 0; ; retries++) {
      beforeAttempt();
      try {
        return git(args);
      } catch (error) {
        if (retries === 3 || !transientNetworkError.test(String(error.stderr || ""))) {
          throw new Error(failure);
        }
        await delay(1000 * 2 ** retries);
      }
    }
  }

  function remoteUrls(name, flags) {
    try {
      return git(["remote", "get-url", "--all", ...flags, name]).split("\n");
    } catch {
      throw new Error(`Could not resolve configured remote "${name}"`);
    }
  }

  function checkedDestination() {
    const urls = remoteUrls(result.remote, ["--push"]);
    if (urls.length !== 1) throw new Error("The private remote must have exactly one push URL");
    const [url] = urls;
    const templateUrls = [...remoteUrls("template", []), ...remoteUrls("template", ["--push"])];
    const identity = remoteIdentity(url, root);
    if (templateUrls.some(templateUrl => remoteIdentity(templateUrl, root) === identity)) {
      throw new Error("The destination matches the public template remote. Use sync-template --push");
    }
    if (remoteIdentity(git(["ls-remote", "--get-url", "--", url]), root) !== identity) {
      throw new Error("Readback URL resolves to a different repository");
    }
    return url;
  }

  function checkedHead() {
    let branch;
    try {
      branch = git(["symbolic-ref", "--quiet", "HEAD"]);
    } catch {
      throw new Error("A checked-out branch is required");
    }
    if (branch !== `refs/heads/${result.branch}`) {
      throw new Error(`Current branch must match "${result.branch}"`);
    }
    if (git(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"])) {
      throw new Error("The working tree must be clean");
    }
    return git(["rev-parse", "--verify", "HEAD"]);
  }

  try {
    const flags = new Set();
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flags.has(flag)) throw new Error(`Duplicate argument "${flag}"`);
      flags.add(flag);
      if (flag === "--dry-run") {
        result.mode = "dry-run";
      } else if (flag === "--remote" || flag === "--branch") {
        const value = args[++i];
        if (!value || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value)) {
          throw new Error(`Invalid value for "${flag}"`);
        }
        result[flag.slice(2)] = value;
      } else {
        throw new Error("Expected only --remote, --branch or --dry-run");
      }
    }
    if (result.remote === "template") {
      throw new Error("The template remote is public. Use sync-template --push");
    }
    if (fs.realpathSync(git(["rev-parse", "--show-toplevel"])) !== fs.realpathSync(root)) {
      throw new Error("The command must operate on the zstack repository");
    }
    const ref = `refs/heads/${result.branch}`;
    git(["check-ref-format", ref]);

    const url = checkedDestination();
    result.remote_url = displayUrl(url);
    result.local_sha = checkedHead();
    result.check_secrets = scanSecrets();
    if (result.check_secrets.hits.length > 0) throw new Error("check-secrets found matches");

    async function remoteSha() {
      const refs = await gitNetwork(["ls-remote", "--refs", "--", url, ref], "Could not read the remote branch");
      if (!refs) return null;
      const [sha, remoteRef] = refs.split("\t");
      if (remoteRef !== ref || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) {
        throw new Error("Unexpected remote branch readback");
      }
      return sha;
    }

    result.remote_sha_before = await remoteSha();
    result.up_to_date = result.remote_sha_before === result.local_sha;
    if (result.mode === "dry-run" || result.up_to_date) {
      result.remote_sha_after = result.remote_sha_before;
    } else {
      const pushArgs = [
        "-c", `remote.${result.remote}.mirror=false`,
        "push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no",
        "--", result.remote, `${result.local_sha}:${ref}`,
      ];
      const pushOutput = await gitNetwork(pushArgs, "Private push failed. Check access and fast-forward status", () => {
        if (checkedDestination() !== url || checkedHead() !== result.local_sha) {
          throw new Error("The destination or local commit changed during validation");
        }
      });
      result.pushed = pushOutput.split("\n").some(line => /^[ *]\t/.test(line));
      result.remote_sha_after = await remoteSha();
      if (result.remote_sha_after !== result.local_sha) {
        throw new Error("The remote branch does not match the scanned local commit");
      }
      result.up_to_date = !result.pushed;
    }
    result.ok = true;
  } catch (error) {
    result.error = error.cmd ? "Could not validate the local Git repository or branch" : error.message;
    process.exitCode = 1;
  }
  console.log(JSON.stringify(result, null, 2));
}
