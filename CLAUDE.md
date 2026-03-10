# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Disclaw is a Discord bot that bridges Discord with Claude Code via the Agent SDK, enabling thread-based AI conversations. Architecture: `Discord Gateway → Bot → In-process JobRunner → Claude Agent SDK`. Single-process, no external dependencies beyond Discord. Runs locally with no exposed ports (outbound Discord gateway only).

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

**Request flow:** User @mentions bot in Discord → `bot.ts` creates a thread, generates a session UUID, stores thread→session mapping in SQLite, submits job to `runner.ts` → runner calls `claude-client.ts` which uses `@anthropic-ai/claude-agent-sdk` `query()` to get an async iterator of SDKMessages → messages are converted via `message-converter.ts` and rendered to Discord via `discord-sender.ts`. Follow-up messages in the thread use `resume: sessionId` to continue the session.

**Key source files:**
- `src/bot.ts` — Discord event routing (MessageCreate, interaction dispatch). Resolves working directory via chain: `[/path]` override → channel config → `CLAUDE_WORKING_DIR` env → `process.cwd()`. No command handler logic — delegates to `interactions.ts`
- `src/interactions.ts` — All `/disclaw` slash command handlers (config, clear, interrupt, model, fork, resume, permission) and `validateWorkingDir`. Thread-only commands use `requireThreadSession()` guard
- `src/dir-picker.ts` — Interactive button-based directory browser for Discord (inspired by clawgo's mountdir picker). Navigation: subdirectory buttons (paginated), Up/Prev/Next, Select/Cancel. 2-minute timeout
- `src/runner.ts` — In-process job runner with concurrency control (semaphore), retry with exponential backoff. Tracks active `Query` objects per thread for interrupt support. Caches supported models from SDK. Updates DB session ID on fork
- `src/claude-client.ts` — SDK wrapper; calls `query()` from `@anthropic-ai/claude-agent-sdk` and streams SDKMessages via `onMessage` callback. Supports `model`, `forkSession`, `resumeSessionAt`, `onQuery`, `canUseTool`, `permissionMode` options
- `src/user-input.ts` — Handles SDK `canUseTool` callback via Discord interactive components. Manages AskUserQuestion (buttons/selects/modals for clarifying questions) and tool approval UI (Allow/Deny/Always Allow). Per-thread auto-approved tools via "Always Allow". 5-minute timeout on pending requests
- `src/message-converter.ts` — Transforms raw SDKMessages into normalized `ClaudeMessage` objects (text, tool_use, tool_result, thinking, system, etc.)
- `src/discord-sender.ts` — Renders `ClaudeMessage` objects as Discord embeds/messages with rich formatting (tool previews, syntax highlighting, completion stats)
- `src/history.ts` — Paginated session history viewer. Uses SDK `getSessionMessages()` to fetch conversation, renders as Discord embed with ◀/▶ navigation buttons. Used by fork, resume, and rewind commands
- `src/discord.ts` — Discord REST API helpers (send, edit, typing indicators), markdown splitting with table flattening. Exports `sendRichMessage()`, `editRichMessage()` for embed payloads
- `src/db.ts` — SQLite database for thread→session mappings (with model column) and channel configs. Exports `getThreadMapping()`, `updateThreadSession()`, `updateThreadModel()`
**Slash commands (`/disclaw <subcommand>`):**
- `config [dir]` — Set channel working directory (interactive dir picker if no arg)
- `clear` — Clear conversation context, start fresh (thread-only)
- `interrupt` — Interrupt current Claude processing (thread-only)
- `model` — Switch Claude model via select menu (thread-only)
- `fork` — Fork conversation into a new thread (thread-only)
- `resume` — Resume a previous session via select menu (any location)
- `permission` — Set per-thread permission mode via select menu (thread-only). Modes: default, dontAsk, acceptEdits, bypassPermissions, plan

**Data stores:**
- SQLite (`./data/threads.db`) — thread/session mappings (incl. model, permission_mode), channel configs
- No message content is stored (privacy-first design)

## Runtime & Build

- **Runtime:** Bun (TypeScript executed natively, no build/compile step)
- **Module system:** ESM (`"type": "module"`)
- **TypeScript:** Strict mode with `noUncheckedIndexedAccess` and `noImplicitOverride` enabled; `noEmit: true` (type checking only)
- **Key dependencies:** discord.js, @anthropic-ai/claude-agent-sdk

## Environment Variables

Required: `DISCORD_BOT_TOKEN`. Optional: `CLAUDE_WORKING_DIR`, `DISCLAW_ALLOWED_DIRS` (comma-separated security allowlist), `DB_PATH` (default: `./data/threads.db`), `DISCLAW_PERMISSION_MODE` (default: `default`; options: `default`, `dontAsk`, `acceptEdits`, `bypassPermissions`, `plan`), `TZ`. See `.env.example`.
