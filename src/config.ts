import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { Config, Connection } from "./types";

const CONFIG_DIR = join(homedir(), ".ssh-easy");
const CONFIG_PATH = join(CONFIG_DIR, "connections.json");

export function encodePassword(plain: string): string {
  return Buffer.from(plain).toString("base64");
}

export function decodePassword(encoded: string): string {
  return Buffer.from(encoded, "base64").toString("utf-8");
}

export async function loadConfig(): Promise<Config> {
  try {
    return await Bun.file(CONFIG_PATH).json();
  } catch {
    return { connections: [] };
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export async function findConnection(alias: string): Promise<Connection | undefined> {
  const config = await loadConfig();
  return config.connections.find(
    (c) => c.alias.toLowerCase() === alias.toLowerCase()
  );
}
