/**
 * Claude Client - SDK wrapper for querying Claude
 *
 * Uses @anthropic-ai/claude-agent-sdk query() to get an async iterator
 * of SDKMessages, enabling real-time streaming to Discord.
 */

import { query, type SDKMessage, type Query, type McpServerConfig, type CanUseTool, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MultimodalPrompt } from './attachment-handler.js';
import type { PermissionMode } from './types.js';
import { isValidPermissionMode } from './types.js';
import { createLogger } from './logger.js';

const TIMEZONE = process.env.TZ;

const log = createLogger('claude-client');

/** Thrown when the SDK query stalls (no messages for STALL_TIMEOUT_MS). */
export class StallError extends Error {
    override name = 'StallError';
}

const STALL_TIMEOUT_MS = 5 * 60 * 1000;  // 5 minutes
const STALL_CHECK_INTERVAL_MS = 30 * 1000;  // check every 30s
const STALL_GRACE_MS = 10 * 1000;  // grace period after interrupt before force close

// Lazy pre-flight check: ensure claude binary is available before first query
// SDK query() silently hangs if claude is not in PATH — fail fast instead
import { execSync } from 'child_process';
let claudeVerified = false;
function ensureClaudeBinary(): void {
    if (claudeVerified) return;
    try {
        execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
        claudeVerified = true;
    } catch {
        throw new Error('claude binary not found in PATH. Install Claude Code or fix PATH.');
    }
}

export interface QueryOptions {
    prompt: string | MultimodalPrompt;
    sessionId?: string;
    resume: boolean;
    workingDir?: string;
    model?: string;
    forkSession?: boolean;
    resumeSessionAt?: string;
    mcpServers?: Record<string, McpServerConfig>;
    persistSession?: boolean;
    /** SDK permission mode override (per-thread from DB, falls back to env) */
    permissionMode?: PermissionMode;
    onMessage: (message: SDKMessage) => void | Promise<void>;
    onQuery?: (q: Query) => void;
    abortController?: AbortController;
    canUseTool?: CanUseTool;
    /** Called with a reset function that pauses the watchdog timer (e.g. during canUseTool waits) */
    onWatchdogReset?: (resetFn: () => void) => void;
}

/**
 * Query Claude using the Agent SDK.
 *
 * Iterates over all SDKMessages, calling onMessage for each.
 * Returns the session ID (may differ from input if SDK assigns a new one).
 */
export async function queryClaudeSDK(options: QueryOptions): Promise<string> {
    ensureClaudeBinary();

    const { prompt, sessionId, resume, workingDir, onMessage, onQuery, abortController,
            model, forkSession, resumeSessionAt, mcpServers, persistSession, canUseTool,
            permissionMode: permModeOverride, onWatchdogReset } = options;

    const cwd = workingDir || process.env.CLAUDE_WORKING_DIR || '/tmp/disclaw'; // Final fallback — callers should resolve via working-dir.ts
    log(`Query started - session: ${sessionId || '(auto)'}, resume: ${resume}, model: ${model || '(default)'}, workingDir: ${cwd}`);
    if (forkSession) log(`Forking session from: ${sessionId}`);
    if (resumeSessionAt) log(`Resuming session at message: ${resumeSessionAt}`);

    const controller = abortController || new AbortController();

    const systemPromptAppend = `You are running inside a Discord bot.

Discord tools: discord_send (messages/embeds/files/replies), discord_edit (update bot messages), discord_get/discord_list (read messages), discord_react/discord_unreact (emoji reactions), discord_delete (remove messages), discord_create_thread (new threads), discord_set_title (rename thread, omit title to auto-generate), discord_channels (list server channels), discord_threads (list threads in a channel). All default to the current thread — no ID needed. Send files proactively after generating them.

Cron tools: cron_create / cron_list / cron_update / cron_delete / cron_run_now for scheduled task management.

Discord formatting — use these to create clickable references:
- Channel/thread link: <#channel_id> (e.g. <#123456> renders as #general)
- User mention: <@user_id>
- Role mention: <@&role_id>
- Timestamp: <t:unix_epoch:format> where format is t(short time), T(long time), d(short date), D(long date), f(short datetime), F(long datetime), R(relative, e.g. "2 hours ago")
- Message link: https://discord.com/channels/guild_id/channel_id/message_id (renders as a preview card)
- Hyperlink in embeds: [text](url)
Prefer these over plain IDs whenever referencing channels, users, or times in your messages.`;
    log.debug(`System prompt append: "${systemPromptAppend}"`);

    const disallowedTools: string[] = ['CronCreate', 'CronList', 'CronDelete'];

    // Permission mode: per-thread override > env > default
    const envMode = process.env.DISCLAW_PERMISSION_MODE;
    const permMode: PermissionMode = permModeOverride
        || (envMode && isValidPermissionMode(envMode) ? envMode : undefined)
        || 'default';
    const useBypass = permMode === 'bypassPermissions';
    log.debug(`Permission mode: ${permMode} (override: ${permModeOverride || 'none'}, env: ${process.env.DISCLAW_PERMISSION_MODE || 'none'}, bypass: ${useBypass})`);

    // Build the prompt for the SDK
    let sdkPrompt: string | AsyncIterable<SDKUserMessage>;
    if (typeof prompt === 'string') {
        sdkPrompt = prompt;
        log.debug(`Prompt type: plain text (${prompt.length} chars)`);
    } else if (prompt.type === 'text') {
        sdkPrompt = prompt.text;
        log.debug(`Prompt type: multimodal text (${prompt.text.length} chars)`);
    } else {
        // Multimodal: wrap content blocks into an SDKUserMessage async iterable
        const userMessage: SDKUserMessage = {
            type: 'user',
            message: { role: 'user', content: prompt.blocks },
            parent_tool_use_id: null,
            session_id: sessionId || '',
        };
        sdkPrompt = (async function*() { yield userMessage; })();
        log.debug(`Prompt type: multimodal blocks (${prompt.blocks.length} content blocks)`);
    }

    const iterator = query({
        prompt: sdkPrompt,
        options: {
            cwd,
            permissionMode: permMode,
            ...(useBypass ? { allowDangerouslySkipPermissions: true } : {}),
            ...(canUseTool ? { canUseTool } : {}),
            stderr: (data: string) => log(`[stderr] ${data}`),
            systemPrompt: {
                type: 'preset',
                preset: 'claude_code',
                append: systemPromptAppend,
            },
            ...(resume ? { resume: sessionId } : sessionId ? { sessionId } : {}),
            ...(model ? { model } : {}),
            ...(forkSession ? { forkSession: true } : {}),
            ...(resumeSessionAt ? { resumeSessionAt } : {}),
            ...(mcpServers ? { mcpServers } : {}),
            ...(persistSession === false ? { persistSession: false } : {}),
            disallowedTools,
            settingSources: ['user', 'project', 'local'],
            abortController: controller,
            env: {
                ...process.env as Record<string, string>,
                ...(TIMEZONE ? { TZ: TIMEZONE } : {}),
                IS_SANDBOX: '1',
            },
        },
    });

    log.debug(`SDK options: persistSession=${persistSession}, canUseTool=${!!canUseTool}, mcpServers=${mcpServers ? Object.keys(mcpServers).join(',') : 'none'}, disallowedTools=${disallowedTools.join(',')}`);

    if (onQuery) onQuery(iterator);

    let resultSessionId: string | undefined;
    let messageCount = 0;
    let stallDetected = false;
    let interruptedByStall = false;  // stays true once stall triggers interrupt
    let lastResultSuccess = false;

    // --- Watchdog: detect stalled SDK queries ---
    let lastMessageTime = Date.now();
    const resetWatchdog = () => { lastMessageTime = Date.now(); };
    if (onWatchdogReset) onWatchdogReset(resetWatchdog);

    const watchdogInterval = setInterval(async () => {
        const elapsed = Date.now() - lastMessageTime;
        if (elapsed < STALL_TIMEOUT_MS) return;

        stallDetected = true;
        interruptedByStall = true;
        log.warn(`SDK stall detected after ${Math.round(elapsed / 1000)}s with no messages (${messageCount} total)`);

        if (persistSession === false) {
            // Ephemeral session (e.g. cron) — force kill immediately
            log.warn(`Ephemeral session — force closing stalled query`);
            iterator.close();
        } else {
            // Persistent session — try graceful interrupt first
            log.warn(`Persistent session — attempting interrupt`);
            try {
                await iterator.interrupt();
                // Wait grace period, then force close if still stuck
                setTimeout(() => {
                    if (stallDetected) {
                        log.warn(`Interrupt grace period expired — force closing`);
                        iterator.close();
                    }
                }, STALL_GRACE_MS);
            } catch (err) {
                log.error(`Interrupt failed during stall recovery: ${err} — force closing`);
                iterator.close();
            }
        }
    }, STALL_CHECK_INTERVAL_MS);

    try {
        log(`SDK query iteration started`);
        for await (const message of iterator) {
            messageCount++;
            lastMessageTime = Date.now();

            // If we get a message after interrupt, the stall resolved
            if (stallDetected) {
                log(`Stall resolved — received message after interrupt`);
                stallDetected = false;
            }

            if (controller.signal.aborted) {
                log(`Abort signal detected after ${messageCount} messages, stopping iteration`);
                break;
            }

            // Track session ID from any message that carries it
            if ('session_id' in message && message.session_id) {
                if (resultSessionId && resultSessionId !== message.session_id) {
                    log(`Session ID changed: ${resultSessionId} → ${message.session_id}`);
                } else if (!resultSessionId) {
                    log(`Session ID assigned by SDK: ${message.session_id}`);
                }
                resultSessionId = message.session_id;
            }

            log.debug(`Message #${messageCount}: type=${message.type}${'subtype' in message ? `, subtype=${(message as any).subtype}` : ''}`);

            // Track successful completion for stall recovery decision
            if (message.type === 'result' && 'subtype' in message && (message as any).subtype === 'success') {
                lastResultSuccess = true;
            }

            await onMessage(message);
        }
    } finally {
        clearInterval(watchdogInterval);
    }

    // Once a stall triggered interrupt, always throw unless it completed successfully
    if (stallDetected || (interruptedByStall && !lastResultSuccess)) {
        throw new StallError(`SDK query stalled after ${messageCount} messages (no activity for ${STALL_TIMEOUT_MS / 1000}s)`);
    }

    const finalSessionId = resultSessionId || sessionId || '';
    log(`Query completed - ${messageCount} messages processed, final session: ${finalSessionId}`);

    return finalSessionId;
}

/**
 * Generate a short emoji-prefixed title from conversation context.
 * Accepts an array of {role, text} turns. Uses query() with persistSession: false.
 */
export async function generateTitle(sessionId: string, workingDir?: string): Promise<string> {
    log(`Title generation started - session=${sessionId}`);

    // Fetch full conversation from SDK session
    const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
    const rawMessages = await getSessionMessages(sessionId, { dir: workingDir });
    const typedMessages = rawMessages as Array<{ type: string; message: { role?: string; content?: unknown } }>;

    // Extract user/assistant text turns, truncated to ~2000 chars total
    let totalLen = 0;
    const lines: string[] = [];
    for (const msg of typedMessages) {
        if (msg.type !== 'user' && msg.type !== 'assistant') continue;
        const content = msg.message?.content;
        let text = '';
        if (typeof content === 'string') {
            text = content;
        } else if (Array.isArray(content)) {
            text = (content as Array<{ type?: string; text?: string }>)
                .filter(b => b.type === 'text')
                .map(b => b.text || '')
                .join('');
        }
        if (!text.trim()) continue;
        const label = msg.type === 'user' ? 'User' : 'Assistant';
        const line = `${label}: ${text}`;
        if (totalLen + line.length > 2000) {
            lines.push(`${label}: ${text.slice(0, 2000 - totalLen)}`);
            break;
        }
        lines.push(line);
        totalLen += line.length + 1;
    }

    const prompt = [
        'Generate a short title (max 8 words) for this conversation.',
        'The title MUST start with a single emoji that best represents the topic.',
        'Output ONLY the title, nothing else.',
        '',
        ...lines,
    ].join('\n');

    let title = '';
    const iterator = query({
        prompt,
        options: {
            maxTurns: 1,
            persistSession: false,
            systemPrompt: 'You are a title generator. Output only the title.',
            permissionMode: 'dontAsk',
            settingSources: ['user'],
            env: {
                ...process.env as Record<string, string>,
                IS_SANDBOX: '1',
            },
            stderr: (data: string) => log(`[title-stderr] ${data}`),
        },
    });

    for await (const message of iterator) {
        log.debug(`Title generation message: type=${message.type}`);
        if (message.type === 'result' && message.subtype === 'success') {
            title = message.result || '';
        }
    }

    const trimmed = title.trim();
    log(`Title generated: "${trimmed}"`);
    return trimmed;
}
