/**
 * History - Paginated session history viewer for Discord
 *
 * Renders session messages as a single embed with ◀/▶ navigation buttons.
 * Used by fork, resume, and rewind to show conversation context.
 */

import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type InteractionUpdateOptions, type MessagePayload } from 'discord.js';
import { truncateCodePoints, sendRichMessage, editRichMessage } from './discord.js';

const MESSAGES_PER_PAGE = 6;
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const log = (msg: string) => process.stdout.write(`[history] ${msg}\n`);

interface HistoryEntry {
    role: 'user' | 'assistant';
    text: string;
}

interface HistoryState {
    id: string; // short unique ID for button custom_ids
    threadId: string;
    messageId: string; // Discord message ID (for timeout cleanup)
    entries: HistoryEntry[];
    page: number;
    totalPages: number;
    timeout: Timer | null;
}

// Keyed by the short ID used in button custom_ids
const activeHistories = new Map<string, HistoryState>();

/** Extract displayable text from a session message's content. */
function extractText(message: unknown): string {
    if (!message || typeof message !== 'object') return '';
    const msg = message as Record<string, unknown>;

    // User messages: content can be string or array of content blocks
    if (typeof msg.content === 'string') return msg.content;

    if (Array.isArray(msg.content)) {
        const parts: string[] = [];
        for (const block of msg.content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
                parts.push(block.text);
            } else if (block?.type === 'tool_use') {
                parts.push(`🔧 ${block.name || 'tool'}`);
            }
        }
        return parts.join('\n');
    }

    return '';
}

/** Build the embed + components for the current page. */
function buildHistoryMessage(state: HistoryState) {
    const { id, entries, page, totalPages } = state;
    const start = page * MESSAGES_PER_PAGE;
    const pageEntries = entries.slice(start, start + MESSAGES_PER_PAGE);

    const lines: string[] = [];
    for (const entry of pageEntries) {
        const icon = entry.role === 'user' ? '💬' : '🤖';
        const label = entry.role === 'user' ? 'You' : 'Claude';
        const text = truncateCodePoints(entry.text.replace(/\n/g, ' '), 300);
        lines.push(`${icon} **${label}**\n${text}`);
    }

    const description = lines.join('\n\n') || '*No messages*';

    const components = totalPages > 1
        ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`history:${id}:prev`)
                .setLabel('◀ Older')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0),
            new ButtonBuilder()
                .setCustomId(`history:${id}:noop`)
                .setLabel(`${page + 1}/${totalPages}`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId(`history:${id}:next`)
                .setLabel('Newer ▶')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page >= totalPages - 1),
        )]
        : [];

    return {
        embeds: [{
            color: 0x5865f2,
            title: '📜 Conversation History',
            description,
            footer: { text: `Page ${page + 1}/${totalPages} · ${entries.length} messages` },
        }],
        components,
    };
}

/** Send a paginated history embed to a thread. Returns the message ID. */
export async function sendHistory(threadId: string, sessionId: string, workingDir?: string): Promise<string | null> {
    let rawMessages;
    try {
        rawMessages = await getSessionMessages(sessionId, { dir: workingDir });
    } catch (err) {
        log(`Failed to fetch session messages: ${err}`);
        return null;
    }

    // Convert to displayable entries, filtering out empty ones
    const entries: HistoryEntry[] = [];
    for (const msg of rawMessages) {
        const text = extractText(msg.message);
        if (!text.trim()) continue;
        entries.push({ role: msg.type, text });
    }

    if (entries.length === 0) {
        log('No messages to display');
        return null;
    }

    const totalPages = Math.ceil(entries.length / MESSAGES_PER_PAGE);
    const page = totalPages - 1; // Start at last page (newest)
    const id = crypto.randomUUID().slice(0, 8);

    const state: HistoryState = {
        id,
        threadId,
        messageId: '', // filled after send
        entries,
        page,
        totalPages,
        timeout: null,
    };

    // Build and send — buttons already have the correct ID
    const body = buildHistoryMessage(state);
    try {
        state.messageId = await sendRichMessage(threadId, body);
    } catch (err) {
        log(`Failed to send history: ${err}`);
        return null;
    }

    // Register for pagination if multiple pages
    if (totalPages > 1) {
        state.timeout = setTimeout(() => {
            activeHistories.delete(id);
            editRichMessage(threadId, state.messageId, { components: [] }).catch(() => {});
        }, TIMEOUT_MS);
        activeHistories.set(id, state);
    }

    log(`History sent to ${threadId}: ${entries.length} messages, ${totalPages} pages`);
    return state.messageId;
}

/**
 * Handle a button interaction for history pagination.
 * Returns true if handled, false if not a history button.
 */
export async function handleHistoryInteraction(interaction: {
    customId: string;
    update: (data: string | MessagePayload | InteractionUpdateOptions) => Promise<unknown>;
}): Promise<boolean> {
    const { customId } = interaction;
    if (!customId.startsWith('history:')) return false;

    const parts = customId.split(':');
    const id = parts[1]!;
    const action = parts[2]!;

    const state = activeHistories.get(id);
    if (!state) {
        await interaction.update({ content: 'This history view has expired.', embeds: [], components: [] });
        return true;
    }

    if (action === 'prev') {
        state.page = Math.max(0, state.page - 1);
    } else if (action === 'next') {
        state.page = Math.min(state.totalPages - 1, state.page + 1);
    }

    await interaction.update(buildHistoryMessage(state));
    return true;
}
