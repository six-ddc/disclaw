# Disclaw

**Best AI Agent + Most Agent-Friendly Platform**

[Claude Code](https://claude.ai/code) is the most capable AI agent. [Discord](https://discord.com) is the most agent-friendly communication platform — its threads, buttons, embeds, modals, reactions, and slash commands map naturally to how AI agents work: multi-turn sessions, tool approvals, structured output, and multimodal input. Disclaw fuses them into one seamless experience.

## Discord x Agent: Deep Integration Highlights

> Every Discord-native feature below solves a real agent interaction problem that plain text interfaces can't.

- **Thread = Session** — Each @mention creates a thread that *is* the agent session — isolated workspace, persistent state, concurrent conversations. No session IDs, no context mixing.

- **Forum = Agent** — A Discord forum channel becomes an agent template. The post title and body are injected as the agent's instructions on every new session — create a "Code Review" forum, write your requirements in a post, and get a specialized agent. One forum, one persona.

- **One-Click Tool Approval** — Agent permission requests become Discord buttons (Allow / Deny / Always Allow) with tool name and input preview. Human-in-the-loop with zero friction.

- **Pager Mode** — Long multi-step agent runs (tool calls, thinking, text) collapse into a single navigable embed with page buttons. Thread stays clean; browse details on demand.

- **Multimodal Drag-and-Drop** — Images, PDFs, code files — drop them into Discord, automatically extracted and sent to Claude as content blocks. Reply-quote a message and its content (including images) is included too. No format conversion needed.

- **Visual Directory Picker** — Button-based filesystem browser with pagination and navigation. Select working directories visually without typing paths.

- **Cron Control Panel** — Scheduled tasks get dedicated threads with persistent control buttons (Pause / Resume / Run Now / Delete). Results stream into the thread. Auto-pauses on repeated failures.

- **Fork & Resume** — Branch any conversation into a new thread or resume a previous session from a dropdown menu. Paginated history viewer shows context before you commit.

- **Plan Review** — In `plan` mode, Claude's implementation plan renders as a structured embed with approval buttons: Accept Edits, Manual Approval, or Keep Planning (with feedback modal).

- **Interactive Q&A** — Claude's multi-step questions render as button choices or select menus with progress indicators, back/forward navigation, and Submit All. Feels Discord-native.

- **Rich Tool Embeds** — Each tool type (Edit, Bash, Write, Agent...) gets its own color and specialized format. Edits show red/green diffs. Results merge into the original embed. Tool noise stays silent.

- **Reaction UI Restore** — React to any old pager message to restore its navigation buttons — works across bot restarts, backed by SDK session data, not in-memory state.

- **Smart Rendering** — Markdown tables auto-flatten to card layout (Discord has no table support). Long text splits at code fence boundaries. Unicode-safe truncation.

## How It Works

@mention the bot in any channel — it creates a thread, spawns a Claude Code session via the [Agent SDK](https://github.com/anthropics/claude-agent-sdk), and streams responses back as Discord messages with rich formatting. Follow-up messages in the thread continue the same session. Everything runs in a single process with no exposed ports — outbound Discord gateway only.

## Features

### Slash Commands (`/disclaw`)
| Command | Description |
|---------|-------------|
| `cd` | Change working directory (channel default or thread override) |
| `clear` | Clear context and start a fresh session |
| `interrupt` | Stop the current Claude processing |
| `config` | Configure model, permission mode, and display mode via modal |
| `fork` | Fork conversation into a new thread |
| `resume` | Resume a previous session |
| `cron` | List all scheduled tasks |

### Display Modes
Configurable per-thread via `/disclaw config`:
- `verbose` — All tool calls shown as rich embeds in real-time
- `simple` — Only final text replies, tool calls and thinking hidden
- `pager` — Tool calls collected in a single navigable embed with page buttons

### Discord MCP Tools
Claude has full Discord API access via 16 built-in MCP tools:
- **Messages** — `discord_send` (text/embeds/files/replies, auto-split), `discord_edit`, `discord_get`, `discord_list`
- **Threads** — `discord_create_thread`, `discord_set_title` (manual or AI-generated)
- **Reactions** — `discord_react`, `discord_unreact`
- **Management** — `discord_delete`, `discord_channels`, `discord_threads`
- **Cron** — `cron_create`, `cron_list`, `cron_update`, `cron_delete`, `cron_run_now`

Files validated against extension whitelist and 25MB Discord size limit. All tools default to the current thread.

### Working Directory
Resolution chain (highest priority first):

1. **Per-message override**: `@bot [~/projects/foo] what files are here?`
2. **Thread config**: `/disclaw cd` in a thread (clears session)
3. **Channel config**: `/disclaw cd` in a channel (default for new threads)
4. **Environment variable**: `CLAUDE_WORKING_DIR`
5. **Fallback**: `~/.disclaw`

Multi-user deployments: set `DISCLAW_ALLOWED_DIRS` to restrict accessible directories.

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
                    ├── MCP server → mcp-server.ts (16 tools)
                    │     ├── Cron tools (cron_create, cron_list, cron_delete, cron_update, cron_run_now)
                    │     └── Discord tools (discord_send, discord_edit, discord_get, discord_list,
                    │           discord_create_thread, discord_set_title, discord_react,
                    │           discord_unreact, discord_delete, discord_channels, discord_threads)
                    └── SQLite (db.ts) — thread/session mappings, channel configs, cron jobs, pager messages
```

Single process. No Redis, no queue, no HTTP server. The runner uses an async semaphore for concurrency control (default: 10 concurrent jobs) with per-thread serialization, retry and exponential backoff.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | — | Discord bot token |
| `CLAUDE_WORKING_DIR` | No | `~/.disclaw` | Default working directory for Claude |
| `DISCLAW_ALLOWED_DIRS` | No | — | Comma-separated directory allowlist |
| `LOG_DIR` | No | `~/.local/state/disclaw/logs` | Log directory (XDG) |
| `DISCLAW_PERMISSION_MODE` | No | `default` | Default permission mode (`default`, `dontAsk`, `acceptEdits`, `bypassPermissions`, `plan`) |
| `SHOW_LINK_PREVIEWS` | No | — | Show URL embeds in bot messages |
| `TZ` | No | system | Timezone for cron schedules and datetime display |

## Privacy

Only thread-to-session mappings, channel configs, and cron job definitions are stored in SQLite. No message content, user data, or conversation history is persisted.

## License

MIT
