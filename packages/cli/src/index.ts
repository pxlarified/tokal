#!/usr/bin/env node
import { spawnSync, execSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const binaryName = process.platform === "win32" ? "tokscale.exe" : "tokscale";

const currentDir = fileURLToPath(new URL(".", import.meta.url));
const dirName = basename(currentDir);
// In npm install: currentDir = .../node_modules/@tokscale/cli/dist/
//   cliDir = .../node_modules/@tokscale/cli/
//   scopeDir = .../node_modules/@tokscale/
// In monorepo dev (dist): currentDir = .../packages/cli/dist/
//   cliDir = .../packages/cli/
//   scopeDir = .../packages/
// In monorepo dev (src): currentDir = .../packages/cli/src/
//   cliDir = .../packages/cli/
//   scopeDir = .../packages/
const isSubDir = dirName === "dist" || dirName === "src";
const cliDir = isSubDir ? resolve(currentDir, "..") : currentDir;
const scopeDir = resolve(cliDir, "..");
const workspaceRoot = resolve(scopeDir, "..");

type LibcKind = "gnu" | "musl";

function detectLibcKind(): LibcKind {
  const override = process.env.TOKSCALE_LIBC?.trim().toLowerCase();
  if (override === "musl") return "musl";
  if (override === "gnu" || override === "glibc") return "gnu";

  const report = process.report?.getReport?.() as
    | {
        header?: {
          glibcVersionRuntime?: string;
          release?: { sourceUrl?: string };
        };
        sharedObjects?: string[];
      }
    | undefined;

  if (report?.header?.glibcVersionRuntime) {
    return "gnu";
  }

  if (
    Array.isArray(report?.sharedObjects) &&
    report.sharedObjects.some((obj) => obj.toLowerCase().includes("musl"))
  ) {
    return "musl";
  }

  // Bun reports neither glibcVersionRuntime nor sharedObjects, but its
  // release.sourceUrl names the build flavor (e.g. bun-linux-x64-musl-baseline.zip).
  if (report?.header?.release?.sourceUrl?.toLowerCase().includes("musl")) {
    return "musl";
  }

  try {
    const output = execSync("ldd --version", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).toLowerCase();
    if (output.includes("musl")) return "musl";
    if (output.includes("glibc") || output.includes("gnu")) return "gnu";
  } catch (error) {
    // musl's ldd rejects --version: it prints "musl libc" to stderr and
    // exits non-zero, so the answer is in the error, not the output.
    const { stdout, stderr } = (error ?? {}) as { stdout?: unknown; stderr?: unknown };
    const combined = `${stdout ?? ""}\n${stderr ?? ""}`.toLowerCase();
    if (combined.includes("musl")) return "musl";
    if (combined.includes("glibc") || combined.includes("gnu")) return "gnu";
  }

  // ldd missing or inconclusive: look for dynamic loaders. Either loader
  // can coexist with the other's libc (Debian's musl package installs
  // ld-musl-*; Alpine's gcompat installs ld-linux-*), so when both are
  // present, let the distro break the tie.
  const hasGnuLoader = loaderPresent("ld-linux-");
  const hasMuslLoader = loaderPresent("ld-musl-");
  if (hasGnuLoader !== hasMuslLoader) return hasMuslLoader ? "musl" : "gnu";
  if (hasGnuLoader && hasMuslLoader) {
    return existsSync("/etc/alpine-release") ? "musl" : "gnu";
  }

  return "gnu";
}

// Glibc ships ld-linux-*.so.* in /lib64 (or /lib on some arches); musl
// distros (Alpine, Void-musl, ...) ship /lib/ld-musl-<arch>.so.1.
function loaderPresent(prefix: string): boolean {
  for (const dir of ["/lib", "/lib64"]) {
    try {
      if (readdirSync(dir).some((entry) => entry.startsWith(prefix))) {
        return true;
      }
    } catch {
      // Directory unreadable or missing; try the next one.
    }
  }
  return false;
}

function resolveTargetPackageName(): string | null {
  const arch = process.arch;

  if (process.platform === "darwin") {
    if (arch === "arm64") return "cli-darwin-arm64";
    if (arch === "x64") return "cli-darwin-x64";
    return null;
  }

  if (process.platform === "linux") {
    const libc = detectLibcKind();
    if (arch === "arm64") {
      return libc === "musl" ? "cli-linux-arm64-musl" : "cli-linux-arm64-gnu";
    }
    if (arch === "x64") {
      return libc === "musl" ? "cli-linux-x64-musl" : "cli-linux-x64-gnu";
    }
    return null;
  }

  if (process.platform === "win32") {
    if (arch === "arm64") return "cli-win32-arm64-msvc";
    if (arch === "x64") return "cli-win32-x64-msvc";
    return null;
  }

  return null;
}

function resolveRustTargetTriple(): string | null {
  const arch = process.arch;

  if (process.platform === "darwin") {
    if (arch === "arm64") return "aarch64-apple-darwin";
    if (arch === "x64") return "x86_64-apple-darwin";
    return null;
  }

  if (process.platform === "linux") {
    const libc = detectLibcKind();
    if (arch === "arm64") {
      return libc === "musl"
        ? "aarch64-unknown-linux-musl"
        : "aarch64-unknown-linux-gnu";
    }
    if (arch === "x64") {
      return libc === "musl"
        ? "x86_64-unknown-linux-musl"
        : "x86_64-unknown-linux-gnu";
    }
    return null;
  }

  if (process.platform === "win32") {
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
    if (arch === "x64") return "x86_64-pc-windows-msvc";
    return null;
  }

  return null;
}

const targetPackage = resolveTargetPackageName();
const searchPaths: string[] = [];

if (targetPackage) {
  searchPaths.push(
    // npm/bun install: sibling scoped package (node_modules/@tokscale/cli-<platform>/bin/...)
    join(scopeDir, targetPackage, "bin", binaryName),
    // Nested node_modules: non-hoisted / pnpm (node_modules/@tokscale/cli/node_modules/@tokscale/cli-<platform>/bin/...)
    join(cliDir, "node_modules", "@tokscale", targetPackage, "bin", binaryName),
    // Hoisted edge case (node_modules/@tokscale/node_modules/@tokscale/cli-<platform>/bin/...)
    join(scopeDir, "node_modules", "@tokscale", targetPackage, "bin", binaryName),
    join(workspaceRoot, "node_modules", "@tokscale", targetPackage, "bin", binaryName),
    // Monorepo development
    join(workspaceRoot, "packages", targetPackage, "bin", binaryName),
  );
}

const rustTargetTriple = resolveRustTargetTriple();
if (rustTargetTriple) {
  searchPaths.push(join(workspaceRoot, "target", rustTargetTriple, "release", binaryName));
}

searchPaths.push(
  join(workspaceRoot, "target", "release", binaryName),
  join(cliDir, "bin", binaryName),
);

function tryRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// Paths that would re-enter this wrapper if executed - using any of these as
// the "real" binary causes infinite recursion (a fork bomb). We compare by
// realpath so symlinks (e.g. npm/bun bin shims) are dereferenced.
const selfPaths = new Set<string>([
  tryRealpath(fileURLToPath(import.meta.url)),
  tryRealpath(join(cliDir, "bin.js")),
]);
if (process.argv[1]) {
  selfPaths.add(tryRealpath(process.argv[1]));
}

function isSelfReference(p: string): boolean {
  return selfPaths.has(tryRealpath(p));
}

let binary = searchPaths.find((p) => existsSync(p) && !isSelfReference(p));

if (!binary) {
  console.error("Error: tokscale binary not found");
  console.error("Build from source: cargo build --release -p tokscale-cli");
  if (targetPackage) {
    console.error(`Expected optional package: @tokscale/${targetPackage}`);
  }
  process.exit(1);
}

if (process.argv[2] === "web") {
  await runLocalWeb(binary, process.argv.slice(3));
} else {
  const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

function parseWebArgs(args: string[]): {
  graphArgs: string[];
  host: string;
  port: number;
  open: boolean;
} {
  const graphArgs: string[] = [];
  let host = "127.0.0.1";
  let port = 3030;
  let open = true;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--no-open") {
      open = false;
    } else if (arg === "--open") {
      open = true;
    } else if (arg === "--host" && args[i + 1]) {
      host = args[++i];
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
    } else if (arg === "--port" && args[i + 1]) {
      port = Number.parseInt(args[++i], 10);
    } else if (arg.startsWith("--port=")) {
      port = Number.parseInt(arg.slice("--port=".length), 10);
    } else {
      graphArgs.push(arg);
    }
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("Error: --port must be a number between 1 and 65535");
    process.exit(1);
  }

  return { graphArgs, host, port, open };
}

async function runLocalWeb(binaryPath: string, args: string[]): Promise<void> {
  const { graphArgs, host, port, open } = parseWebArgs(args);
  console.error("Scanning local token usage...");
  const graph = spawnSync(binaryPath, ["graph", "--no-spinner", ...graphArgs], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  });

  if (graph.status !== 0) {
    process.exit(graph.status ?? 1);
  }

  let data: unknown;
  try {
    data = JSON.parse(graph.stdout);
  } catch {
    console.error("Error: failed to parse local graph data");
    process.exit(1);
  }

  const frontendDir = findFrontendDir();
  if (frontendDir) {
    const dataDir = mkdtempSync(join(tmpdir(), "tokscale-web-"));
    const dataPath = join(dataDir, "data.json");
    writeFileSync(dataPath, JSON.stringify(data));

    if (!frontendDependenciesInstalled(frontendDir)) {
      const installer = existsSync(join(workspaceRoot, "bun.lock")) && commandExists("bun") ? "bun" : npmCommand();
      const installArgs = installer.startsWith("bun") ? ["install"] : ["install"];
      console.error("Frontend dependencies are missing; installing them now...");
      const install = spawnSync(installer, installArgs, { cwd: workspaceRoot, stdio: "inherit" });
      if (install.status !== 0) process.exit(install.status ?? 1);
    }

    const runner = existsSync(join(workspaceRoot, "bun.lock")) && commandExists("bun") ? "bun" : npmCommand();
    const runnerArgs = ["run", "dev", "--", "--hostname", host, "--port", String(port)];
    console.error("Starting full Tokscale frontend in local-only mode...");
    const child = spawn(runner, runnerArgs, {
      cwd: frontendDir,
      stdio: "inherit",
      env: {
        ...process.env,
        TOKSCALE_LOCAL_DATA_PATH: dataPath,
        NEXT_PUBLIC_TOKSCALE_LOCAL_ONLY: "1",
      },
    });
    child.on("error", (error) => {
      console.error(`Error: failed to start frontend (${runner}): ${error.message}`);
      process.exit(1);
    });

    const url = `http://${host}:${port}/local`;
    console.error(`Tokscale full local web UI starting at ${url}`);
    console.error("Showing your local profile only. No database, account, leaderboard, settings, or upload is used.");
    if (open) setTimeout(() => openBrowser(url), 1500);

    await new Promise<void>((resolve) => {
      child.on("exit", (code) => process.exit(code ?? 0));
      process.once("SIGINT", () => {
        child.kill("SIGINT");
        resolve();
      });
      process.once("SIGTERM", () => {
        child.kill("SIGTERM");
        resolve();
      });
    });
    return;
  }

  const html = renderLocalWebHtml(data);
  const server = createServer((req, res) => {
    const url = req.url?.split("?")[0] ?? "/";
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }
    if (url === "/data.json") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: failed to start local web server: ${message}`);
    process.exit(1);
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;
  console.error(`Tokscale local web UI running at ${url}`);
  console.error("Showing local data only. No database or upload is used.");
  console.error("Press Ctrl+C to stop.");

  if (open) openBrowser(url);
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function frontendDependenciesInstalled(frontendDir: string): boolean {
  return existsSync(join(frontendDir, "node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next")) ||
    existsSync(join(workspaceRoot, "node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next"));
}

function findFrontendDir(): string | null {
  const candidates = [
    join(workspaceRoot, "packages", "frontend"),
    join(cliDir, "frontend"),
    join(cliDir, "..", "frontend"),
  ];

  return candidates.find((candidate) => existsSync(join(candidate, "package.json"))) ?? null;
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function renderLocalWebHtml(data: unknown): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Tokscale Local Profile</title>
<style>
:root { color-scheme: dark; --bg:#05070d; --card:#101522; --muted:#8b98ad; --text:#edf3ff; --accent:#70a5ff; --border:#22304a; }
* { box-sizing: border-box; } body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: radial-gradient(circle at top, #13213c, var(--bg) 42rem); color:var(--text); }
main { width:min(1120px, calc(100% - 32px)); margin:0 auto; padding:48px 0; }
header { display:flex; justify-content:space-between; gap:24px; align-items:flex-start; margin-bottom:28px; }
h1 { margin:0; font-size:clamp(32px, 5vw, 56px); letter-spacing:-0.06em; } p { color:var(--muted); line-height:1.6; }
.badge { border:1px solid var(--border); border-radius:999px; padding:8px 12px; color:var(--muted); background:rgba(16,21,34,.72); white-space:nowrap; }
.grid { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:14px; margin:22px 0; }
.card { border:1px solid var(--border); border-radius:22px; background:rgba(16,21,34,.76); padding:18px; box-shadow:0 20px 80px rgba(0,0,0,.25); }
.metric { color:var(--muted); font-size:13px; } .value { font-size:26px; font-weight:800; margin-top:6px; }
.chart { height:260px; display:flex; align-items:end; gap:3px; padding-top:16px; overflow:hidden; }
.bar { flex:1; min-width:3px; border-radius:5px 5px 0 0; background:linear-gradient(180deg, #8bb8ff, #3b70ff); opacity:.35; }
.bar.active { opacity:1; }
.section { margin-top:14px; } table { width:100%; border-collapse:collapse; } th,td { padding:12px 8px; border-bottom:1px solid var(--border); text-align:left; } th { color:var(--muted); font-weight:600; font-size:13px; }
a { color:var(--accent); } @media (max-width:800px){ header{display:block}.grid{grid-template-columns:repeat(2,1fr)} }
</style>
</head>
<body><main>
<header><div><h1>Your local Tokscale profile</h1><p>Private, local-only web UI generated from your machine's token usage. No database, account, leaderboard, or upload is used.</p></div><div class="badge">Local only</div></header>
<section class="grid" id="metrics"></section>
<section class="card"><div class="metric">Daily usage</div><div class="chart" id="chart"></div></section>
<section class="card section"><div class="metric">Clients</div><table><thead><tr><th>Client</th><th>Tokens</th><th>Cost</th></tr></thead><tbody id="clients"></tbody></table></section>
<p>Raw data: <a href="/data.json">/data.json</a></p>
</main><script>const data=${json};
const fmtInt=n=>new Intl.NumberFormat().format(Math.round(n||0)); const fmtUsd=n=>new Intl.NumberFormat(undefined,{style:'currency',currency:'USD'}).format(n||0);
const s=data.summary||{}; document.getElementById('metrics').innerHTML=[['Total tokens',fmtInt(s.totalTokens)],['Total cost',fmtUsd(s.totalCost)],['Active days',fmtInt(s.activeDays)],['Average / day',fmtInt(s.averagePerDay)]].map(([k,v])=>'<div class="card"><div class="metric">'+k+'</div><div class="value">'+v+'</div></div>').join('');
const days=data.contributions||[]; const max=Math.max(1,...days.map(d=>d.totals?.tokens||0)); document.getElementById('chart').innerHTML=days.slice(-180).map(d=>'<div class="bar '+((d.totals?.tokens||0)>0?'active':'')+'" title="'+d.date+': '+fmtInt(d.totals?.tokens)+' tokens" style="height:'+Math.max(2,((d.totals?.tokens||0)/max)*100)+'%"></div>').join('');
const tokenSum=t=>(t?.input||0)+(t?.output||0)+(t?.cacheRead||0)+(t?.cacheWrite||0)+(t?.reasoning||0); const clients=new Map(); for (const d of days) for (const c of d.clients||[]) { const row=clients.get(c.client)||{tokens:0,cost:0}; row.tokens+=tokenSum(c.tokens); row.cost+=c.cost||0; clients.set(c.client,row); } document.getElementById('clients').innerHTML=[...clients.entries()].sort((a,b)=>b[1].tokens-a[1].tokens).map(([name,row])=>'<tr><td>'+name+'</td><td>'+fmtInt(row.tokens)+'</td><td>'+fmtUsd(row.cost)+'</td></tr>').join('')||'<tr><td colspan="3">No local usage found</td></tr>';
</script></body></html>`;
}
