/**
 * Tool Embeds - Shared embed building logic for tool_use display
 *
 * Used by both discord-sender.ts (verbose mode) and tool-pager.ts (pager mode)
 * to ensure consistent tool rendering across display modes.
 */

import { truncateCodePoints, type EmbedData } from './discord.js';

// =========================================================================
// Utility functions
// =========================================================================

/** Escape backticks inside content that will be wrapped in a code block */
export function escapeCodeBlock(text: string): string {
    return text.replaceAll('`', '\\`');
}

/** Format tool name: mcp__disclaw__title_generate → disclaw/title_generate */
export function formatToolName(name: string): string {
    if (name.startsWith('mcp__')) {
        return name.slice(5).split('__').join('/');
    }
    return name;
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

export function getLangTag(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    return EXT_TO_LANG[ext] || '';
}

/** Strip system-reminder tags and normalize whitespace */
export function cleanContent(text: string): string {
    return text
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
        .replace(/\n\s*\n\s*\n/g, '\n\n');
}

/** Truncate content with smart preview */
export function truncateContent(
    content: string, maxLines = 15, maxChars = 1000,
): { preview: string; isTruncated: boolean; totalLines: number } {
    const lines = content.split('\n');
    const totalLines = lines.length;
    const truncatedLines = lines.slice(0, maxLines);
    const preview = truncatedLines.join('\n');

    if (preview.length > maxChars) {
        return { preview: truncateCodePoints(preview, maxChars), isTruncated: true, totalLines };
    }
    return { preview, isTruncated: lines.length > maxLines, totalLines };
}

// =========================================================================
// Tool embed building
// =========================================================================

type EmbedField = { name: string; value: string; inline?: boolean };

/** Tool-specific icon */
function getToolIcon(toolName: string): string {
    if (toolName === 'Agent') return '🤖';
    if (toolName === 'Edit') return '✏️';
    if (toolName === 'TodoWrite') return '📝';
    return '🔧';
}

/** Tool-specific color (for tool_use, before result) */
function getToolColor(toolName: string): number {
    if (toolName === 'Agent') return 0x5865f2;
    if (toolName === 'Edit') return 0xffaa00;
    if (toolName === 'TodoWrite') return 0x9932cc;
    if (toolName === 'mcp__disclaw__cron_delete') return 0xff4444;
    return 0x0099ff;
}

/** Build specialized fields for known tools. Returns null for unknown tools (use generic). */
function buildSpecializedFields(
    toolName: string, input: Record<string, unknown>,
): { fields?: EmbedField[]; description?: string; footer?: { text: string } } | null {

    if (toolName === 'Agent') {
        const fields: EmbedField[] = [];
        const desc = input.description as string | undefined;
        const subType = input.subagent_type as string | undefined;
        const model = input.model as string | undefined;
        const bg = input.run_in_background as boolean | undefined;
        const prompt = input.prompt as string | undefined;
        if (desc) fields.push({ name: 'Description', value: desc, inline: true });
        if (subType) fields.push({ name: 'Type', value: `\`${subType}\``, inline: true });
        if (model) fields.push({ name: 'Model', value: `\`${model}\``, inline: true });
        if (bg) fields.push({ name: 'Background', value: '`true`', inline: true });
        if (prompt) {
            const { preview } = truncateContent(prompt, 8, 800);
            fields.push({ name: 'Prompt', value: `\`\`\`\n${escapeCodeBlock(preview)}\n\`\`\``, inline: false });
        }
        return { fields };
    }

    if (toolName === 'Edit') {
        const fields: EmbedField[] = [];
        const filePath = input.file_path as string | undefined;
        const oldStr = input.old_string as string | undefined;
        const newStr = input.new_string as string | undefined;
        const lang = filePath ? getLangTag(filePath) : '';
        if (filePath) fields.push({ name: '📁 File', value: `\`${filePath}\``, inline: false });
        if (oldStr) {
            const { preview } = truncateContent(oldStr, 3, 150);
            fields.push({ name: '🔴 Replacing', value: `\`\`\`${lang}\n${escapeCodeBlock(preview)}\n\`\`\``, inline: false });
        }
        if (newStr) {
            const { preview } = truncateContent(newStr, 3, 150);
            fields.push({ name: '🟢 With', value: `\`\`\`${lang}\n${escapeCodeBlock(preview)}\n\`\`\``, inline: false });
        }
        return { fields };
    }

    if (toolName === 'Bash') {
        const fields: EmbedField[] = [];
        const cmd = input.command as string | undefined;
        const desc = input.description as string | undefined;
        if (desc) fields.push({ name: 'Description', value: desc, inline: false });
        if (cmd) {
            const { preview } = truncateContent(cmd, 5, 400);
            fields.push({ name: 'Command', value: `\`\`\`sh\n${escapeCodeBlock(preview)}\n\`\`\``, inline: false });
        }
        return { fields };
    }

    if (toolName === 'Write') {
        const fields: EmbedField[] = [];
        const filePath = input.file_path as string | undefined;
        const content = input.content as string | undefined;
        const lang = filePath ? getLangTag(filePath) : '';
        if (filePath) fields.push({ name: '📁 File', value: `\`${filePath}\``, inline: false });
        if (content) {
            const { preview } = truncateContent(content, 5, 400);
            fields.push({ name: 'Content', value: `\`\`\`${lang}\n${escapeCodeBlock(preview)}\n\`\`\``, inline: false });
        }
        return { fields };
    }

    if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
        const fields: EmbedField[] = [];
        for (const [key, val] of Object.entries(input)) {
            if (val === null || val === undefined) continue;
            const str = typeof val === 'string' ? val : `\`${String(val)}\``;
            fields.push({ name: key, value: str, inline: str.length <= 40 && !str.includes('\n') });
        }
        return fields.length > 0 ? { fields } : null;
    }

    if (toolName === 'TodoWrite') {
        const todos = input.todos as Array<{ status: string; priority: string; content: string }> | undefined;
        const statusEmojis: Record<string, string> = { pending: '⏳', in_progress: '🔄', completed: '✅' };
        const priorityEmojis: Record<string, string> = { high: '🔴', medium: '🟡', low: '🟢' };
        let list = '';
        if (!todos || todos.length === 0) {
            list = 'Task list is empty';
        } else {
            for (const t of todos) {
                const pEmoji = priorityEmojis[t.priority];
                list += `${statusEmojis[t.status] || '❓'} ${pEmoji ? pEmoji + ' ' : ''}**${t.content}**\n`;
            }
        }
        return {
            description: list,
            footer: { text: '⏳ Pending | 🔄 In Progress | ✅ Completed | 🔴 High | 🟡 Medium | 🟢 Low' },
        };
    }

    if (toolName === 'mcp__disclaw__cron_create') {
        const schedule = input.schedule as string | undefined;
        const prompt = input.prompt as string | undefined;
        const fields: EmbedField[] = [];
        if (schedule) fields.push({ name: 'Schedule', value: `\`${schedule}\``, inline: true });
        if (prompt) fields.push({ name: 'Prompt', value: truncateCodePoints(prompt, 500) });
        return { fields };
    }

    if (toolName === 'mcp__disclaw__cron_delete' || toolName === 'mcp__disclaw__cron_run_now') {
        const jobId = input.job_id as string | undefined;
        return { description: jobId ? `Job: \`${jobId}\`` : undefined };
    }

    return null;
}

/** Build generic fields from arbitrary tool input (fallback for unknown tools) */
function buildGenericFields(input: Record<string, unknown>): EmbedField[] {
    const fields: EmbedField[] = [];
    for (const [key, raw] of Object.entries(input)) {
        if (raw === null || raw === undefined) continue;
        let val: string;
        if (typeof raw === 'string') {
            val = raw || '*empty*';
        } else if (typeof raw === 'boolean' || typeof raw === 'number') {
            val = `\`${String(raw)}\``;
        } else {
            const json = JSON.stringify(raw, null, 2);
            const { preview } = truncateContent(json, 5, 300);
            val = `\`\`\`json\n${escapeCodeBlock(preview)}\n\`\`\``;
        }
        val = truncateCodePoints(val, 1024);
        const inline = val.length <= 40 && !val.includes('\n');
        fields.push({ name: key, value: val, inline });
    }
    return fields;
}

/**
 * Build a complete embed for a tool_use message.
 * Used by both verbose mode (discord-sender) and pager mode (tool-pager).
 */
export function buildToolUseEmbed(toolName: string, input: Record<string, unknown>): EmbedData {
    const displayName = formatToolName(toolName);
    const icon = getToolIcon(toolName);
    const color = getToolColor(toolName);

    const specialized = buildSpecializedFields(toolName, input);
    if (specialized) {
        return {
            color,
            title: `${icon} \`${displayName}\``,
            description: specialized.description,
            fields: specialized.fields && specialized.fields.length > 0 ? specialized.fields : undefined,
            footer: specialized.footer,
        };
    }

    // Generic fallback
    const genericFields = buildGenericFields(input);
    return {
        color,
        title: `${icon} \`${displayName}\``,
        fields: genericFields.length > 0 ? genericFields : undefined,
    };
}

// =========================================================================
// Tool result field building
// =========================================================================

/** Color when tool_result has content */
export const TOOL_RESULT_COLOR = 0x00ffff;
/** Color when tool completed with empty result */
export const TOOL_DONE_COLOR = 0x00ff00;

/**
 * Build a result field to append to a tool_use embed.
 * Also returns the color the embed should change to.
 */
export function buildToolResultField(resultContent: string): { field: EmbedField; color: number } {
    if (!resultContent) {
        return {
            field: { name: '✅ Done', value: '\u200b', inline: false },
            color: TOOL_DONE_COLOR,
        };
    }

    const { preview, isTruncated, totalLines } = truncateContent(resultContent);
    const suffix = isTruncated ? ` (+${totalLines - 15} more lines)` : '';
    return {
        field: {
            name: `✅ Result${suffix}`,
            value: `\`\`\`\n${escapeCodeBlock(preview)}\n\`\`\``,
            inline: false,
        },
        color: TOOL_RESULT_COLOR,
    };
}
