# ssh-easy

A simple CLI to manage and quickly connect to your SSH servers. Save once, connect by alias.

Built with [Bun](https://bun.sh) — zero runtime dependencies.

## Install

```bash
# clone and link globally
git clone https://github.com/muneebhashone/ssh-easy.git
cd ssh-easy
bun install
bun link
```

Requires [Bun](https://bun.sh) runtime.

## Usage

```bash
# Add a server (interactive)
ssh-easy add

# Add a server (non-interactive)
ssh-easy add prod --host 10.0.1.50 --user deploy --key ~/.ssh/id_rsa
ssh-easy add dev --host 192.168.1.100 --user root --password s3cret --port 2222

# Connect — just use the alias
ssh-easy prod

# List all saved connections
ssh-easy list

# Edit a connection
ssh-easy edit prod

# Remove a connection
ssh-easy rm dev

# Export all connections (keys + passwords bundled)
ssh-easy export

# Export specific connections to a custom file
ssh-easy export backup.json --aliases prod,dev

# Import on another machine — works out of the box
ssh-easy import backup.json

# Import and overwrite existing connections
ssh-easy import backup.json --overwrite

# Check & install system dependencies
ssh-easy setup
```

## Commands

| Command | Description |
|---------|-------------|
| `ssh-easy <alias>` | Connect to a saved server |
| `ssh-easy add [alias] [flags]` | Add a new connection |
| `ssh-easy list` / `ls` | List all saved connections |
| `ssh-easy edit <alias>` | Edit a saved connection |
| `ssh-easy remove` / `rm <alias>` | Remove a connection |
| `ssh-easy export [file]` | Export connections to a portable file |
| `ssh-easy import <file>` | Import connections from an export file |
| `ssh-easy setup` | Check & install system dependencies |
| `ssh-easy help` | Show help |

## Flags

| Flag | Description |
|------|-------------|
| `--host <ip\|hostname>` | Server host |
| `--user <username>` | SSH username |
| `--port <number>` | Port (default: 22) |
| `--key <path>` | Path to SSH private key |
| `--password [password]` | Use password auth (optionally store password) |
| `--yes`, `-y` | Skip confirmation prompts |
| `--aliases <a,b,c>` | Export only specific connections |
| `--overwrite` | Overwrite existing connections on import |

## Authentication

**Key-based auth** — provide a path to your SSH private key. The CLI validates the key file exists on add.

**Password auth** — passwords are stored base64-encoded in `~/.ssh-easy/connections.json`. On connect, the CLI uses a 3-tier strategy:

1. **SSH_ASKPASS** (primary) — creates a temporary script that feeds the password to SSH automatically. Built into OpenSSH 8.4+ on all platforms. No extra tools needed.
2. **sshpass** (fallback) — used on Linux/macOS if SSH_ASKPASS fails. Install via `ssh-easy setup`.
3. **Manual entry** (last resort) — displays the stored password for you to copy-paste when SSH prompts.

## Cross-Platform Support

Works on **Windows**, **macOS**, and **Linux**.

| Feature | Windows | macOS | Linux |
|---------|---------|-------|-------|
| Key-based SSH | ✓ | ✓ | ✓ |
| Password auto-auth (SSH_ASKPASS) | ✓ | ✓ | ✓ |
| sshpass fallback | — | ✓ | ✓ |
| `ssh-easy setup` | winget/choco/scoop | brew | apt/dnf/yum/pacman |

## Import / Export

Move connections between machines with a single file. Export bundles everything — connection config, SSH private keys, and passwords — into one portable JSON file.

```bash
# On machine A
ssh-easy export backup.json

# Copy backup.json to machine B, then:
ssh-easy import backup.json
```

On import, SSH keys are placed at `~/.ssh/ssh-easy-<alias>` with correct permissions (`600`). Connections work immediately — no extra steps.

> **Warning:** The export file contains sensitive data (private keys, passwords). Store it securely and delete after transfer.

## Config

Connections are stored at `~/.ssh-easy/connections.json`.

```json
{
  "connections": [
    {
      "alias": "prod",
      "host": "10.0.1.50",
      "username": "deploy",
      "port": 22,
      "keyPath": "/home/user/.ssh/id_rsa",
      "authMethod": "key"
    }
  ]
}
```

## License

MIT
