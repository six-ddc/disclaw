/**
 * Claude Client - SDK wrapper for querying Claude
 *
 * Uses @anthropic-ai/claude-agent-sdk query() to get an async iterator
 * of SDKMessages, enabling real-time streaming to Discord.
 */

import { query, type SDKMessage, type Query, type SDKResultMessage, type McpServerConfig, type CanUseTool, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MultimodalPrompt } from './attachment-handler.js';
import { createLogger } from './logger.js';

const TIMEZONE = process.env.TZ;

const log = createLogger('claude-client');

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

/** Get current datetime for system prompt injection */
function getDatetimeContext(): string {
    const now = new Date();
    return now.toLocaleString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        ...(TIMEZONE ? { timeZone: TIMEZONE } : {}),
    });
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
    permissionMode?: string;
    onMessage: (message: SDKMessage) => void | Promise<void>;
    onQuery?: (q: Query) => void;
    abortController?: AbortController;
    canUseTool?: CanUseTool;
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
            permissionMode: permModeOverride } = options;

    const cwd = workingDir || process.env.CLAUDE_WORKING_DIR || process.cwd();
    log(`Query started - session: ${sessionId || '(auto)'}, resume: ${resume}, model: ${model || '(default)'}, workingDir: ${cwd}`);
    if (forkSession) log(`Forking session from: ${sessionId}`);
    if (resumeSessionAt) log(`Resuming session at message: ${resumeSessionAt}`);

    const controller = abortController || new AbortController();

    const systemPromptAppend = `Current date/time: ${getDatetimeContext()}`;
    log.debug(`System prompt append: "${systemPromptAppend}"`);

    const disallowedTools: string[] = ['CronCreate', 'CronList', 'CronDelete'];

    // Permission mode: per-thread override > env > default
    const permMode = permModeOverride || process.env.DISCLAW_PERMISSION_MODE || 'default';
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
            session_id: sessionId || crypto.randomUUID(),
        };
        sdkPrompt = (async function*() { yield userMessage; })();
        log.debug(`Prompt type: multimodal blocks (${prompt.blocks.length} content blocks)`);
    }

    const iterator = query({
        prompt: sdkPrompt,
        options: {
            cwd,
            permissionMode: permMode as 'default' | 'bypassPermissions' | 'plan' | 'acceptEdits' | 'dontAsk',
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

    log(`SDK query iteration started`);
    for await (const message of iterator) {
        messageCount++;
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

        await onMessage(message);
    }

    const finalSessionId = resultSessionId || sessionId || '';
    log(`Query completed - ${messageCount} messages processed, final session: ${finalSessionId}`);

    return finalSessionId;
}

/**
 * Generate a short emoji-prefixed title from conversation context.
 * Accepts an array of {role, text} turns. Uses query() with persistSession: false.
 */
export async function generateTitle(context: Array<{ role: string; text: string }>): Promise<string> {
    log(`Title generation started - ${context.length} conversation turns`);
    // Build conversation snippet, truncated to ~2000 chars total
    let totalLen = 0;
    const lines: string[] = [];
    for (const turn of context) {
        const label = turn.role === 'user' ? 'User' : 'Assistant';
        const line = `${label}: ${turn.text}`;
        if (totalLen + line.length > 2000) {
            lines.push(`${label}: ${turn.text.slice(0, 2000 - totalLen)}`);
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
        if (message.type === 'result' && 'result' in message) {
            title = (message as SDKResultMessage & { result?: string }).result || '';
        }
    }

    const trimmed = title.trim();
    log(`Title generated: "${trimmed}"`);
    return trimmed;
}
