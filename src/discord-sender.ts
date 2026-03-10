/**
 * Discord Sender - Renders ClaudeMessage objects as Discord embeds
 *
 * Converts normalized ClaudeMessage objects into rich Discord embeds
 * with tool previews, syntax highlighting, and completion stats.
 */

import type { ClaudeMessage } from './message-converter.js';
import { sendEmbed, editEmbed, sendToThread, truncateCodePoints, type EmbedData } from './discord.js';

/** Safely access a metadata field with a typed default */
function meta<T>(m: Record<string, unknown> | undefined, key: string, fallback: T): T {
    if (!m || !(key in m)) return fallback;
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

/** Truncate content with smart preview */
function truncateContent(content: string, maxLines = 15, maxChars = 1000): { preview: string; isTruncated: boolean; totalLines: number } {
    const lines = content.split('\n');
    const totalLines = lines.length;
    const truncatedLines = lines.slice(0, maxLines);
    const preview = truncatedLines.join('\n');

    if ([...preview].length > maxChars) {
        return {
            preview: truncateCodePoints(preview, maxChars),
            isTruncated: true,
            totalLines
        };
    }

    return {
        preview,
        isTruncated: lines.length > maxLines,
        totalLines
    };
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

/** Map file extension to Discord code block language tag */
const EXT_TO_LANG: Record<string, string> = {
    'ts': 'ts', 'tsx': 'tsx', 'js': 'js', 'jsx': 'jsx',
    'py': 'py', 'rs': 'rs', 'go': 'go', 'java': 'java',
    'json': 'json', 'yml': 'yaml', 'yaml': 'yaml',
    'html': 'html', 'css': 'css', 'scss': 'scss',
    'sh': 'sh', 'bash': 'bash', 'zsh': 'sh',
    'sql': 'sql', 'rb': 'rb', 'c': 'c', 'cpp': 'cpp',
    'h': 'c', 'hpp': 'cpp', 'xml': 'xml', 'toml': 'toml',
    'md': 'md', 'swift': 'swift', 'kt': 'kotlin',
};

/** Format tool name for display: mcp__disclaw__title_generate → disclaw/title_generate */
function formatToolName(name: string): string {
    if (name.startsWith('mcp__')) {
        // mcp__<server>__<tool> → <server>/<tool>
        const parts = name.slice(5).split('__');
        return parts.join('/');
    }
    return name;
}

/** Get the Discord code fence language tag for a file path */
function getLangTag(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    return EXT_TO_LANG[ext] || '';
}

/** Detect file type from path for icons */
function getFileTypeInfo(filePath: string): { icon: string; language: string } {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';

    const fileTypes: Record<string, { icon: string; language: string }> = {
        'ts': { icon: '📘', language: 'TypeScript' },
        'tsx': { icon: '⚛️', language: 'React/TypeScript' },
        'js': { icon: '📙', language: 'JavaScript' },
        'jsx': { icon: '⚛️', language: 'React/JavaScript' },
        'py': { icon: '🐍', language: 'Python' },
        'rs': { icon: '🦀', language: 'Rust' },
        'go': { icon: '🐹', language: 'Go' },
        'java': { icon: '☕', language: 'Java' },
        'md': { icon: '📝', language: 'Markdown' },
        'json': { icon: '📋', language: 'JSON' },
        'yml': { icon: '⚙️', language: 'YAML' },
        'yaml': { icon: '⚙️', language: 'YAML' },
        'html': { icon: '🌐', language: 'HTML' },
        'css': { icon: '🎨', language: 'CSS' },
        'scss': { icon: '🎨', language: 'SCSS' },
    };

    return fileTypes[ext] || { icon: '📄', language: 'Text' };
}

/**
 * Create a sender function bound to a specific thread.
 *
 * Returns an async function that converts ClaudeMessage[] into Discord embeds
 * and sends them to the given thread.
 */
export function createClaudeSender(threadId: string) {
    // Map toolUseId → { discordMessageId, embeds } for correlating tool_result with tool_use
    const toolUseMessages = new Map<string, { messageId: string; embeds: EmbedData[] }>();

    return async function sendClaudeMessages(messages: ClaudeMessage[]): Promise<void> {
        for (const msg of messages) {
            switch (msg.type) {
                case 'text': {
                    // Send as plain text to preserve full markdown rendering
                    // (embeds have limited markdown support, breaking code blocks etc.)
                    await sendToThread(threadId, msg.content);
                    break;
                }

                case 'tool_use': {
                    const toolName = meta<string>(msg.metadata, 'name', 'Unknown');
                    const toolInput = meta<Record<string, unknown>>(msg.metadata, 'input', {});
                    const toolUseId = meta<string | undefined>(msg.metadata, 'toolUseId', undefined);
                    const displayName = formatToolName(toolName);

                    let embeds: EmbedData[];

                    if (toolName === 'TodoWrite') {
                        const todos = meta<Array<{ status: string; priority: string; content: string }>>(toolInput, 'todos', []);
                        const statusEmojis: Record<string, string> = {
                            pending: '⏳', in_progress: '🔄', completed: '✅'
                        };
                        const priorityEmojis: Record<string, string> = {
                            high: '🔴', medium: '🟡', low: '🟢'
                        };

                        let todoList = '';
                        if (todos.length === 0) {
                            todoList = 'Task list is empty';
                        } else {
                            for (const todo of todos) {
                                const statusEmoji = statusEmojis[todo.status] || '❓';
                                const priorityEmoji = priorityEmojis[todo.priority] || '';
                                const priorityText = priorityEmoji ? `${priorityEmoji} ` : '';
                                todoList += `${statusEmoji} ${priorityText}**${todo.content}**\n`;
                            }
                        }

                        embeds = [{
                            color: 0x9932cc,
                            title: `📝 \`${displayName}\``,
                            description: todoList,
                            footer: { text: '⏳ Pending | 🔄 In Progress | ✅ Completed | 🔴 High | 🟡 Medium | 🟢 Low' },
                        }];
                    } else if (toolName === 'disclaw_cron_create') {
                        const schedule = meta<string>(toolInput, 'schedule', '');
                        const prompt = meta<string>(toolInput, 'prompt', '');
                        embeds = [{
                            color: 0x5865f2,
                            title: `🔧 \`${displayName}\``,
                            fields: [
                                { name: 'Schedule', value: `\`${schedule}\``, inline: true },
                                { name: 'Prompt', value: truncateCodePoints(prompt, 500) },
                            ],
                        }];
                    } else if (toolName === 'disclaw_cron_delete') {
                        const jobId = meta<string>(toolInput, 'job_id', '');
                        embeds = [{
                            color: 0xff4444,
                            title: `🔧 \`${displayName}\``,
                            description: `Job: \`${jobId}\``,
                        }];
                    } else if (toolName === 'disclaw_cron_list') {
                        embeds = [{
                            color: 0x5865f2,
                            title: `🔧 \`${displayName}\``,
                        }];
                    } else if (toolName === 'disclaw_title_generate') {
                        embeds = [{
                            color: 0x5865f2,
                            title: `🔧 \`${displayName}\``,
                        }];
                    } else if (toolName === 'Edit') {
                        const filePath = meta(toolInput, 'file_path', 'Unknown file');
                        const oldString = meta(toolInput, 'old_string', '');
                        const newString = meta(toolInput, 'new_string', '');
                        const lang = getLangTag(filePath);

                        const fields: Array<{ name: string; value: string; inline?: boolean }> = [
                            { name: '📁 File Path', value: `\`${filePath}\``, inline: false }
                        ];

                        if (oldString) {
                            const { preview: oldPreview } = truncateContent(oldString, 3, 150);
                            fields.push({ name: '🔴 Replacing', value: `\`\`\`${lang}\n${oldPreview}\n\`\`\``, inline: false });
                        }

                        if (newString) {
                            const { preview: newPreview } = truncateContent(newString, 3, 150);
                            fields.push({ name: '🟢 With', value: `\`\`\`${lang}\n${newPreview}\n\`\`\``, inline: false });
                        }

                        embeds = [{
                            color: 0xffaa00,
                            title: `✏️ \`${displayName}\``,
                            fields,
                        }];
                    } else {
                        const inputStr = JSON.stringify(toolInput, null, 2);
                        const { preview } = truncateContent(inputStr, 10, 800);

                        embeds = [{
                            color: 0x0099ff,
                            title: `🔧 \`${displayName}\``,
                            description: `\`\`\`json\n${preview}\n\`\`\``,
                        }];
                    }

                    const discordMsgId = await sendEmbed(threadId, embeds);

                    // Track this tool_use message for later correlation with tool_result
                    if (toolUseId) {
                        toolUseMessages.set(toolUseId, { messageId: discordMsgId, embeds });
                    }
                    break;
                }

                case 'tool_result': {
                    // Filter out system reminder content
                    let cleanContent = msg.content;
                    cleanContent = cleanContent.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
                    cleanContent = cleanContent.replace(/\n\s*\n\s*\n/g, '\n\n').trim();

                    const toolUseId = meta<string | undefined>(msg.metadata, 'toolUseId', undefined);
                    const tracked = toolUseId ? toolUseMessages.get(toolUseId) : undefined;

                    if (tracked) {
                        // Merge result into the original tool_use embed as a field
                        toolUseMessages.delete(toolUseId!);
                        const embed = tracked.embeds[0]!;

                        if (cleanContent) {
                            const { preview, isTruncated, totalLines } = truncateContent(cleanContent);
                            const suffix = isTruncated ? ` (+${totalLines - 15} more lines)` : '';
                            const fields = embed.fields ?? [];
                            fields.push({
                                name: `✅ Result${suffix}`,
                                value: `\`\`\`\n${preview}\n\`\`\``,
                                inline: false,
                            });
                            await editEmbed(threadId, tracked.messageId, [{ ...embed, fields, color: 0x00ffff }]);
                        } else {
                            // Empty result - append a Done field
                            const fields = embed.fields ?? [];
                            fields.push({ name: '✅ Done', value: '\u200b', inline: false });
                            await editEmbed(threadId, tracked.messageId, [{ ...embed, fields, color: 0x00ff00 }]);
                        }
                    } else if (cleanContent) {
                        // Fallback: no matching tool_use found, send as separate message
                        const { preview, isTruncated, totalLines } = truncateContent(cleanContent);
                        await sendEmbed(threadId, [{
                            color: 0x00ffff,
                            title: `✅ Tool Result${isTruncated ? ` (+${totalLines - 15} more lines)` : ''}`,
                            description: `\`\`\`\n${preview}\n\`\`\``,
                        }]);
                    }
                    break;
                }

                case 'thinking': {
                    const chunks = splitText(msg.content, 4000);
                    for (let i = 0; i < chunks.length; i++) {
                        await sendEmbed(threadId, [{
                            color: 0x9b59b6,
                            title: chunks.length > 1 ? `💭 Thinking (${i + 1}/${chunks.length})` : '💭 Thinking',
                            description: chunks[i]!,
                        }]);
                    }
                    break;
                }

                case 'system': {
                    const isCompletion = meta<string>(msg.metadata, 'subtype', '') === 'completion';

                    if (isCompletion) {
                        // Compact completion line: Done · model · ctx 42% · 3.2s
                        const parts: string[] = [];
                        // model field or extract from modelUsage keys
                        interface UsageInfo { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; contextWindow: number }
                        const modelUsage = meta<Record<string, UsageInfo> | undefined>(msg.metadata, 'modelUsage', undefined);
                        const modelName = meta<string>(msg.metadata, 'model', '')
                            || (modelUsage && Object.keys(modelUsage)[0]);
                        if (modelName) parts.push(modelName);

                        // Calculate context usage percentage from modelUsage
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

                        const durationMs = meta<number | undefined>(msg.metadata, 'duration_ms', undefined);
                        if (durationMs !== undefined) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
                        const stopReasonDisplay = formatStopReason(
                            meta<string | undefined>(msg.metadata, 'stop_reason', undefined),
                            meta<string | undefined>(msg.metadata, 'sdkSubtype', undefined),
                        );
                        if (stopReasonDisplay && stopReasonDisplay !== 'Completed') parts.push(stopReasonDisplay);

                        await sendEmbed(threadId, [{
                            description: `**Done** · ${parts.join(' · ')}`,
                        }]);
                    }
                    // } else if (msg.metadata?.cwd) {
                    //     // Init message: just show working directory
                    //     await sendEmbed(threadId, [{
                    //         color: 0xaaaaaa,
                    //         description: `⚙️ \`${msg.metadata.cwd}\``,
                    //     }]);
                    // }
                    // Skip other generic system messages silently
                    break;
                }

                case 'other': {
                    const jsonStr = JSON.stringify(msg.metadata || msg.content, null, 2);
                    const maxChunkLength = 4096 - '```json\n\n```'.length - 50;
                    const chunks = splitText(jsonStr, maxChunkLength);
                    for (let i = 0; i < chunks.length; i++) {
                        await sendEmbed(threadId, [{
                            color: 0xffaa00,
                            title: chunks.length > 1 ? `Other Content (${i + 1}/${chunks.length})` : 'Other Content',
                            description: `\`\`\`json\n${chunks[i]}\n\`\`\``,
                        }]);
                    }
                    break;
                }

                case 'permission_denied': {
                    const toolName = meta(msg.metadata, 'toolName', 'Unknown');
                    const toolInput = meta<Record<string, unknown>>(msg.metadata, 'toolInput', {});
                    const inputPreview = JSON.stringify(toolInput, null, 2);
                    const { preview } = truncateContent(inputPreview, 6, 500);

                    await sendEmbed(threadId, [{
                        color: 0xff4444,
                        title: `🚫 Permission Denied: \`${formatToolName(toolName)}\``,
                        description: 'This tool was blocked by the current permission mode (`dontAsk`). The bot denies tools that aren\'t pre-approved.',
                        fields: [
                            { name: 'Tool', value: `\`${toolName}\``, inline: true },
                            { name: 'Input Preview', value: `\`\`\`json\n${preview}\n\`\`\``, inline: false }
                        ],
                        footer: { text: 'Change operation mode with /settings → Mode Settings to allow more tools' },
                    }]);
                    break;
                }

                case 'task_started': {
                    const description = meta(msg.metadata, 'description', '') || msg.content || 'Starting subagent task...';
                    const taskType = meta<string | undefined>(msg.metadata, 'taskType', undefined);

                    await sendEmbed(threadId, [{
                        color: 0x5865f2,
                        title: '🚀 Subagent Task Started',
                        description,
                        fields: taskType ? [{ name: 'Type', value: taskType, inline: true }] : [],
                    }]);
                    break;
                }

                case 'task_notification': {
                    const status = meta<string>(msg.metadata, 'status', 'unknown');
                    const summary = meta(msg.metadata, 'summary', '') || msg.content || 'No summary';
                    const statusEmoji = status === 'completed' ? '✅' : status === 'failed' ? '❌' : '⏹️';
                    const statusColor = status === 'completed' ? 0x00ff00 : status === 'failed' ? 0xff0000 : 0xffaa00;

                    await sendEmbed(threadId, [{
                        color: statusColor,
                        title: `${statusEmoji} Subagent Task ${status.charAt(0).toUpperCase() + status.slice(1)}`,
                        description: truncateCodePoints(summary, 4000),
                    }]);
                    break;
                }

                case 'tool_progress': {
                    // Only show progress for long-running tools (>5s)
                    const elapsed = meta(msg.metadata, 'elapsedSeconds', 0);
                    if (elapsed >= 5) {
                        const toolName = meta(msg.metadata, 'toolName', 'Unknown');
                        await sendEmbed(threadId, [{
                            color: 0x888888,
                            title: `⏳ \`${formatToolName(toolName)}\` running...`,
                            description: `Elapsed: ${elapsed.toFixed(1)}s`,
                        }]);
                    }
                    break;
                }

                case 'tool_summary': {
                    if (msg.content) {
                        await sendEmbed(threadId, [{
                            color: 0x00ccff,
                            title: '📋 Tool Summary',
                            description: truncateCodePoints(msg.content, 4000),
                        }]);
                    }
                    break;
                }
            }
        }
    };
}
