#!/usr/bin/env bun

import { add, connect, list, edit, remove, setup, help, exportConnections, importConnections } from "./commands";

const args = process.argv.slice(2);
const command = args[0];

function parseFlags(args: string[]): { positionals: string[]; flags: Record<string, string | undefined> } {
  const positionals: string[] = [];
  const flags: Record<string, string | undefined> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "";
      }
    } else if (arg === "-y") {
      flags["yes"] = "";
    } else if (arg === "-p" && args[i + 1]) {
      flags["port"] = args[++i];
    } else if (arg === "-u" && args[i + 1]) {
      flags["user"] = args[++i];
    } else if (arg === "-k" && args[i + 1]) {
      flags["key"] = args[++i];
    } else if (arg === "-h" && args[i + 1] && !args[i + 1].startsWith("-")) {
      flags["host"] = args[++i];
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

async function main() {
  if (!command || command === "help" || command === "--help") {
    help();
    return;
  }

  const { positionals, flags } = parseFlags(args.slice(1));

  switch (command) {
    case "add": {
      const alias = positionals[0];
      await add({ alias, ...flags });
      break;
    }
    case "connect": {
      const alias = positionals[0];
      if (!alias) {
        console.error("Usage: ssh-easy connect <alias>");
        process.exit(1);
      }
      await connect(alias);
      break;
    }
    case "list":
    case "ls":
      await list();
      break;
    case "edit": {
      const alias = positionals[0];
      if (!alias) {
        console.error("Usage: ssh-easy edit <alias>");
        process.exit(1);
      }
      await edit(alias, flags);
      break;
    }
    case "export": {
      const file = positionals[0];
      await exportConnections(file, flags);
      break;
    }
    case "import": {
      const file = positionals[0];
      if (!file) {
        console.error("Usage: ssh-easy import <file>");
        process.exit(1);
      }
      await importConnections(file, flags);
      break;
    }
    case "setup":
      await setup();
      break;
    case "remove":
    case "rm": {
      const alias = positionals[0];
      if (!alias) {
        console.error("Usage: ssh-easy remove <alias>");
        process.exit(1);
      }
      await remove(alias, "yes" in flags);
      break;
    }
    default:
      // Treat unknown command as alias shortcut
      await connect(command);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
