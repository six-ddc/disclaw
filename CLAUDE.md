# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Disclaw is a Discord bot that bridges Discord with Claude Code via the Agent SDK, enabling thread-based AI conversations with multimodal support. Architecture: `Discord Gateway → Bot → In-process JobRunner → Claude Agent SDK`. Single-process, no external dependencies beyond Discord. Runs locally with no exposed ports (outbound Discord gateway only).

## Development Commands

```bash
# Install dependencies
bun install

# Start
bun run start

# Development with hot reload
bun run dev

# Type checking (no emit - Bun runs TS natively)
bunx tsc --noEmit
```

There are no tests or linting configured.

## Architecture

**Request flow:** User @mentions bot in Discord → `bot.ts` creates a thread, stores thread→session mapping in SQLite (session ID empty), submits job to `runner.ts` → runner calls `claude-client.ts` which uses `@anthropic-ai/claude-agent-sdk` `query()` to get an async iterator of SDKMessages → SDK auto-generates session ID, saved to DB on init message → messages are converted via `message-converter.ts` and rendered to Discord via `discord-sender.ts`. Follow-up messages in the thread use `resume: sessionId` to continue the session.

**Session ID lifecycle:** The bot never generates session UUIDs — the SDK auto-generates them. On each query, the SDK sends an init message (`type: 'system', subtype: 'init'`) containing `session_id`. The runner compares this with the stored ID; if different (new session), it saves the SDK ID to DB and sends a "New session" / "Forked session" notification embed. Ephemeral sessions (`persistSession: false`, e.g. cron) skip this.

**Working directory resolution (fallback chain):** `[/path]` message prefix override → `mapping.working_dir` (thread-level) → channel config → `CLAUDE_WORKING_DIR` env → `process.cwd()`. Thread-level override is set via `/disclaw cd` in a thread, which also clears the session (new directory = fresh session).

**Key source files:**
- `src/bot.ts` — Discord event routing (MessageCreate, interaction dispatch). No command handler logic — delegates to `interactions.ts`
- `src/interactions.ts` — All `/disclaw` slash command handlers and `validateWorkingDir`. Thread-only commands use `requireThreadSession()` guard
- `src/dir-picker.ts` — Interactive button-based directory browser for Discord. Navigation: subdirectory buttons (paginated), Up/Prev/Next, Select/Cancel. 2-minute timeout
- `src/runner.ts` — In-process job runner with concurrency control (semaphore), per-thread job serialization, retry with exponential backoff. Tracks active `Query` objects per thread for interrupt support. Detects session changes from SDK init messages
- `src/claude-client.ts` — SDK wrapper; calls `query()` and streams SDKMessages via `onMessage` callback. Supports `model`, `forkSession`, `resumeSessionAt`, `canUseTool`, `permissionMode`, `persistSession` options
- `src/user-input.ts` — Handles SDK `canUseTool` callback via Discord interactive components. Manages AskUserQuestion (buttons/selects/modals) and tool approval UI (Allow/Deny/Always Allow). Per-thread auto-approved tools. 5-minute timeout
- `src/attachment-handler.ts` — Multimodal content extraction: images (PNG/JPEG/GIF/WebP, max 20MB, max 5), PDFs (max 20MB), text files (max 100KB), and reply references. Converts Discord attachments to Claude API content blocks
- `src/message-converter.ts` — Transforms raw SDKMessages into normalized `ClaudeMessage` objects (text, tool_use, tool_result, thinking, system, permission_denied, task_started, task_notification, tool_progress, tool_summary)
- `src/discord-sender.ts` — Renders `ClaudeMessage` objects as Discord embeds/messages with rich formatting (tool previews, syntax highlighting, completion stats, session change notifications)
- `src/history.ts` — Paginated session history viewer. Uses SDK `getSessionMessages()`, renders as Discord embed with ◀/▶ navigation buttons. Used by fork, resume, and rewind
- `src/discord.ts` — Discord REST API helpers (send, edit, typing indicators), markdown splitting with table flattening
- `src/db.ts` — SQLite database for thread→session mappings, channel configs, and cron jobs. Thread mappings include: session_id, working_dir, model, fork_from, permission_mode, title
- `src/cron.ts` — Scheduled task system: `CronScheduler` class managing job lifecycle (register, pause, resume, delete, runNow). Auto-pauses after 3 consecutive failures. Exposes SDK MCP server with tools: `cron_create`, `cron_list`, `cron_delete`, `cron_update`, `title_generate`
- `src/cron-buttons.ts` — Cron control panel UI: persistent Discord buttons for Pause/Resume, Run Now, Verbose toggle, Delete

**Slash commands (`/disclaw <subcommand>`):**
- `cd` — Set working directory (channel default or thread override; interactive dir picker)
- `clear` — Clear conversation context, start fresh (thread-only)
- `interrupt` — Interrupt current Claude processing (thread-only)
- `model` — Switch Claude model via select menu (thread-only)
- `fork` — Fork conversation into a new thread (thread-only)
- `resume` — Resume a previous session via select menu (any location)
- `cron` — List all scheduled tasks (any location)
- `permission` — Set per-thread permission mode via select menu (thread-only). Modes: default, dontAsk, acceptEdits, bypassPermissions, plan

**Data stores:**
- SQLite (`./data/threads.db`) — thread/session mappings (incl. working_dir, model, permission_mode), channel configs, cron_jobs
- No message content is stored (privacy-first design)

## Runtime & Build

- **Runtime:** Bun (TypeScript executed natively, no build/compile step)
- **Module system:** ESM (`"type": "module"`)
- **TypeScript:** Strict mode with `noUncheckedIndexedAccess` and `noImplicitOverride` enabled; `noEmit: true` (type checking only)
- **Key dependencies:** discord.js, @anthropic-ai/claude-agent-sdk, croner (cron scheduling)

## Logging

Uses `pino` (`src/logger.ts`). Output goes to both console and `logs/YYYY-MM-DD.log` (JSON). discord.js has built-in rate limit retry — do not add custom retry wrappers on top.

## Environment Variables

Required: `DISCORD_BOT_TOKEN`. Optional: `CLAUDE_WORKING_DIR`, `DISCLAW_ALLOWED_DIRS` (comma-separated security allowlist), `DB_PATH` (default: `./data/threads.db`), `DISCLAW_PERMISSION_MODE` (default: `default`; options: `default`, `dontAsk`, `acceptEdits`, `bypassPermissions`, `plan`), `TZ`. See `.env.example`.
