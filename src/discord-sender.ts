/**
 * Discord Sender - Renders ClaudeMessage objects as Discord embeds
 *
 * Converts normalized ClaudeMessage objects into rich Discord embeds.
 * Tool embed construction is delegated to the shared tool-embeds module.
 */

import type { ClaudeMessage } from './message-converter.js';
import { sendEmbed as _sendEmbed, editEmbed, sendToThread, sendRichMessage, deleteMessage, scheduleDelete, truncateCodePoints, type EmbedData } from './discord.js';
import {
    escapeCodeBlock, formatToolName, truncateContent, cleanContent,
    buildToolUseEmbed, buildToolResultField,
} from './tool-embeds.js';
import { PERMISSION_MODES, DISPLAY_MODES } from './types.js';
import { createLogger } from './logger.js';

const log = createLogger('discord-sender');

/** Send embed with SUPPRESS_NOTIFICATIONS by default (all non-text messages are quiet) */
const sendEmbed = (threadId: string, embeds: EmbedData[]) => _sendEmbed(threadId, embeds, true);

/** Tools whose tool_use and tool_result are silently suppressed (content already sent to Discord) */
const SILENT_TOOLS = new Set([
    'mcp__disclaw__discord_send',
    'mcp__disclaw__discord_edit',
    'mcp__disclaw__discord_create_thread',
    'mcp__disclaw__discord_set_title',
]);

/** Safely access a key from a loosely-typed metadata bag (only for SystemMessage.metadata) */
function meta<T>(m: Record<string, unknown>, key: string, fallback: T): T {
    if (!(key in m)) return fallback;
    return m[key] as T;
}

/** Split text into chunks respecting a max length */
function splitText(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let current = '';

    for (const codePoint of text) {
        if ((current + codePoint).length > maxLength) {
            if (current) {
                chunks.push(current);
            }
            current = codePoint;
        } else {
            current += codePoint;
        }
    }

    if (current) {
        chunks.push(current);
    }

    return chunks;
}

/** Format stop_reason for display */
function formatStopReason(stopReason?: string, sdkSubtype?: string): string | null {
    if (sdkSubtype && sdkSubtype !== 'success') {
        const subtypeMap: Record<string, string> = {
            'error_max_turns': '🔄 Hit turn limit',
            'error_budget': '💰 Budget exceeded',
            'error_tool': '🔧 Tool error',
            'error_streaming': '📡 Streaming error',
        };
        if (subtypeMap[sdkSubtype]) return subtypeMap[sdkSubtype];
    }

    if (!stopReason) return null;

    const reasonMap: Record<string, string> = {
        'end_turn': 'Completed',
        'max_tokens': '⚠️ Hit token limit',
        'refusal': '🚫 Request declined',
        'stop_sequence': '⏹️ Stop sequence',
        'tool_use': '🔧 Tool use',
    };

    return reasonMap[stopReason] ?? null;
}

/**
 * Create a sender function bound to a specific thread.
 *
 * Returns an async function that converts ClaudeMessage[] into Discord embeds
 * and sends them to the given thread.
 */
// Track last status message per thread for delete-on-replace + auto-delete
const lastStatusMessage = new Map<string, { messageId: string; timer: ReturnType<typeof setTimeout> }>();

function scheduleStatusDelete(threadId: string, messageId: string) {
    // Delete previous status message immediately when a new one replaces it
    const prev = lastStatusMessage.get(threadId);
    if (prev) {
        clearTimeout(prev.timer);
        deleteMessage(threadId, prev.messageId).catch(() => {});
    }
    // Auto-delete after 10s, with cancellable timer for replace-on-arrival
    const timer = setTimeout(() => {
        lastStatusMessage.delete(threadId);
        scheduleDelete(threadId, messageId, 0);
    }, 10_000);
    lastStatusMessage.set(threadId, { messageId, timer });
}

export function createClaudeSender(threadId: string) {
    // Map toolUseId → { discordMessageId, embeds } for correlating tool_result with tool_use
    const toolUseMessages = new Map<string, { messageId: string; embeds: EmbedData[] }>();
    // Track toolUseIds from silent tools so their tool_results are also suppressed
    const silentToolUseIds = new Set<string>();
    log.debug(`Created Claude sender for thread=${threadId}`);

    return async function sendClaudeMessages(messages: ClaudeMessage[]): Promise<void> {
        log.debug(`Processing ${messages.length} message(s) for thread=${threadId}`);
        for (const msg of messages) {
            try {
            // TypeScript narrows `msg` in each case branch via the discriminated union
            switch (msg.type) {
                case 'text': {
                    log.debug(`Sending text message to thread=${threadId} contentLength=${msg.content.length}`);
                    await sendToThread(threadId, msg.content);
                    log(`Sent text message to thread=${threadId} contentLength=${msg.content.length}`);
                    break;
                }

                case 'tool_use': {
                    const { name: toolName, input: toolInput, toolUseId } = msg;
                    const displayName = formatToolName(toolName);
                    log.debug(`Processing tool_use thread=${threadId} tool=${displayName} toolUseId=${toolUseId}`);

                    // Suppress tools that already send content directly to Discord
                    if (SILENT_TOOLS.has(toolName)) {
                        if (toolUseId) silentToolUseIds.add(toolUseId);
                        log.debug(`Suppressed silent tool_use: ${toolName} toolUseId=${toolUseId}`);
                        break;
                    }

                    const embed = buildToolUseEmbed(toolName, toolInput);
                    const embeds = [embed];
                    const discordMsgId = await sendEmbed(threadId, embeds);
                    log(`Sent tool_use embed thread=${threadId} tool=${displayName} toolUseId=${toolUseId} discordMsgId=${discordMsgId}`);

                    if (toolUseId) {
                        toolUseMessages.set(toolUseId, { messageId: discordMsgId, embeds });
                        log.debug(`Tracking tool_use for result correlation thread=${threadId} toolUseId=${toolUseId} trackedCount=${toolUseMessages.size}`);
                    }
                    break;
                }

                case 'tool_result': {
                    const { toolUseId } = msg;

                    // Suppress results from silent tools
                    if (toolUseId && silentToolUseIds.has(toolUseId)) {
                        silentToolUseIds.delete(toolUseId);
                        log.debug(`Suppressed silent tool_result: toolUseId=${toolUseId}`);
                        break;
                    }

                    // Filter out system reminder content
                    const cleaned = cleanContent(msg.content);

                    const tracked = toolUseId ? toolUseMessages.get(toolUseId) : undefined;
                    log.debug(`Processing tool_result thread=${threadId} toolUseId=${toolUseId} hasTracked=${!!tracked} contentLength=${cleaned.length}`);

                    if (tracked) {
                        // Merge result into the original tool_use embed
                        toolUseMessages.delete(toolUseId!);
                        const embed = tracked.embeds[0]!;
                        const result = buildToolResultField(cleaned);
                        const fields = embed.fields ?? [];
                        fields.push(result.field);
                        await editEmbed(threadId, tracked.messageId, [{ ...embed, fields, color: result.color }]);
                        log(`Updated tool_use embed with result thread=${threadId} toolUseId=${toolUseId} messageId=${tracked.messageId}`);
                    } else if (cleaned) {
                        // Fallback: no matching tool_use found, send as separate message
                        log.warn(`No matching tool_use found for tool_result, sending as separate embed thread=${threadId} toolUseId=${toolUseId} contentLength=${cleaned.length}`);
                        const result = buildToolResultField(cleaned);
                        await sendEmbed(threadId, [{
                            color: result.color,
                            title: result.field.name,
                            description: result.field.value,
                        }]);
                        log(`Sent standalone tool_result embed thread=${threadId}`);
                    }
                    break;
                }

                case 'thinking': {
                    const chunks = splitText(msg.content, 4000);
                    log.debug(`Sending thinking embed thread=${threadId} contentLength=${msg.content.length} chunks=${chunks.length}`);
                    for (let i = 0; i < chunks.length; i++) {
                        await sendEmbed(threadId, [{
                            color: 0x9b59b6,
                            title: chunks.length > 1 ? `💭 Thinking (${i + 1}/${chunks.length})` : '💭 Thinking',
                            description: chunks[i]!,
                        }]);
                    }
                    log(`Sent thinking embed thread=${threadId} chunks=${chunks.length}`);
                    break;
                }

                case 'system': {
                    // SystemMessage keeps a general metadata bag for subtype-polymorphic fields
                    const { subtype, metadata } = msg;
                    log.debug(`Processing system message thread=${threadId} subtype=${subtype}`);

                    if (subtype === 'new_session') {
                        const label = meta<string>(metadata, 'label', 'New session');
                        const parts: string[] = [];
                        const model = meta<string>(metadata, 'model', '');
                        if (model) parts.push(model);
                        const cwd = meta<string>(metadata, 'cwd', '');
                        if (cwd) parts.push(`\`${cwd}\``);
                        const permMode = meta<string>(metadata, 'permissionMode', '');
                        const permLabel = PERMISSION_MODES.find(m => m.value === permMode)?.label;
                        if (permLabel) parts.push(permLabel);
                        const dispMode = meta<string>(metadata, 'displayMode', '');
                        const dispLabel = DISPLAY_MODES.find(m => m.value === dispMode)?.label;
                        if (dispLabel) parts.push(dispLabel);
                        const sessionMsgId = await sendEmbed(threadId, [{
                            color: 0x57f287,
                            description: `**${label}** · ${parts.join(' · ')}`,
                        }]);
                        scheduleStatusDelete(threadId, sessionMsgId);
                        log(`Sent new_session embed thread=${threadId} label=${label} model=${model} cwd=${cwd}`);
                        break;
                    }

                    if (subtype === 'completion') {
                        const parts: string[] = [];
                        interface UsageInfo { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; contextWindow: number }
                        const modelUsage = meta<Record<string, UsageInfo> | undefined>(metadata, 'modelUsage', undefined);
                        const modelName = meta<string>(metadata, 'model', '')
                            || (modelUsage && Object.keys(modelUsage)[0]);
                        if (modelName) parts.push(modelName);

                        if (modelUsage) {
                            const usage = Object.values(modelUsage)[0];
                            if (usage && usage.contextWindow > 0) {
                                const inputTokens = (usage.inputTokens || 0)
                                    + (usage.cacheReadInputTokens || 0)
                                    + (usage.cacheCreationInputTokens || 0);
                                if (inputTokens > 0) {
                                    const pct = Math.min(100, Math.round(inputTokens / usage.contextWindow * 100));
                                    parts.push(`ctx ${pct}%`);
                                }
                            }
                        }

                        const durationMs = meta<number | undefined>(metadata, 'duration_ms', undefined);
                        if (durationMs !== undefined) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
                        const stopReasonDisplay = formatStopReason(
                            meta<string | undefined>(metadata, 'stop_reason', undefined),
                            meta<string | undefined>(metadata, 'sdkSubtype', undefined),
                        );
                        if (stopReasonDisplay && stopReasonDisplay !== 'Completed') parts.push(stopReasonDisplay);

                        const statusMsgId = await sendRichMessage(threadId, `-# ${parts.join(' · ')}`, true);
                        scheduleStatusDelete(threadId, statusMsgId);
                        log(`Sent completion stats thread=${threadId} model=${modelName} durationMs=${durationMs} stopReason=${stopReasonDisplay}`);
                    }
                    // Skip other generic system messages silently
                    break;
                }

                case 'other': {
                    log.debug(`Skipping other message type thread=${threadId} contentLength=${msg.content.length}`);
                    break;
                }

                case 'permission_denied': {
                    const { toolName, toolInput } = msg;
                    const inputPreview = JSON.stringify(toolInput, null, 2);
                    const { preview } = truncateContent(inputPreview, 6, 500);
                    log.warn(`Permission denied for tool thread=${threadId} tool=${toolName}`);

                    await sendEmbed(threadId, [{
                        color: 0xff4444,
                        title: `🚫 Permission Denied: \`${formatToolName(toolName)}\``,
                        description: 'This tool was blocked by the current permission mode (`dontAsk`). The bot denies tools that aren\'t pre-approved.',
                        fields: [
                            { name: 'Tool', value: `\`${toolName}\``, inline: true },
                            { name: 'Input Preview', value: `\`\`\`json\n${escapeCodeBlock(preview)}\n\`\`\``, inline: false }
                        ],
                        footer: { text: 'Change operation mode with /settings → Mode Settings to allow more tools' },
                    }]);
                    log(`Sent permission_denied embed thread=${threadId} tool=${toolName}`);
                    break;
                }

                case 'task_started': {
                    const { taskType, prompt } = msg;
                    const description = msg.content || 'Starting subagent task...';
                    log.debug(`Processing task_started thread=${threadId} taskType=${taskType}`);

                    const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
                    if (taskType) fields.push({ name: 'Type', value: `\`${taskType}\``, inline: true });
                    if (prompt) {
                        const { preview } = truncateContent(prompt, 6, 600);
                        fields.push({ name: 'Prompt', value: `\`\`\`\n${escapeCodeBlock(preview)}\n\`\`\``, inline: false });
                    }

                    await sendEmbed(threadId, [{
                        color: 0x5865f2,
                        title: '🚀 Subagent Started',
                        description,
                        fields,
                    }]);
                    log(`Sent task_started embed thread=${threadId} taskType=${taskType}`);
                    break;
                }

                case 'task_notification': {
                    const { status, summary, usage } = msg;
                    const description = summary || msg.content || 'No summary';
                    const statusEmoji = status === 'completed' ? '✅' : status === 'failed' ? '❌' : '⏹️';
                    const statusColor = status === 'completed' ? 0x00ff00 : status === 'failed' ? 0xff0000 : 0xffaa00;

                    const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
                    if (usage) {
                        if (usage.duration_ms) fields.push({ name: 'Duration', value: `${(usage.duration_ms / 1000).toFixed(1)}s`, inline: true });
                        if (usage.tool_uses) fields.push({ name: 'Tool Calls', value: `${usage.tool_uses}`, inline: true });
                        if (usage.total_tokens) fields.push({ name: 'Tokens', value: `${usage.total_tokens.toLocaleString()}`, inline: true });
                    }

                    await sendEmbed(threadId, [{
                        color: statusColor,
                        title: `${statusEmoji} Subagent ${status.charAt(0).toUpperCase() + status.slice(1)}`,
                        description: truncateCodePoints(description, 4000),
                        fields,
                    }]);
                    log(`Sent task_notification embed thread=${threadId} status=${status}`);
                    break;
                }

                case 'task_progress': {
                    const { summary, lastToolName, usage } = msg;
                    const description = summary || msg.content;

                    const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
                    if (lastToolName) fields.push({ name: 'Last Tool', value: `\`${formatToolName(lastToolName)}\``, inline: true });
                    if (usage) {
                        if (usage.duration_ms) fields.push({ name: 'Elapsed', value: `${(usage.duration_ms / 1000).toFixed(1)}s`, inline: true });
                        if (usage.tool_uses) fields.push({ name: 'Tool Calls', value: `${usage.tool_uses}`, inline: true });
                    }

                    const statusMsgId = await sendEmbed(threadId, [{
                        color: 0x888888,
                        title: '⏳ Subagent Progress',
                        description: description ? truncateCodePoints(description, 2000) : undefined,
                        fields,
                    }]);
                    scheduleStatusDelete(threadId, statusMsgId);
                    log(`Sent task_progress embed thread=${threadId}`);
                    break;
                }

                case 'tool_progress': {
                    const { elapsedSeconds, toolName } = msg;
                    if (elapsedSeconds >= 5) {
                        log.debug(`Sending tool_progress embed thread=${threadId} tool=${toolName} elapsed=${elapsedSeconds.toFixed(1)}s`);
                        const statusMsgId = await sendEmbed(threadId, [{
                            color: 0x888888,
                            title: `⏳ \`${formatToolName(toolName)}\` running...`,
                            description: `Elapsed: ${elapsedSeconds.toFixed(1)}s`,
                        }]);
                        scheduleStatusDelete(threadId, statusMsgId);
                    }
                    break;
                }

                case 'tool_summary': {
                    if (msg.content) {
                        log.debug(`Sending tool_summary embed thread=${threadId} contentLength=${msg.content.length}`);
                        await sendEmbed(threadId, [{
                            color: 0x00ccff,
                            title: '📋 Tool Summary',
                            description: truncateCodePoints(msg.content, 4000),
                        }]);
                        log(`Sent tool_summary embed thread=${threadId} contentLength=${msg.content.length}`);
                    }
                    break;
                }
            }
            } catch (err) {
                const preview = msg.content?.slice(0, 80) || '';
                log.error(`Failed to send ${msg.type} to thread=${threadId}: ${err} | preview: ${preview}`);
            }
        }
    };
}
