/**
 * History - Paginated session history viewer for Discord
 *
 * Renders session messages as a single embed with ◀/▶ navigation buttons.
 * Used by fork, resume, and rewind to show conversation context.
 */

import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { type InteractionUpdateOptions, type MessagePayload } from 'discord.js';
import { truncateCodePoints, sendRichMessage, editRichMessage, buildPaginationRow } from './discord.js';
import { createLogger } from './logger.js';

const MESSAGES_PER_PAGE = 6;
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const log = createLogger('history');

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
    log.debug(`Building history message: id=${id}, page=${page + 1}/${totalPages}, entries=${entries.length}`);
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
        ? [buildPaginationRow(page, totalPages, `history:${id}`, {
            prevLabel: '◀ Older',
            nextLabel: 'Newer ▶',
        })]
        : [];

    return {
        embeds: [{
            color: 0x5865f2,
            title: '📜 Conversation History',
            description,
            footer: { text: `${entries.length} messages` },
        }],
        components,
    };
}

/** Send a paginated history embed to a thread. Returns the message ID. */
export async function sendHistory(threadId: string, sessionId: string, workingDir?: string): Promise<string | null> {
    log(`Session history requested: thread=${threadId}, session=${sessionId}, workingDir=${workingDir || '(default)'}`);
    let rawMessages;
    try {
        rawMessages = await getSessionMessages(sessionId, { dir: workingDir });
        log.debug(`Fetched ${rawMessages.length} raw messages for session=${sessionId}`);
    } catch (err) {
        log.error(`Failed to fetch session messages for session=${sessionId}: ${err}`);
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
        log.warn(`No displayable messages in session=${sessionId} for thread=${threadId}`);
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
        log.error(`Failed to send history embed to thread=${threadId}: ${err}`);
        return null;
    }

    // Register for pagination if multiple pages
    if (totalPages > 1) {
        state.timeout = setTimeout(() => {
            log(`History view timed out: id=${id}, thread=${threadId}`);
            activeHistories.delete(id);
            editRichMessage(threadId, state.messageId, { components: [] }).catch(() => {});
        }, TIMEOUT_MS);
        activeHistories.set(id, state);
        log.debug(`History pagination registered: id=${id}, timeout=${TIMEOUT_MS}ms`);
    }

    log(`Session history loaded: thread=${threadId}, session=${sessionId}, ${entries.length} messages, ${totalPages} pages, startPage=${page + 1}`);
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
        log.warn(`History interaction for expired view: id=${id}, action=${action}`);
        await interaction.update({ content: 'This history view has expired.', embeds: [], components: [] });
        return true;
    }

    const prevPage = state.page;
    if (action === 'prev') {
        state.page = Math.max(0, state.page - 1);
    } else if (action === 'next') {
        state.page = Math.min(state.totalPages - 1, state.page + 1);
    }
    log(`History page navigation: id=${id}, thread=${state.threadId}, ${prevPage + 1}→${state.page + 1}/${state.totalPages}, action=${action}`);

    await interaction.update(buildHistoryMessage(state));
    return true;
}
