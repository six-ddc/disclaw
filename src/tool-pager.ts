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
import { getThreadMapping, savePagerMessage, getPagerMessage } from './db.js';
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
    /** Finalize: remove buttons, save metadata to DB for reaction-triggered restore */
    destroy(sessionId: string, workingDir: string): Promise<void>;
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
    if (state.pages.length === 0) return;

    const embed = buildLiveEmbed(state);
    const action = state.messageId ? 'edit' : 'send';
    log.debug(`[${state.id}] doFlush: ${action}, page=${state.currentPage}/${state.pages.length}`);

    try {
        const components = state.pages.length > 1
            ? [buildLiveButtons(state.id, state.currentPage, state.pages.length)]
            : [];
        if (!state.messageId) {
            state.messageId = await sendRichMessage(state.threadId, {
                embeds: [embed],
                components,
            });
            log(`[${state.id}] Initial message sent: messageId=${state.messageId}`);
        } else {
            await editRichMessage(state.threadId, state.messageId, {
                embeds: [embed],
                components,
            });
        }
    } catch (e) {
        log.error(`[${state.id}] doFlush failed: ${e}`);
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
        .replace(/\n\s*\n\s*\n/g, '\n\n');
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
                        content: truncatePreview(text, Infinity, 3800),
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
        log.debug(`renderPersistentPage: fetched ${rawMessages.length} raw messages for session=${sessionId}, offset=${msgOffset}, limit=${msgLimit}`);
        const pages = parseSessionPages(rawMessages as Array<{ type: string; message: unknown }>);
        if (pages.length === 0) {
            log.debug(`renderPersistentPage: no displayable pages from ${rawMessages.length} messages`);
            return null;
        }

        const clampedIdx = Math.max(0, Math.min(pageIdx, pages.length - 1));
        log.debug(`renderPersistentPage: ${pages.length} pages, showing page ${clampedIdx + 1}`);
        return {
            embed: buildPageEmbed(pages[clampedIdx]!, clampedIdx, pages.length),
            total: pages.length,
            pageIdx: clampedIdx,
        };
    } catch (e) {
        log.error(`Failed to fetch session messages for persistent page: session=${sessionId}, offset=${msgOffset}, limit=${msgLimit}: ${e}`);
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
    log(`[${id}] Created pager for thread=${threadId}`);

    return {
        trackRawMessage(sdkMessage: { type: string; uuid?: string }): void {
            if (!state.firstMessageUuid
                && (sdkMessage.type === 'user' || sdkMessage.type === 'assistant')
                && sdkMessage.uuid) {
                state.firstMessageUuid = sdkMessage.uuid;
                log(`[${id}] Captured firstMessageUuid=${sdkMessage.uuid} (type=${sdkMessage.type})`);
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
                    log.debug(`[${id}] +tool_use page=${pageIdx} tool=${toolName}`);
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
                    log.debug(`[${id}] +thinking page=${state.currentPage}`);
                    scheduleUpdate(state);
                    break;
                }
                case 'text': {
                    const text = msg.content.trim();
                    if (text) {
                        state.pages.push({
                            kind: 'text',
                            label: 'Assistant',
                            content: truncatePreview(text, Infinity, 3800),
                            status: 'done',
                        });
                        state.currentPage = state.pages.length - 1;
                        log.debug(`[${id}] +text page=${state.currentPage}`);
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
            log(`[${id}] destroy() called: session=${sessionId}, pages=${state.pages.length}, messageId=${state.messageId}, firstUuid=${state.firstMessageUuid}`);
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
                log(`[${id}] destroy() early exit: messageId=${state.messageId}, pages=${state.pages.length}`);
                activePagers.delete(id);
                return;
            }

            // Switch to persistent SDK-backed buttons
            try {
                const allMessages = await getSessionMessages(sessionId, { dir: workingDir });
                const typedMessages = allMessages as Array<{ type: string; uuid: string; message: unknown }>;
                log(`[${id}] Session has ${typedMessages.length} total messages`);

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
                        log(`[${id}] UUID found at idx=${idx}, msgOffset=${msgOffset}`);
                    } else {
                        log.warn(`[${id}] UUID ${state.firstMessageUuid} not found in session, showing all pages`);
                    }
                }

                // Find the end of this round: the next user text message (non-tool_result)
                // after the offset marks the start of the next round.
                let msgEnd = typedMessages.length;
                for (let i = msgOffset + 1; i < typedMessages.length; i++) {
                    const m = typedMessages[i]!;
                    if (m.type !== 'user') continue;
                    const msg = m.message as Record<string, unknown>;
                    const content = msg.content;
                    // User text message = new round boundary
                    if (typeof content === 'string') {
                        msgEnd = i;
                        break;
                    }
                    if (Array.isArray(content)) {
                        const hasOnlyToolResult = (content as Array<Record<string, unknown>>).every(b => b.type === 'tool_result');
                        if (!hasOnlyToolResult) {
                            msgEnd = i;
                            break;
                        }
                    }
                }
                const msgLimit = msgEnd - msgOffset;
                log(`[${id}] Round boundary: offset=${msgOffset}, end=${msgEnd}, limit=${msgLimit}`);

                const currentRoundMessages = typedMessages.slice(msgOffset, msgEnd);
                const pages = parseSessionPages(currentRoundMessages);
                const total = pages.length;
                const pageIdx = Math.min(state.currentPage, Math.max(0, total - 1));
                log(`[${id}] Parsed ${total} pages from round (Phase 1 had ${state.pages.length}), showing page ${pageIdx}`);

                if (total > 0) {
                    // Show last page without buttons — users can react to restore navigation
                    const lastIdx = total - 1;
                    const embed = buildPageEmbed(pages[lastIdx]!, lastIdx, total);
                    await editRichMessage(state.threadId, state.messageId, {
                        embeds: [embed],
                        components: [],
                    });
                    // Save metadata to DB for reaction-triggered restore
                    savePagerMessage(state.messageId, state.threadId, sessionId, msgOffset, msgLimit, workingDir);
                    log(`[${id}] Finalized (no buttons): session=${sessionId}, offset=${msgOffset}, limit=${msgLimit}, pages=${total}`);
                }

                // Free memory only after successful finalization
                activePagers.delete(id);
                state.pages.length = 0;
                state.toolUseIdToPage.clear();
            } catch (e) {
                log.error(`[${id}] Failed to finalize, keeping Phase 1 buttons alive: ${e}`);
                // Don't delete from activePagers — Phase 1 buttons remain functional
                state.destroyed = false;
            }
        },
    };
}

/** Find the offset/limit for the last round in a session (for auto-upgrade fallback). */
async function findLastRoundBounds(sessionId: string, dir?: string): Promise<{ offset: number; limit: number }> {
    try {
        const allMessages = await getSessionMessages(sessionId, { dir });
        const typedMessages = allMessages as Array<{ type: string; message: unknown }>;

        // Find all round start indices (user text messages that aren't pure tool_result)
        const roundStarts: number[] = [];
        for (let i = 0; i < typedMessages.length; i++) {
            const m = typedMessages[i]!;
            if (m.type !== 'user') continue;
            const msg = m.message as Record<string, unknown>;
            const content = msg.content;
            if (typeof content === 'string') {
                roundStarts.push(i);
            } else if (Array.isArray(content)) {
                const hasOnlyToolResult = (content as Array<Record<string, unknown>>).every(b => b.type === 'tool_result');
                if (!hasOnlyToolResult) {
                    roundStarts.push(i);
                }
            }
        }

        if (roundStarts.length === 0) {
            return { offset: 0, limit: 0 };
        }

        const lastRoundStart = roundStarts[roundStarts.length - 1]!;
        const limit = typedMessages.length - lastRoundStart;
        log(`findLastRoundBounds: session=${sessionId}, rounds=${roundStarts.length}, lastRoundOffset=${lastRoundStart}, limit=${limit}`);
        return { offset: lastRoundStart, limit };
    } catch (e) {
        log.warn(`findLastRoundBounds failed: ${e}`);
        return { offset: 0, limit: 0 };
    }
}

/**
 * Hide pager navigation buttons on a finalized pager message (triggered by reaction removal).
 * Returns true if buttons were hidden, false if message not found or not a pager.
 */
export async function hidePagerButtons(messageId: string): Promise<boolean> {
    const pagerData = getPagerMessage(messageId);
    if (!pagerData) return false;

    try {
        const result = await renderPersistentPage(
            pagerData.session_id, Infinity,
            pagerData.msg_offset, pagerData.msg_limit,
            pagerData.working_dir || undefined,
        );
        if (!result) return false;

        await editRichMessage(pagerData.thread_id, messageId, {
            embeds: [result.embed],
            components: [],
        });
        return true;
    } catch (e) {
        log.error(`Failed to hide pager buttons: ${e}`);
        return false;
    }
}

/**
 * Restore pager navigation buttons on a finalized pager message (triggered by user reaction).
 * Returns true if buttons were restored, false if message not found or no pages.
 */
export async function restorePagerButtons(messageId: string): Promise<boolean> {
    const pagerData = getPagerMessage(messageId);
    if (!pagerData) return false;

    try {
        const result = await renderPersistentPage(
            pagerData.session_id, Infinity,
            pagerData.msg_offset, pagerData.msg_limit,
            pagerData.working_dir || undefined,
        );
        if (!result || result.total <= 1) return false;

        const row = buildPersistentButtons(
            pagerData.session_id, result.pageIdx, result.total,
            pagerData.msg_offset, pagerData.msg_limit,
        );
        await editRichMessage(pagerData.thread_id, messageId, {
            embeds: [result.embed],
            components: [row],
        });
        log(`Restored pager buttons: message=${messageId}, pages=${result.total}`);
        return true;
    } catch (e) {
        log.error(`Failed to restore pager buttons: ${e}`);
        return false;
    }
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
            log(`Phase 1 interaction: pagerId=${pagerId} not found, attempting auto-upgrade`);
            // Defer immediately — auto-upgrade involves SDK calls that may be slow
            await interaction.deferUpdate();
            // State lost (e.g. bot restart) — try to auto-upgrade to Phase 2
            // by looking up the thread's session from DB
            try {
                const threadId = interaction.channelId;
                const mapping = threadId ? getThreadMapping(threadId) : null;
                if (mapping?.session_id) {
                    const dir = mapping.working_dir || undefined;
                    // Find the last round's offset/limit for scoped page display
                    const { offset, limit } = await findLastRoundBounds(mapping.session_id, dir);
                    const result = await renderPersistentPage(mapping.session_id, Infinity, offset, limit, dir);
                    if (result) {
                        const row = buildPersistentButtons(mapping.session_id, result.pageIdx, result.total, offset, limit);
                        await interaction.editReply({ embeds: [result.embed], components: [row] });
                        log(`Phase 1→2 auto-upgrade: thread=${threadId}, session=${mapping.session_id}, offset=${offset}, limit=${limit}, pages=${result.total}`);
                        return true;
                    }
                }
            } catch (e) {
                log.warn(`Phase 1→2 auto-upgrade failed: ${e}`);
            }
            return true;
        }

        if (action === 'prev' && state.currentPage > 0) {
            state.currentPage--;
        } else if (action === 'next' && state.currentPage < state.pages.length - 1) {
            state.currentPage++;
        }
        log.debug(`Phase 1 navigation: pagerId=${pagerId}, action=${action}, page=${state.currentPage + 1}/${state.pages.length}`);

        try {
            const embed = buildLiveEmbed(state);
            const row = buildLiveButtons(state.id, state.currentPage, state.pages.length);
            await interaction.update({ embeds: [embed], components: [row] });
        } catch (e) {
            log.error(`Failed to handle live pager interaction: pagerId=${pagerId}, action=${action}: ${e}`);
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

        // Defer immediately to avoid Discord's 3-second interaction timeout
        // (SDK getSessionMessages can be slow on cold file cache)
        await interaction.deferUpdate();

        try {
            const threadId = interaction.channelId;
            const mapping = threadId ? getThreadMapping(threadId) : null;
            const dir = mapping?.working_dir || undefined;
            log.debug(`Phase 2 interaction: session=${sessionId}, offset=${msgOffset}, limit=${msgLimit}, page=${pageIdx}, action=${action}`);
            const result = await renderPersistentPage(sessionId, pageIdx, msgOffset, msgLimit, dir);
            if (result) {
                const row = buildPersistentButtons(sessionId, result.pageIdx, result.total, msgOffset, msgLimit);
                await interaction.editReply({
                    embeds: [result.embed],
                    components: [row],
                });
            } else {
                log.warn(`Persistent pager: no pages found for session=${sessionId}, offset=${msgOffset}, limit=${msgLimit}, dir=${dir}`);
                await interaction.editReply({
                    embeds: [{ color: 0xed4245, description: 'Session data not found.' }],
                    components: [],
                });
            }
        } catch (e) {
            log.error(`Failed to handle persistent pager interaction: ${e}`);
        }
        return true;
    }

    return false;
}
