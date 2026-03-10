# SDK vs CLI: Slash Command Capability Comparison

How Claude Code CLI slash commands map to the Agent SDK API.

## Must Implement Ourselves

These commands have no SDK equivalent — we build them entirely in Disclaw.

| CLI Command | Disclaw Implementation |
|---|---|
| `/clear` | Generate new `sessionId`, update DB mapping |
| `/compact` | Not planned (SDK handles context internally) |
| `/vim` | N/A (not applicable to Discord) |

## SDK Provides API, We Build the Interaction Layer

The SDK exposes methods on the `Query` object or standalone functions, but we handle the Discord UX (slash commands, select menus, ephemeral replies).

| CLI Command | SDK API | Disclaw Implementation |
|---|---|---|
| `/model` | `query.setModel(model)` / `Options.model` | `/disclaw model name:<model>` — store in DB, pass to next query |
| `/resume` | `listSessions()` + `Options.resume` | `/disclaw resume` — show select menu, update/create thread |
| `/interrupt` | `query.interrupt()` | `/disclaw interrupt` — call on active Query object |
| `/fork` | `Options.forkSession` + `Options.resume` | `/disclaw fork` — create new thread with forked session |

## SDK Handles Completely

These are handled internally by the SDK or irrelevant in the bot context.

| CLI Command | Notes |
|---|---|
| `/help` | SDK internal |
| `/config` | We use `Options` at query time |
| `/cost` | Available in result messages |
| `/login`, `/logout` | API key auth, not applicable |
| `/permissions` | We use `bypassPermissions` mode |
| `/mcp` | Configured via SDK options |
| `/memory` | SDK reads CLAUDE.md automatically |

## SDK-Only Capabilities (No CLI Equivalent)

| Capability | API |
|---|---|
| `query.supportedModels()` | List available models |
| `query.supportedCommands()` | List slash commands |
| `query.accountInfo()` | Get account/usage info |
| `query.rewindFiles(messageId)` | Revert file changes to a specific message |
| `query.setMaxThinkingTokens(n)` | Control thinking budget |
| `query.mcpServerStatus()` | Check MCP server health |
| `query.streamInput(stream)` | Stream multi-turn input |
