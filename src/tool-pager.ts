/**
 * Tool Pager - Paginated message display in a single Discord embed
 *
 * In pager mode, all non-result messages (tool calls, thinking, assistant text)
 * are rendered in one embed that updates in-place with ◀/▶ navigation.
 *
 * Two-phase approach:
 * Phase 1 (running): Messages cached in memory, buttons use pager:<id>:<action>
 * Phase 2 (finalized): Memory freed, buttons switched to pgr:<sessionId>:<msgOffset>:<msgLimit>:<pageIdx>:<action>
 *                       Subsequent clicks query SDK on-demand via getSessionMessages()
 */

import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeMessage } from './message-converter.js';
import type { ButtonInteraction } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { sendRichMessage, editRichMessage, truncateCodePoints, type EmbedData } from './discord.js';
import { getThreadMapping } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('pager');

// =========================================================================
// Types
// =========================================================================

type PageKind = 'tool' | 'thinking' | 'text';

interface PagerPage {
    kind: PageKind;
    /** Display label: tool name, "Thinking", or "Assistant" */
    label: string;
    /** Primary content (input preview for tools, thinking text, assistant text) */
    content: string;
    /** Secondary content (tool result) — only for tool pages */
    result?: string;
    status: 'running' | 'done';
}

export interface ToolPager {
    handleMessage(msg: ClaudeMessage): void;
    /** Track raw SDK messages to capture first message UUID for offset calculation */
    trackRawMessage(sdkMessage: { type: string; uuid?: string }): void;
    /** Finalize: switch buttons to persistent SDK-backed mode, free memory */
    destroy(sessionId: string, workingDir: string): void;
}

// =========================================================================
// Shared rendering
// =========================================================================

/** Format tool name: mcp__server__tool → server/tool */
function formatToolName(name: string): string {
    if (name.startsWith('mcp__')) {
        return name.slice(5).split('__').join('/');
    }
    return name;
}

/** Truncate content for pager display */
function truncatePreview(content: string, maxLines = 10, maxChars = 800): string {
    const lines = content.split('\n');
    const truncated = lines.slice(0, maxLines).join('\n');
    const result = [...truncated].length > maxChars
        ? truncateCodePoints(truncated, maxChars)
        : truncated;
    const remaining = lines.length - maxLines;
    return remaining > 0 ? `${result}\n(+${remaining} more lines)` : result;
}

const PAGE_COLORS: Record<PageKind, { active: number; done: number }> = {
    tool:     { active: 0x0099ff, done: 0x00ffff },
    thinking: { active: 0x9b59b6, done: 0x9b59b6 },
    text:     { active: 0x2ecc71, done: 0x2ecc71 },
};

const PAGE_ICONS: Record<PageKind, string> = {
    tool: '🔧',
    thinking: '💭',
    text: '💬',
};

function buildPageEmbed(page: PagerPage, pageIdx: number, total: number): EmbedData {
    const icon = PAGE_ICONS[page.kind];
    const statusIcon = page.status === 'running' ? '⏳' : '✅';
    const colors = PAGE_COLORS[page.kind];

    let description: string;

    if (page.kind === 'tool') {
        description = `**${statusIcon} \`${page.label}\`**\n`;
        if (page.content) {
            description += `\`\`\`json\n${page.content}\n\`\`\`\n`;
        }
        if (page.result) {
            description += `**Result:**\n\`\`\`\n${page.result}\n\`\`\``;
        } else if (page.status === 'done' && !page.result) {
            description += '*Done (empty result)*';
        }
    } else if (page.kind === 'thinking') {
        description = page.content;
    } else {
        // text
        description = page.content;
    }

    if ([...description].length > 4000) {
        description = truncateCodePoints(description, 4000);
    }

    return {
        color: page.status === 'done' ? colors.done : colors.active,
        title: `${icon} ${page.label} (${pageIdx + 1}/${total})`,
        description,
    };
}

// =========================================================================
// Buttons
// =========================================================================

function buildLiveButtons(id: string, currentPage: number, total: number): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`pager:${id}:prev`)
            .setEmoji('◀')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage <= 0),
        new ButtonBuilder()
            .setCustomId(`pager:${id}:info`)
            .setLabel(`${currentPage + 1} / ${total}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
        new ButtonBuilder()
            .setCustomId(`pager:${id}:next`)
            .setEmoji('▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage >= total - 1),
    );
}

/** Button ID format: pgr:<sessionId>:<msgOffset>:<msgLimit>:<pageIdx>:<action> */
function buildPersistentButtons(
    sessionId: string, pageIdx: number, total: number,
    msgOffset: number, msgLimit: number,
): ActionRowBuilder<ButtonBuilder> {
    const prefix = `pgr:${sessionId}:${msgOffset}:${msgLimit}`;
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`${prefix}:${pageIdx}:prev`)
            .setEmoji('◀')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(pageIdx <= 0),
        new ButtonBuilder()
            .setCustomId(`${prefix}:${pageIdx}:info`)
            .setLabel(`${pageIdx + 1} / ${total}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
        new ButtonBuilder()
            .setCustomId(`${prefix}:${pageIdx}:next`)
            .setEmoji('▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(pageIdx >= total - 1),
    );
}

// =========================================================================
// Phase 1: In-memory pager (active during job execution)
// =========================================================================

interface LivePagerState {
    id: string;
    threadId: string;
    messageId: string | null;
    pages: PagerPage[];
    currentPage: number;
    /** Map toolUseId → page index for merging tool_result */
    toolUseIdToPage: Map<string, number>;
    updateTimer: ReturnType<typeof setTimeout> | null;
    pendingUpdate: boolean;
    flushing: Promise<void> | null;
    destroyed: boolean;
    /** UUID of the first user/assistant SDK message in this round */
    firstMessageUuid: string | null;
}

const activePagers = new Map<string, LivePagerState>();
let pagerCounter = 0;

function buildLiveEmbed(state: LivePagerState): EmbedData {
    const total = state.pages.length;
    if (total === 0) {
        return {
            color: 0x0099ff,
            title: '📄 Messages (0/0)',
            description: 'Waiting...',
        };
    }
    return buildPageEmbed(state.pages[state.currentPage]!, state.currentPage, total);
}

async function doFlush(state: LivePagerState): Promise<void> {
    state.pendingUpdate = false;
    if (state.destroyed && !state.messageId) return;

    const embed = buildLiveEmbed(state);

    try {
        const components = state.pages.length > 1
            ? [buildLiveButtons(state.id, state.currentPage, state.pages.length)]
            : [];
        if (!state.messageId) {
            state.messageId = await sendRichMessage(state.threadId, {
                embeds: [embed],
                components,
            });
        } else {
            await editRichMessage(state.threadId, state.messageId, {
                embeds: [embed],
                components,
            });
        }
    } catch (e) {
        log(`Failed to update pager: ${e}`);
    }

    if (state.pendingUpdate) {
        await doFlush(state);
    }
}

function scheduleUpdate(state: LivePagerState): void {
    state.pendingUpdate = true;
    if (state.updateTimer) return;
    if (state.flushing) return;

    const delay = state.messageId ? 500 : 0;
    state.updateTimer = setTimeout(() => {
        state.updateTimer = null;
        state.flushing = doFlush(state).finally(() => {
            state.flushing = null;
        });
    }, delay);
}

// =========================================================================
// Phase 2: SDK-backed query for persistent buttons
// =========================================================================

/** Strip system-reminder tags and normalize whitespace */
function cleanContent(text: string): string {
    return text
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
        .replace(/\n\s*\n\s*\n/g, '\n\n')
        .trim();
}

/** Parse all displayable pages from raw session messages */
function parseSessionPages(rawMessages: Array<{ type: string; message: unknown }>): PagerPage[] {
    const pages: PagerPage[] = [];
    const toolUseIdToPage = new Map<string, number>();

    for (const raw of rawMessages) {
        const msg = raw.message as Record<string, unknown>;
        const content = msg.content;

        // String content (simple user message) — skip in pager
        if (typeof content === 'string') continue;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
            if (!block || typeof block !== 'object') continue;

            if (block.type === 'thinking' && block.thinking) {
                pages.push({
                    kind: 'thinking',
                    label: 'Thinking',
                    content: truncatePreview(String(block.thinking), 20, 3500),
                    status: 'done',
                });
            } else if (block.type === 'text' && block.text && raw.type === 'assistant') {
                const text = String(block.text).trim();
                if (text) {
                    pages.push({
                        kind: 'text',
                        label: 'Assistant',
                        content: truncatePreview(text, 20, 3500),
                        status: 'done',
                    });
                }
            } else if (block.type === 'tool_use') {
                const inputStr = block.input ? JSON.stringify(block.input, null, 2) : '';
                const pageIdx = pages.length;
                pages.push({
                    kind: 'tool',
                    label: formatToolName(block.name || 'Unknown'),
                    content: truncatePreview(inputStr, 8, 600),
                    status: 'done',
                });
                if (block.id) {
                    toolUseIdToPage.set(block.id, pageIdx);
                }
            } else if (block.type === 'tool_result') {
                const pageIdx = block.tool_use_id ? toolUseIdToPage.get(block.tool_use_id) : undefined;
                if (pageIdx !== undefined) {
                    let resultText = '';
                    if (typeof block.content === 'string') {
                        resultText = block.content;
                    } else if (Array.isArray(block.content)) {
                        resultText = block.content
                            .filter((b: Record<string, unknown>) => b.type === 'text')
                            .map((b: Record<string, unknown>) => b.text)
                            .join('\n');
                    }
                    resultText = cleanContent(resultText);
                    if (resultText) {
                        pages[pageIdx]!.result = truncatePreview(resultText);
                    }
                }
            }
        }
    }

    return pages;
}

/** Fetch and render a page from SDK session data */
async function renderPersistentPage(
    sessionId: string, pageIdx: number,
    msgOffset: number, msgLimit: number, dir?: string,
): Promise<{ embed: EmbedData; total: number; pageIdx: number } | null> {
    try {
        // Only fetch this round's messages using offset/limit
        const rawMessages = await getSessionMessages(sessionId, {
            dir,
            ...(msgOffset > 0 ? { offset: msgOffset } : {}),
            ...(msgLimit > 0 ? { limit: msgLimit } : {}),
        });
        const pages = parseSessionPages(rawMessages as Array<{ type: string; message: unknown }>);
        if (pages.length === 0) return null;

        const clampedIdx = Math.max(0, Math.min(pageIdx, pages.length - 1));
        return {
            embed: buildPageEmbed(pages[clampedIdx]!, clampedIdx, pages.length),
            total: pages.length,
            pageIdx: clampedIdx,
        };
    } catch (e) {
        log(`Failed to fetch session messages: ${e}`);
        return null;
    }
}

// =========================================================================
// Public API
// =========================================================================

export function createToolPager(threadId: string): ToolPager {
    const id = `p${++pagerCounter}`;
    const state: LivePagerState = {
        id,
        threadId,
        messageId: null,
        pages: [],
        currentPage: 0,
        toolUseIdToPage: new Map(),
        updateTimer: null,
        pendingUpdate: false,
        flushing: null,
        destroyed: false,
        firstMessageUuid: null,
    };

    activePagers.set(id, state);

    return {
        trackRawMessage(sdkMessage: { type: string; uuid?: string }): void {
            if (!state.firstMessageUuid
                && (sdkMessage.type === 'user' || sdkMessage.type === 'assistant')
                && sdkMessage.uuid) {
                state.firstMessageUuid = sdkMessage.uuid;
            }
        },

        handleMessage(msg: ClaudeMessage): void {
            if (state.destroyed) return;

            switch (msg.type) {
                case 'tool_use': {
                    const toolName = (msg.metadata?.name as string) || 'Unknown';
                    const toolUseId = (msg.metadata?.toolUseId as string) || '';
                    const toolInput = msg.metadata?.input as Record<string, unknown> | undefined;
                    const inputStr = toolInput ? JSON.stringify(toolInput, null, 2) : '';

                    const pageIdx = state.pages.length;
                    state.pages.push({
                        kind: 'tool',
                        label: formatToolName(toolName),
                        content: truncatePreview(inputStr, 8, 600),
                        status: 'running',
                    });
                    if (toolUseId) {
                        state.toolUseIdToPage.set(toolUseId, pageIdx);
                    }
                    state.currentPage = pageIdx;
                    scheduleUpdate(state);
                    break;
                }
                case 'tool_result': {
                    const toolUseId = (msg.metadata?.toolUseId as string) || '';
                    const pageIdx = toolUseId ? state.toolUseIdToPage.get(toolUseId) : undefined;
                    const page = pageIdx !== undefined ? state.pages[pageIdx] : undefined;
                    if (page) {
                        const content = cleanContent(msg.content);
                        page.result = content ? truncatePreview(content) : undefined;
                        page.status = 'done';
                    }
                    scheduleUpdate(state);
                    break;
                }
                case 'thinking': {
                    state.pages.push({
                        kind: 'thinking',
                        label: 'Thinking',
                        content: truncatePreview(msg.content, 20, 3500),
                        status: 'done',
                    });
                    state.currentPage = state.pages.length - 1;
                    scheduleUpdate(state);
                    break;
                }
                case 'text': {
                    const text = msg.content.trim();
                    if (text) {
                        state.pages.push({
                            kind: 'text',
                            label: 'Assistant',
                            content: truncatePreview(text, 20, 3500),
                            status: 'done',
                        });
                        state.currentPage = state.pages.length - 1;
                        scheduleUpdate(state);
                    }
                    break;
                }
                case 'tool_progress':
                case 'tool_summary': {
                    // Just trigger re-render for progress updates
                    scheduleUpdate(state);
                    break;
                }
            }
        },

        async destroy(sessionId: string, workingDir: string): Promise<void> {
            state.destroyed = true;

            // Flush pending updates
            if (state.updateTimer) {
                clearTimeout(state.updateTimer);
                state.updateTimer = null;
            }
            if (state.flushing) {
                await state.flushing;
            }
            if (state.pendingUpdate) {
                await doFlush(state);
            }

            if (!state.messageId || state.pages.length === 0) {
                activePagers.delete(id);
                return;
            }

            // Switch to persistent SDK-backed buttons
            try {
                const allMessages = await getSessionMessages(sessionId, { dir: workingDir });
                const typedMessages = allMessages as Array<{ type: string; uuid: string; message: unknown }>;

                // Find offset by matching first message UUID.
                // The SDK doesn't stream the initial user prompt, so firstMessageUuid
                // points to the first assistant message. Include the preceding user
                // message (if any) by subtracting 1.
                let msgOffset = 0;
                if (state.firstMessageUuid) {
                    const idx = typedMessages.findIndex(m => m.uuid === state.firstMessageUuid);
                    if (idx >= 0) {
                        msgOffset = idx > 0 && typedMessages[idx - 1]!.type === 'user'
                            ? idx - 1 : idx;
                    } else {
                        log.warn(`UUID ${state.firstMessageUuid} not found in session, showing all pages`);
                    }
                }
                const msgLimit = typedMessages.length - msgOffset;
                const currentRoundMessages = typedMessages.slice(msgOffset);
                const pages = parseSessionPages(currentRoundMessages);
                const total = pages.length;
                const pageIdx = Math.min(state.currentPage, Math.max(0, total - 1));

                if (total > 0) {
                    const embed = buildPageEmbed(pages[pageIdx]!, pageIdx, total);
                    const components = total > 1
                        ? [buildPersistentButtons(sessionId, pageIdx, total, msgOffset, msgLimit)]
                        : [];
                    await editRichMessage(state.threadId, state.messageId, {
                        embeds: [embed],
                        components,
                    });
                    log(`Pager ${id} finalized: session=${sessionId}, msgOffset=${msgOffset}, msgLimit=${msgLimit}, pages=${total}`);
                }
            } catch (e) {
                log(`Failed to finalize pager: ${e}`);
            }

            // Free memory
            activePagers.delete(id);
            state.pages.length = 0;
            state.toolUseIdToPage.clear();
        },
    };
}

/**
 * Handle pager button interactions.
 * Phase 1 (live): pager:<id>:<action>
 * Phase 2 (persistent): pgr:<sessionId>:<msgOffset>:<msgLimit>:<pageIdx>:<action>
 */
export async function handlePagerInteraction(interaction: ButtonInteraction): Promise<boolean> {
    const customId = interaction.customId;

    // Phase 1: Live pager buttons
    if (customId.startsWith('pager:')) {
        const parts = customId.split(':');
        const pagerId = parts[1];
        const action = parts[2];
        if (!pagerId || !action) return false;

        const state = activePagers.get(pagerId);
        if (!state) {
            await interaction.deferUpdate();
            return true;
        }

        if (action === 'prev' && state.currentPage > 0) {
            state.currentPage--;
        } else if (action === 'next' && state.currentPage < state.pages.length - 1) {
            state.currentPage++;
        }

        try {
            const embed = buildLiveEmbed(state);
            const row = buildLiveButtons(state.id, state.currentPage, state.pages.length);
            await interaction.update({ embeds: [embed], components: [row] });
        } catch (e) {
            log(`Failed to handle live pager interaction: ${e}`);
        }
        return true;
    }

    // Phase 2: Persistent SDK-backed buttons
    // Current: pgr:<sessionId>:<msgOffset>:<msgLimit>:<pageIdx>:<action>
    // Legacy:  pgr:<sessionId>:<pageIdx>:<action>
    if (customId.startsWith('pgr:')) {
        const parts = customId.split(':');

        let sessionId: string;
        let msgOffset: number;
        let msgLimit: number;
        let pageIdx: number;
        let action: string;

        if (parts.length >= 6) {
            // Current format
            sessionId = parts[1]!;
            msgOffset = parseInt(parts[2]!, 10);
            msgLimit = parseInt(parts[3]!, 10);
            pageIdx = parseInt(parts[4]!, 10);
            action = parts[5]!;
            if (isNaN(pageIdx) || isNaN(msgOffset) || isNaN(msgLimit)) return false;
        } else if (parts.length >= 4) {
            // Legacy format: no offset/limit, fetch all
            sessionId = parts[1]!;
            pageIdx = parseInt(parts[2]!, 10);
            action = parts[3]!;
            msgOffset = 0;
            msgLimit = 0; // 0 = no limit
            if (isNaN(pageIdx)) return false;
        } else {
            return false;
        }

        if (action === 'prev') {
            pageIdx = Math.max(0, pageIdx - 1);
        } else if (action === 'next') {
            pageIdx++;
        }

        try {
            const threadId = interaction.channelId;
            const mapping = threadId ? getThreadMapping(threadId) : null;
            const dir = mapping?.working_dir || undefined;
            const result = await renderPersistentPage(sessionId, pageIdx, msgOffset, msgLimit, dir);
            if (result) {
                const row = buildPersistentButtons(sessionId, result.pageIdx, result.total, msgOffset, msgLimit);
                await interaction.update({
                    embeds: [result.embed],
                    components: [row],
                });
            } else {
                await interaction.deferUpdate();
            }
        } catch (e) {
            log(`Failed to handle persistent pager interaction: ${e}`);
            await interaction.deferUpdate();
        }
        return true;
    }

    return false;
}
