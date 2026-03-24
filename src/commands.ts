import { homedir, tmpdir } from "node:os";
import { join, basename } from "node:path";
import { chmod, unlink, mkdir } from "node:fs/promises";
import {
  loadConfig,
  saveConfig,
  findConnection,
  encodePassword,
  decodePassword,
} from "./config";
import type { Connection, ExportedConnection, ExportFile } from "./types";

const isWindows = process.platform === "win32";

function resolveTilde(filepath: string): string {
  return filepath.replace(/^~(?=[/\\]|$)/, homedir());
}

async function prompt(question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` [${defaultVal}]` : "";
  process.stdout.write(`${question}${suffix}: `);
  for await (const line of console) {
    return line.trim() || defaultVal || "";
  }
  return defaultVal || "";
}

async function hasSshpass(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["sshpass", "-V"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

function buildSshFlags(conn: Connection): string[] {
  const flags: string[] = [];

  if (conn.authMethod === "key" && conn.keyPath) {
    flags.push("-i", conn.keyPath);
  }

  if (conn.authMethod === "password") {
    flags.push(
      "-o", "PreferredAuthentications=password",
      "-o", "PubkeyAuthentication=no"
    );
  }

  flags.push("-p", String(conn.port), `${conn.username}@${conn.host}`);
  return flags;
}

async function createAskpassScript(password: string): Promise<string> {
  const id = Math.random().toString(36).slice(2, 10);

  if (isWindows) {
    const scriptPath = join(tmpdir(), `ssh-easy-askpass-${id}.bat`);
    // Use delayed expansion to avoid issues with special characters in passwords
    await Bun.write(scriptPath, `@echo off\r\necho ${password}\r\n`);
    return scriptPath;
  }

  const scriptPath = join(tmpdir(), `ssh-easy-askpass-${id}.sh`);
  // Single-quote the password and escape any embedded single quotes
  const escaped = password.replace(/'/g, "'\\''");
  await Bun.write(scriptPath, `#!/bin/sh\necho '${escaped}'\n`);
  await chmod(scriptPath, 0o700);
  return scriptPath;
}

async function cleanupAskpass(scriptPath: string): Promise<void> {
  try {
    await unlink(scriptPath);
  } catch {
    // ignore — temp file cleanup is best-effort
  }
}

function spawnSsh(args: string[], env?: Record<string, string | undefined>) {
  return Bun.spawn(args, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: env as Record<string, string>,
  });
}

export async function add(args: Record<string, string | undefined>) {
  const config = await loadConfig();

  const alias =
    args.alias || (await prompt("Alias (e.g. prod, dev, myserver)"));
  if (!alias) {
    console.error("Error: alias is required");
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(alias)) {
    console.error("Error: alias must be alphanumeric (hyphens/underscores ok)");
    process.exit(1);
  }
  if (config.connections.some((c) => c.alias.toLowerCase() === alias.toLowerCase())) {
    console.error(`Error: alias "${alias}" already exists. Use 'edit' to modify.`);
    process.exit(1);
  }

  const host = args.host || (await prompt("Host (IP or hostname)"));
  if (!host) {
    console.error("Error: host is required");
    process.exit(1);
  }

  const username = args.user || (await prompt("Username"));
  if (!username) {
    console.error("Error: username is required");
    process.exit(1);
  }

  const isNonInteractive = args.host && args.user && (args.key || args.password !== undefined);
  const portStr = args.port || (isNonInteractive ? "22" : await prompt("Port", "22"));
  const port = parseInt(portStr || "22", 10);

  let authMethod: "key" | "password";
  let keyPath: string | undefined;
  let password: string | undefined;

  if (args.key) {
    authMethod = "key";
    keyPath = args.key;
  } else if (args.password !== undefined) {
    authMethod = "password";
    password = args.password || undefined;
  } else {
    const auth = await prompt("Auth method (key/password)", "key");
    authMethod = auth === "password" ? "password" : "key";

    if (authMethod === "key") {
      keyPath = await prompt("SSH key path", "~/.ssh/id_rsa");
    } else {
      const pw = await prompt("Password (leave empty to prompt each time)");
      password = pw || undefined;
    }
  }

  if (keyPath) {
    keyPath = resolveTilde(keyPath);
    if (!(await Bun.file(keyPath).exists())) {
      console.warn(`Warning: key file not found at ${keyPath}`);
    }
  }

  const connection: Connection = {
    alias,
    host,
    username,
    port,
    authMethod,
    ...(keyPath && { keyPath }),
    ...(password && { password: encodePassword(password) }),
  };

  config.connections.push(connection);
  await saveConfig(config);
  console.log(`\nAdded "${alias}" → ${username}@${host}:${port}`);
}

export async function connect(alias: string) {
  const conn = await findConnection(alias);
  if (!conn) {
    console.error(`Error: no connection found for alias "${alias}"`);
    process.exit(1);
  }

  const sshFlags = buildSshFlags(conn);

  console.log(`Connecting to ${conn.alias} (${conn.username}@${conn.host}:${conn.port})...\n`);

  // Key auth or password auth without stored password — straightforward SSH
  if (conn.authMethod === "key" || !conn.password) {
    const proc = spawnSsh(["ssh", ...sshFlags]);
    process.exit(await proc.exited);
  }

  // Password auth with stored password — try layered approach
  const password = decodePassword(conn.password);
  const askpassPath = await createAskpassScript(password);

  try {
    // Tier 1: SSH_ASKPASS (cross-platform, built into OpenSSH 8.4+)
    const proc = spawnSsh(["ssh", ...sshFlags], {
      ...process.env,
      SSH_ASKPASS: askpassPath,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: process.env.DISPLAY || ":0",
    });
    const exitCode = await proc.exited;

    // Exit code 0 = success, exit code 255 with password auth likely means auth failure
    if (exitCode === 0) process.exit(0);

    // Tier 2: sshpass fallback (Linux/macOS)
    if (!isWindows && await hasSshpass()) {
      console.log("SSH_ASKPASS failed, trying sshpass...\n");
      const proc2 = spawnSsh(["sshpass", "-p", password, "ssh", ...sshFlags]);
      process.exit(await proc2.exited);
    }

    // Tier 3: display password for manual entry
    console.log("Auto-auth failed. Retrying — copy the password below when prompted.");
    console.log(`Password: ${password}\n`);
    const proc3 = spawnSsh(["ssh", ...sshFlags]);
    process.exit(await proc3.exited);
  } finally {
    await cleanupAskpass(askpassPath);
  }
}

export async function list() {
  const config = await loadConfig();

  if (config.connections.length === 0) {
    console.log("No connections saved. Use 'ssh-easy add' to add one.");
    return;
  }

  const header = { alias: "ALIAS", host: "HOST", port: "PORT", user: "USER", auth: "AUTH" };
  const rows = config.connections.map((c) => ({
    alias: c.alias,
    host: c.host,
    port: String(c.port),
    user: c.username,
    auth: c.authMethod === "key" ? `key${c.keyPath ? ` (${c.keyPath})` : ""}` : "password",
  }));

  const all = [header, ...rows];
  const widths = {
    alias: Math.max(...all.map((r) => r.alias.length)),
    host: Math.max(...all.map((r) => r.host.length)),
    port: Math.max(...all.map((r) => r.port.length)),
    user: Math.max(...all.map((r) => r.user.length)),
    auth: Math.max(...all.map((r) => r.auth.length)),
  };

  const fmt = (r: typeof header) =>
    `  ${r.alias.padEnd(widths.alias)}  ${r.host.padEnd(widths.host)}  ${r.port.padEnd(widths.port)}  ${r.user.padEnd(widths.user)}  ${r.auth}`;

  console.log(fmt(header));
  console.log(`  ${"─".repeat(widths.alias)}  ${"─".repeat(widths.host)}  ${"─".repeat(widths.port)}  ${"─".repeat(widths.user)}  ${"─".repeat(widths.auth)}`);
  rows.forEach((r) => console.log(fmt(r)));
}

export async function edit(alias: string, args: Record<string, string | undefined>) {
  const config = await loadConfig();
  const idx = config.connections.findIndex(
    (c) => c.alias.toLowerCase() === alias.toLowerCase()
  );

  if (idx === -1) {
    console.error(`Error: no connection found for alias "${alias}"`);
    process.exit(1);
  }

  const conn = config.connections[idx];
  console.log(`Editing "${conn.alias}" — press Enter to keep current value.\n`);

  conn.host = args.host || (await prompt("Host", conn.host));
  conn.username = args.user || (await prompt("Username", conn.username));
  const portStr = args.port || (await prompt("Port", String(conn.port)));
  conn.port = parseInt(portStr, 10);

  const auth = await prompt("Auth method (key/password)", conn.authMethod);
  conn.authMethod = auth === "password" ? "password" : "key";

  if (conn.authMethod === "key") {
    conn.keyPath = args.key || (await prompt("SSH key path", conn.keyPath || "~/.ssh/id_rsa"));
    conn.keyPath = resolveTilde(conn.keyPath!);
    delete conn.password;
  } else {
    const pw = await prompt("Password (leave empty to prompt each time)", conn.password ? "****" : "");
    if (pw && pw !== "****") {
      conn.password = encodePassword(pw);
    } else if (!pw) {
      delete conn.password;
    }
    delete conn.keyPath;
  }

  config.connections[idx] = conn;
  await saveConfig(config);
  console.log(`\nUpdated "${conn.alias}" → ${conn.username}@${conn.host}:${conn.port}`);
}

export async function remove(alias: string, skipConfirm: boolean) {
  const config = await loadConfig();
  const idx = config.connections.findIndex(
    (c) => c.alias.toLowerCase() === alias.toLowerCase()
  );

  if (idx === -1) {
    console.error(`Error: no connection found for alias "${alias}"`);
    process.exit(1);
  }

  if (!skipConfirm) {
    const conn = config.connections[idx];
    const answer = await prompt(
      `Remove "${conn.alias}" (${conn.username}@${conn.host})? (y/N)`,
      "N"
    );
    if (answer.toLowerCase() !== "y") {
      console.log("Cancelled.");
      return;
    }
  }

  const removed = config.connections.splice(idx, 1)[0];
  await saveConfig(config);
  console.log(`Removed "${removed.alias}".`);
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const proc = Bun.spawn([which, cmd], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

async function runInstall(args: string[]): Promise<boolean> {
  console.log(`  Running: ${args.join(" ")}\n`);
  const proc = Bun.spawn(args, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  return code === 0;
}

type PkgManager = "apt" | "dnf" | "yum" | "pacman" | "brew" | "winget" | "choco" | "scoop" | null;

async function detectPkgManager(): Promise<PkgManager> {
  const platform = process.platform;

  if (platform === "darwin") {
    if (await commandExists("brew")) return "brew";
    return null;
  }

  if (platform === "win32") {
    if (await commandExists("winget")) return "winget";
    if (await commandExists("choco")) return "choco";
    if (await commandExists("scoop")) return "scoop";
    return null;
  }

  // Linux — check common package managers
  if (await commandExists("apt")) return "apt";
  if (await commandExists("dnf")) return "dnf";
  if (await commandExists("yum")) return "yum";
  if (await commandExists("pacman")) return "pacman";
  return null;
}

function sshInstallCmd(pm: PkgManager): string[] | null {
  switch (pm) {
    case "apt":    return ["sudo", "apt", "install", "-y", "openssh-client"];
    case "dnf":    return ["sudo", "dnf", "install", "-y", "openssh-clients"];
    case "yum":    return ["sudo", "yum", "install", "-y", "openssh-clients"];
    case "pacman": return ["sudo", "pacman", "-S", "--noconfirm", "openssh"];
    case "brew":   return ["brew", "install", "openssh"];
    case "winget": return ["winget", "install", "--id", "Microsoft.OpenSSH.Beta", "--accept-source-agreements"];
    case "choco":  return ["choco", "install", "openssh", "-y"];
    case "scoop":  return ["scoop", "install", "openssh"];
    default:       return null;
  }
}

function sshpassInstallCmd(pm: PkgManager): string[] | null {
  switch (pm) {
    case "apt":    return ["sudo", "apt", "install", "-y", "sshpass"];
    case "dnf":    return ["sudo", "dnf", "install", "-y", "sshpass"];
    case "yum":    return ["sudo", "yum", "install", "-y", "sshpass"];
    case "pacman": return ["sudo", "pacman", "-S", "--noconfirm", "sshpass"];
    case "brew":   return ["brew", "install", "hudochenkov/sshpass/sshpass"];
    default:       return null; // not available on Windows package managers
  }
}

export async function setup() {
  const platform = process.platform;
  const osName = platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : "Linux";
  console.log(`\nssh-easy setup (${osName})\n`);

  // Check dependencies
  const hasSsh = await commandExists("ssh");
  const hasSshpassBin = await commandExists("sshpass");
  const hasBun = await commandExists("bun");

  console.log("Checking dependencies:\n");
  console.log(`  bun      ${hasBun ? "OK" : "MISSING (but you're running this, so something is off)"}`);
  console.log(`  ssh      ${hasSsh ? "OK" : "MISSING"}`);
  console.log(`  sshpass  ${hasSshpassBin ? "OK" : "NOT FOUND (optional — SSH_ASKPASS is used as primary method)"}`);

  if (hasSsh) {
    console.log("\n  ssh-easy uses SSH_ASKPASS for automated password auth (built into OpenSSH 8.4+).");
    console.log("  sshpass is only needed as a fallback on older systems.\n");
    if (hasSshpassBin) {
      console.log("All dependencies are installed. You're good to go!\n");
    } else {
      console.log("You're good to go! sshpass is optional.\n");
    }
    return;
  }

  // Detect package manager
  const pm = await detectPkgManager();

  if (!pm) {
    console.log("\nCould not detect a package manager.");
    console.log("Please install missing dependencies manually:");
    if (!hasSsh) console.log("  - openssh client (ssh)");
    if (!hasSshpassBin) console.log("  - sshpass (for automated password auth)");
    console.log();
    return;
  }

  console.log(`\nDetected package manager: ${pm}\n`);

  // Install ssh if missing
  if (!hasSsh) {
    const cmd = sshInstallCmd(pm);
    if (cmd) {
      const answer = await prompt("Install OpenSSH client? (Y/n)", "Y");
      if (answer.toLowerCase() !== "n") {
        const ok = await runInstall(cmd);
        if (ok) {
          console.log("  ssh installed successfully.\n");
        } else {
          console.error("  Failed to install ssh. Please install manually.\n");
        }
      }
    } else {
      console.log("  No install command available for ssh. Please install manually.\n");
    }
  }

  // Install sshpass if missing
  if (!hasSshpassBin) {
    const cmd = sshpassInstallCmd(pm);
    if (cmd) {
      const answer = await prompt("Install sshpass? (enables auto password auth) (Y/n)", "Y");
      if (answer.toLowerCase() !== "n") {
        const ok = await runInstall(cmd);
        if (ok) {
          console.log("  sshpass installed successfully.\n");
        } else {
          console.error("  Failed to install sshpass. Please install manually.\n");
        }
      }
    } else {
      console.log("  sshpass is not available via " + pm + " on " + osName + ".");
      console.log("  Password auth will still work — ssh-easy will display the stored");
      console.log("  password for you to copy when SSH prompts for it.\n");
    }
  }

  // Final status
  const sshNow = await commandExists("ssh");
  const sshpassNow = await commandExists("sshpass");
  console.log("Final status:\n");
  console.log(`  ssh      ${sshNow ? "OK" : "MISSING"}`);
  console.log(`  sshpass  ${sshpassNow ? "OK" : "NOT INSTALLED (password fallback will be used)"}`);
  console.log();
}

export async function exportConnections(file: string | undefined, flags: Record<string, string | undefined>) {
  const config = await loadConfig();

  if (config.connections.length === 0) {
    console.error("No connections to export.");
    process.exit(1);
  }

  let connections = config.connections;

  if (flags.aliases) {
    const requested = flags.aliases.split(",").map((a) => a.trim().toLowerCase());
    connections = connections.filter((c) => requested.includes(c.alias.toLowerCase()));
    const found = connections.map((c) => c.alias.toLowerCase());
    const missing = requested.filter((a) => !found.includes(a));
    if (missing.length > 0) {
      console.error(`Error: alias(es) not found: ${missing.join(", ")}`);
      process.exit(1);
    }
  }

  const exported: ExportedConnection[] = [];

  for (const conn of connections) {
    const entry: ExportedConnection = {
      alias: conn.alias,
      host: conn.host,
      username: conn.username,
      port: conn.port,
      authMethod: conn.authMethod,
    };

    if (conn.password) {
      entry.password = conn.password;
    }

    if (conn.authMethod === "key" && conn.keyPath) {
      const keyFile = Bun.file(conn.keyPath);
      if (await keyFile.exists()) {
        const content = await keyFile.arrayBuffer();
        entry.keyContent = Buffer.from(content).toString("base64");
        entry.keyFilename = basename(conn.keyPath);
      } else {
        console.warn(`Warning: key file not found at ${conn.keyPath} for "${conn.alias}" — exporting without key content`);
      }
    }

    exported.push(entry);
  }

  const exportData: ExportFile = {
    version: 1,
    exportedAt: new Date().toISOString(),
    connections: exported,
  };

  const outPath = file || "ssh-easy-export.json";
  await Bun.write(outPath, JSON.stringify(exportData, null, 2));

  console.log(`\nExported ${exported.length} connection(s) to ${outPath}`);
  console.log("\nWARNING: This file contains sensitive data (private keys, passwords).");
  console.log("Store it securely and delete after use.\n");
}

export async function importConnections(file: string, flags: Record<string, string | undefined>) {
  let data: ExportFile;
  try {
    data = await Bun.file(file).json();
  } catch {
    console.error(`Error: could not read or parse "${file}"`);
    process.exit(1);
  }

  if (data.version !== 1) {
    console.error(`Error: unsupported export version (got ${data.version}, expected 1)`);
    process.exit(1);
  }

  if (!data.connections || data.connections.length === 0) {
    console.error("Error: no connections found in export file.");
    process.exit(1);
  }

  const config = await loadConfig();
  const overwrite = "overwrite" in flags;
  const sshDir = join(homedir(), ".ssh");
  await mkdir(sshDir, { recursive: true });

  let imported = 0;
  let skipped = 0;

  for (const entry of data.connections) {
    const existingIdx = config.connections.findIndex(
      (c) => c.alias.toLowerCase() === entry.alias.toLowerCase()
    );

    if (existingIdx !== -1) {
      if (!overwrite) {
        console.warn(`Skipping "${entry.alias}" — alias already exists (use --overwrite to replace)`);
        skipped++;
        continue;
      }
      config.connections.splice(existingIdx, 1);
    }

    const conn: Connection = {
      alias: entry.alias,
      host: entry.host,
      username: entry.username,
      port: entry.port,
      authMethod: entry.authMethod,
    };

    if (entry.password) {
      conn.password = entry.password;
    }

    if (entry.keyContent) {
      const keyDest = join(sshDir, `ssh-easy-${entry.alias}`);
      const keyBytes = Buffer.from(entry.keyContent, "base64");
      await Bun.write(keyDest, keyBytes);
      if (!isWindows) {
        await chmod(keyDest, 0o600);
      }
      conn.keyPath = keyDest;
    }

    config.connections.push(conn);
    imported++;
  }

  await saveConfig(config);

  console.log(`\nImported ${imported} connection(s).`);
  if (skipped > 0) {
    console.log(`Skipped ${skipped} connection(s) (already exist).`);
  }
  if (imported > 0) {
    console.log("SSH keys placed in ~/.ssh/\n");
  }
}

export function help() {
  console.log(`
ssh-easy — Simple SSH connection manager

Usage:
  ssh-easy <alias>              Connect to a saved server
  ssh-easy add                  Add a new connection (interactive)
  ssh-easy add <alias> [flags]  Add a new connection (non-interactive)
  ssh-easy list | ls            List all saved connections
  ssh-easy edit <alias>         Edit a saved connection
  ssh-easy remove | rm <alias>  Remove a saved connection
  ssh-easy export [file]        Export connections to a portable file
  ssh-easy import <file>        Import connections from an export file
  ssh-easy setup                Check & install system dependencies
  ssh-easy help                 Show this help

Flags (for add/edit):
  --host <ip|hostname>    Server host
  --user <username>       SSH username
  --port <number>         Port (default: 22)
  --key <path>            Path to SSH private key
  --password [password]   Use password auth (optionally provide password)
  --yes, -y               Skip confirmation (for remove)

Flags (for export/import):
  --aliases <a,b,c>       Export only specific connections
  --overwrite             Overwrite existing connections on import

Examples:
  ssh-easy add prod --host 10.0.1.50 --user deploy --key ~/.ssh/id_rsa
  ssh-easy add dev --host 192.168.1.100 --user root --password s3cret
  ssh-easy prod
  ssh-easy list
  ssh-easy rm dev
  ssh-easy export
  ssh-easy export backup.json --aliases prod,dev
  ssh-easy import backup.json
  ssh-easy import backup.json --overwrite
`);
}
