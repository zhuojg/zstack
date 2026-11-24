import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeAtomicJson } from "./github-poller.mjs";

const label = "dev.zstack.daemon";
const defaultPort = 4390;

function xml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[char]);
}

function plistFor(root, home, log, port) {
  const gh = spawnSync("/usr/bin/which", ["gh"], { encoding: "utf8" });
  const searchPath = [...new Set([
    path.dirname(process.execPath),
    ...(gh.status === 0 ? [path.dirname(gh.stdout.trim())] : []),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ])].join(":");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    ${[process.execPath, path.join(root, "scripts", "zstack"), "serve", "--host", "127.0.0.1", "--port", port]
      .map(arg => `<string>${xml(arg)}</string>`).join("\n    ")}
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xml(home)}</string>
    <key>PATH</key><string>${xml(searchPath)}</string>
    <key>ZSTACK_LAUNCHD_LABEL</key><string>${label}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

function launchctl(args, required = true) {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (required && result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.error?.message || "launchctl failed");
  }
  return result;
}

function portAvailable(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/github/status`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function runDaemon(args, root) {
  const [cmd, ...flags] = args;
  const home = os.homedir();
  const cache = path.join(root, ".zstack-cache");
  const state = path.join(cache, "daemon.json");
  const log = path.join(cache, "daemon.log");
  const plist = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  const domain = `gui/${process.getuid()}`;
  const service = `${domain}/${label}`;
  const installed = fs.existsSync(plist);
  let port = defaultPort;
  if (installed && fs.existsSync(state)) {
    port = JSON.parse(fs.readFileSync(state, "utf8")).port;
  }
  let dryRun = false;
  for (let i = 0; i < flags.length; i++) {
    if (cmd === "install" && flags[i] === "--dry-run") dryRun = true;
    else if (cmd === "install" && flags[i] === "--port") port = Number(flags[++i]);
    else throw new Error(`Unknown daemon argument: ${flags[i]}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid daemon port");
  if (!["install", "status", "logs", "restart", "uninstall"].includes(cmd)) {
    throw new Error("Usage: zstack daemon <install [--port 4390] [--dry-run]|status|logs|restart|uninstall>");
  }
  if (cmd === "install" && dryRun) {
    process.stdout.write(plistFor(root, home, log, port));
    return;
  }
  if (cmd === "logs") {
    if (!fs.existsSync(log)) throw new Error("Daemon log does not exist");
    const result = spawnSync("tail", ["-n", "80", log], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("Could not read daemon log");
    return;
  }
  if (process.platform !== "darwin") throw new Error("launchd requires macOS");

  const job = launchctl(["print", service], false);
  const pid = Number(job.stdout?.match(/^\s*pid = (\d+)/m)?.[1]) || null;
  if (cmd === "status") {
    console.log(JSON.stringify({ installed, loaded: job.status === 0, running: pid !== null, pid, port, health: await health(port) }, null, 2));
    return;
  }
  if (cmd === "restart") {
    if (!installed) throw new Error("Daemon is not installed");
    if (job.status === 0) launchctl(["kickstart", "-k", service]);
    else launchctl(["bootstrap", domain, plist]);
    return;
  }
  if (cmd === "uninstall") {
    if (job.status === 0) launchctl(["bootout", service]);
    fs.rmSync(plist, { force: true });
    fs.rmSync(state, { force: true });
    return;
  }

  if (!await portAvailable(port)) {
    const listener = await health(port);
    if (pid === null || listener?.pid !== pid || !listener.launchd?.managed) {
      throw new Error(`127.0.0.1:${port} is already in use by another process`);
    }
  }
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  const previous = installed ? fs.readFileSync(plist) : null;
  const tmp = `${plist}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, plistFor(root, home, log, port), { mode: 0o600, flag: "wx" });
  try {
    if (job.status === 0) launchctl(["bootout", service]);
    fs.renameSync(tmp, plist);
    try {
      launchctl(["bootstrap", domain, plist]);
    } catch (error) {
      if (previous) fs.writeFileSync(plist, previous, { mode: 0o600 });
      else fs.rmSync(plist, { force: true });
      if (previous && job.status === 0) launchctl(["bootstrap", domain, plist], false);
      throw error;
    }
    writeAtomicJson(state, { port });
    console.log(JSON.stringify({ installed: true, port, plist }));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
