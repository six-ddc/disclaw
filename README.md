# Disclaw

A Discord harness for Claude Code. Thread-based AI conversations with rich interactions, scheduled tasks, and session management.

## How It Works

@mention the bot in any channel — it creates a thread, spawns a Claude Code session via the [Agent SDK](https://github.com/anthropics/claude-agent-sdk), and streams responses back as Discord messages with rich formatting. Follow-up messages in the thread continue the same session. Everything runs in a single process with no exposed ports — outbound Discord gateway only.

## Features

### Thread-Based Conversations
- Each @mention starts a new thread with its own Claude Code session
- Follow-up messages in the thread resume the same session automatically
- AI-generated thread titles (emoji-prefixed) based on conversation content
- Channel status messages show response previews without opening threads
- Multimodal input: images (PNG/JPEG/GIF/WebP), PDFs, text file attachments, and reply references are sent to Claude as content blocks

### Rich Message Rendering
- Claude's text output renders as full Discord markdown (code blocks, lists, etc.)
- Tool calls displayed as colored embeds with input preview and result
- Thinking blocks shown in purple embeds
- Long messages split intelligently at markdown boundaries (preserving code fences)
- Markdown tables auto-converted to card-style layout (Discord has no table rendering)
- Completion stats: model name, context usage %, response time
- Session change notifications: "New session", "Forked session", "Resumed session" embeds with model and working directory

### Slash Commands (`/disclaw`)
| Command | Description |
|---------|-------------|
| `cd` | Change working directory (channel default or thread override) |
| `clear` | Clear context and start a fresh session |
| `interrupt` | Stop the current Claude processing |
| `model` | Switch Claude model |
| `fork` | Fork conversation into a new thread |
| `resume` | Resume a previous session |
| `cron` | List all scheduled tasks |
| `permission` | Set permission mode (default, dontAsk, acceptEdits, bypassPermissions, plan) |

### Scheduled Tasks (Cron)
Claude can create recurring tasks that run on a cron schedule. Each task gets its own dedicated thread with a control panel:

- **Create** — Ask Claude to "run X every morning at 9am" and it creates a cron job via MCP tools
- **Control panel** — Each task thread has buttons: Pause/Resume, Run Now, Verbose toggle, Delete
- **Auto-pause** — Jobs auto-pause after 3 consecutive failures
- **Timezone-aware** — Schedules respect the configured `TZ` environment variable

### Session Management
- **Fork** — Branch a conversation into a new thread while preserving full context
- **Resume** — Pick any previous session from a list and continue it (in current thread or a new one)
- **History** — Paginated conversation viewer with navigation buttons (used by fork/resume)
- **Clear** — Reset context in the current thread to start fresh

### Working Directory
Each conversation runs Claude Code in a specific directory. Resolution chain:

1. **Per-message override**: `@bot [~/projects/foo] what files are here?`
2. **Thread config**: `/disclaw cd` in a thread sets a thread-level override (clears session for fresh start)
3. **Channel config**: `/disclaw cd` in a channel sets the default for all new threads
4. **Environment variable**: `CLAUDE_WORKING_DIR`
5. **Fallback**: `process.cwd()`

For multi-user deployments, set `DISCLAW_ALLOWED_DIRS` to restrict accessible directories:
```bash
DISCLAW_ALLOWED_DIRS=/home/projects,/var/code
```

## Setup

### Prerequisites

- [Bun](https://bun.sh) runtime
- [Claude Code CLI](https://claude.ai/code) installed and authenticated
- Discord bot token

### Discord Bot

1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application
2. **Bot** tab → enable **Message Content Intent**
3. Copy the bot token → set as `DISCORD_BOT_TOKEN`
4. **OAuth2 → URL Generator**: scope `bot`, permissions: Send Messages, Create Public Threads, Send Messages in Threads, Read Message History, Add Reactions
5. Invite to your server

### Install & Run

```bash
git clone https://github.com/six-ddc/disclaw.git
cd disclaw
bun install
cp .env.example .env     # edit .env, fill in DISCORD_BOT_TOKEN
bun run start
```

Development with hot reload:
```bash
bun run dev
```

## Architecture

```
Discord Gateway → Bot (bot.ts)
                    ├── Slash commands → interactions.ts
                    ├── @mentions / thread messages → runner.ts
                    │     └── claude-client.ts (Agent SDK query())
                    │           ├── message-converter.ts → ClaudeMessage[]
                    │           └── discord-sender.ts → Discord embeds
                    ├── Cron scheduler → cron.ts (croner)
                    │     └── MCP server (cron_create, cron_list, cron_delete, cron_update, title_generate)
                    └── SQLite (db.ts) — thread/session mappings, channel configs, cron jobs
```

Single process. No Redis, no queue, no HTTP server. The runner uses an async semaphore for concurrency control (default: 2 concurrent jobs) with retry and exponential backoff.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | — | Discord bot token |
| `CLAUDE_WORKING_DIR` | No | `cwd` | Default working directory for Claude |
| `DISCLAW_ALLOWED_DIRS` | No | — | Comma-separated directory allowlist |
| `DB_PATH` | No | `./data/threads.db` | SQLite database path |
| `DISCLAW_PERMISSION_MODE` | No | `default` | Default permission mode (`default`, `dontAsk`, `acceptEdits`, `bypassPermissions`, `plan`) |
| `TZ` | No | system | Timezone for cron schedules and datetime display |

## Privacy

Only thread-to-session mappings, channel configs, and cron job definitions are stored in SQLite. No message content, user data, or conversation history is persisted.

## License

MIT
