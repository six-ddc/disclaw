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
import type { ActionRowBuilder, ButtonBuilder, ButtonInteraction } from 'discord.js';
import { sendRichMessage, editRichMessage, truncateCodePoints, buildPaginationRow, splitMarkdown, type EmbedData } from './discord.js';
import { getThreadMapping, savePagerMessage, getPagerMessage } from './db.js';
import {
    escapeCodeBlock, formatToolName, truncateContent, cleanContent,
    buildToolUseEmbed, buildToolResultField, TOOL_RESULT_COLOR, TOOL_DONE_COLOR,
} from './tool-embeds.js';
import { createLogger } from './logger.js';

const log = createLogger('pager');

// =========================================================================
// Types
// =========================================================================

type PageKind = 'tool' | 'thinking' | 'text' | 'task' | 'alert';

interface PagerPage {
    kind: PageKind;
    /** Display label for non-tool pages: "Thinking", "Assistant" */
    label: string;
    /** For tool/task/alert pages: pre-built embed (title, color, fields) */
    toolEmbed?: EmbedData;
    /** For non-tool pages: text content rendered as embed description */
    content?: string;
    /** Tool result content string (composed into embed on render) */
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
// Pager-specific helpers
// =========================================================================

/** Truncate content for pager display (wraps shared truncateContent) */
function truncatePreview(content: string, maxLines = 10, maxChars = 800): string {
    const { preview, isTruncated, totalLines } = truncateContent(content, maxLines, maxChars);
    const remaining = totalLines - maxLines;
    return isTruncated && remaining > 0 ? `${preview}\n(+${remaining} more lines)` : preview;
}

// =========================================================================
// Page rendering (shared by Phase 1 and Phase 2)
// =========================================================================

/** Colors for page kinds that don't carry their own embed (thinking/text only) */
const PAGE_COLORS: Partial<Record<PageKind, number>> = {
    thinking: 0x9b59b6,
    text:     0x2ecc71,
};

const PAGE_ICONS: Partial<Record<PageKind, string>> = {
    thinking: '💭',
    text: '💬',
};

function buildPageEmbed(page: PagerPage, pageIdx: number, total: number): EmbedData {
    if (page.toolEmbed) {
        // Clone the base embed and append pagination
        const embed: EmbedData = {
            ...page.toolEmbed,
            fields: page.toolEmbed.fields ? [...page.toolEmbed.fields] : [],
        };

        // Tool pages: append result field and update color
        if (page.kind === 'tool') {
            if (page.result) {
                const r = buildToolResultField(page.result);
                embed.fields!.push(r.field);
            } else if (page.status === 'done') {
                const r = buildToolResultField('');
                embed.fields!.push(r.field);
            }
            if (page.status === 'done') {
                embed.color = page.result ? TOOL_RESULT_COLOR : TOOL_DONE_COLOR;
            }
        }

        // title unchanged — page number shown in navigation buttons only
        return embed;
    }

    // Thinking / text pages — simple description embed
    const icon = PAGE_ICONS[page.kind] ?? '📋';
    let description = page.content || '';
    if (description.length > 4000) {
        description = truncateCodePoints(description, 4000);
    }

    return {
        color: PAGE_COLORS[page.kind] ?? 0x0099ff,
        title: `${icon} ${page.label}`,
        description,
    };
}

// =========================================================================
// Buttons
// =========================================================================

function buildLiveButtons(id: string, currentPage: number, total: number) {
    return buildPaginationRow(currentPage, total, `pager:${id}`);
}

/** Button ID format: pgr:<sessionId>:<msgOffset>:<msgLimit>:<pageIdx>:<action> */
function buildPersistentButtons(
    sessionId: string, pageIdx: number, total: number,
    msgOffset: number, msgLimit: number,
) {
    return buildPaginationRow(pageIdx, total, `pgr:${sessionId}:${msgOffset}:${msgLimit}:${pageIdx}`);
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
    /** Map taskId → page index for merging task_progress/task_notification */
    taskIdToPage: Map<string, number>;
    updateTimer: ReturnType<typeof setTimeout> | null;
    pendingUpdate: boolean;
    flushing: Promise<void> | null;
    destroyed: boolean;
    /** UUID of the first user/assistant SDK message in this round */
    firstMessageUuid: string | null;
}

const activePagers = new Map<string, LivePagerState>();
let pagerCounter = 0;

/** Build the send/edit payload for the current page (text pages use content, others use embeds) */
function buildPagePayload(page: PagerPage, pageIdx: number, total: number, components: ActionRowBuilder<ButtonBuilder>[]) {
    if (page.kind === 'text') {
        return { content: page.content || '', embeds: [], components };
    }
    return { content: '', embeds: [buildPageEmbed(page, pageIdx, total)], components };
}

async function doFlush(state: LivePagerState): Promise<void> {
    state.pendingUpdate = false;
    if (state.pages.length === 0) return;

    const page = state.pages[state.currentPage]!;
    const action = state.messageId ? 'edit' : 'send';
    log.debug(`[${state.id}] doFlush: ${action}, page=${state.currentPage}/${state.pages.length}`);

    try {
        const components = state.pages.length > 1
            ? [buildLiveButtons(state.id, state.currentPage, state.pages.length)]
            : [];
        const payload = buildPagePayload(page, state.currentPage, state.pages.length, components);
        if (!state.messageId) {
            state.messageId = await sendRichMessage(state.threadId, payload, true);
            log(`[${state.id}] Initial message sent: messageId=${state.messageId}`);
        } else {
            await editRichMessage(state.threadId, state.messageId, payload);
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
                    const chunks = splitMarkdown(text, 3800);
                    for (const chunk of chunks) {
                        pages.push({
                            kind: 'text',
                            label: 'Assistant',
                            content: chunk,
                            status: 'done',
                        });
                    }
                }
            } else if (block.type === 'tool_use') {
                const toolName = block.name || 'Unknown';
                const toolInput = (block.input || {}) as Record<string, unknown>;
                const pageIdx = pages.length;
                pages.push({
                    kind: 'tool',
                    label: formatToolName(toolName),
                    toolEmbed: buildToolUseEmbed(toolName, toolInput),
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
): Promise<{ page: PagerPage; total: number; pageIdx: number } | null> {
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
            page: pages[clampedIdx]!,
            total: pages.length,
            pageIdx: clampedIdx,
        };
    } catch (e) {
        log.error(`Failed to fetch session messages for persistent page: session=${sessionId}, offset=${msgOffset}, limit=${msgLimit}: ${e}`);
        return null;
    }
}

// =========================================================================
// Per-thread last pager tracking (like scheduleStatusDelete in discord-sender)
// When a new pager appears, immediately strip buttons from the previous one.
// On finalize, keep buttons for 30s then auto-strip.
// =========================================================================

const lastPagerMessage = new Map<string, { messageId: string; threadId: string; timer: ReturnType<typeof setTimeout> }>();

function schedulePagerButtonRemoval(threadId: string, messageId: string): void {
    // Immediately strip buttons from previous pager in this thread
    const prev = lastPagerMessage.get(threadId);
    if (prev) {
        clearTimeout(prev.timer);
        editRichMessage(prev.threadId, prev.messageId, { components: [] }).catch(() => {});
    }
    // Auto-strip buttons from this pager after 30s
    const timer = setTimeout(() => {
        lastPagerMessage.delete(threadId);
        editRichMessage(threadId, messageId, { components: [] }).catch(() => {});
    }, 30_000);
    lastPagerMessage.set(threadId, { messageId, threadId, timer });
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
        taskIdToPage: new Map(),
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
                    const { name: toolName, toolUseId, input: toolInput } = msg;

                    const pageIdx = state.pages.length;
                    state.pages.push({
                        kind: 'tool',
                        label: formatToolName(toolName),
                        toolEmbed: buildToolUseEmbed(toolName, toolInput),
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
                    const { toolUseId } = msg;
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
                        const chunks = splitMarkdown(text, 3800);
                        for (const chunk of chunks) {
                            state.pages.push({
                                kind: 'text',
                                label: 'Assistant',
                                content: chunk,
                                status: 'done',
                            });
                        }
                        state.currentPage = state.pages.length - 1;
                        log.debug(`[${id}] +text page=${state.currentPage}`);
                        scheduleUpdate(state);
                    }
                    break;
                }
                case 'tool_progress':
                case 'tool_summary': {
                    scheduleUpdate(state);
                    break;
                }

                case 'task_started': {
                    // Link taskId → Agent tool page (don't create a separate page)
                    const { taskId, toolUseId } = msg;
                    const pageIdx = toolUseId ? state.toolUseIdToPage.get(toolUseId) : undefined;
                    if (taskId && pageIdx !== undefined) {
                        state.taskIdToPage.set(taskId, pageIdx);
                        log(`[${id}] task_started: linked taskId=${taskId} → page=${pageIdx} (Agent toolUseId=${toolUseId})`);
                    } else {
                        log.warn(`[${id}] task_started: no Agent page found for toolUseId=${toolUseId}, taskId=${taskId}`);
                    }
                    break;
                }

                case 'task_progress': {
                    const { taskId, toolUseId, summary, lastToolName, usage } = msg;
                    // Resolve page: prefer taskId map, fall back to toolUseId
                    const pageIdx = (taskId ? state.taskIdToPage.get(taskId) : undefined)
                        ?? (toolUseId ? state.toolUseIdToPage.get(toolUseId) : undefined);
                    const page = pageIdx !== undefined ? state.pages[pageIdx] : undefined;

                    if (page?.toolEmbed) {
                        let desc = summary || msg.content || '';
                        const parts: string[] = [];
                        if (lastToolName) parts.push(`Last tool: \`${formatToolName(lastToolName)}\``);
                        if (usage?.duration_ms) parts.push(`${(usage.duration_ms / 1000).toFixed(1)}s`);
                        if (usage?.tool_uses) parts.push(`${usage.tool_uses} tool calls`);
                        if (parts.length > 0) desc += `\n*${parts.join(' · ')}*`;
                        page.toolEmbed.description = truncateCodePoints(desc, 2000);
                        log.debug(`[${id}] task_progress updated page=${pageIdx} taskId=${taskId}`);
                        scheduleUpdate(state);
                    }
                    break;
                }

                case 'task_notification': {
                    const { taskId, toolUseId, status, summary, usage } = msg;
                    const pageIdx = (taskId ? state.taskIdToPage.get(taskId) : undefined)
                        ?? (toolUseId ? state.toolUseIdToPage.get(toolUseId) : undefined);
                    const page = pageIdx !== undefined ? state.pages[pageIdx] : undefined;

                    if (page?.toolEmbed) {
                        // Add usage as a compact description suffix
                        const parts: string[] = [];
                        if (usage?.duration_ms) parts.push(`${(usage.duration_ms / 1000).toFixed(1)}s`);
                        if (usage?.tool_uses) parts.push(`${usage.tool_uses} tool calls`);
                        if (usage?.total_tokens) parts.push(`${usage.total_tokens.toLocaleString()} tokens`);
                        const usageLine = parts.length > 0 ? `\n*${parts.join(' · ')}*` : '';

                        if (status === 'completed') {
                            page.toolEmbed.description = (summary || '') + usageLine;
                        } else {
                            const statusEmoji = status === 'failed' ? '❌' : '⏹️';
                            page.toolEmbed.description = `${statusEmoji} ${status}: ${summary || msg.content || 'No details'}${usageLine}`;
                        }
                        log(`[${id}] task_notification merged into page=${pageIdx} taskId=${taskId} status=${status}`);
                    } else {
                        log.warn(`[${id}] task_notification: no page found for taskId=${taskId} toolUseId=${toolUseId}`);
                    }
                    scheduleUpdate(state);
                    break;
                }

                case 'permission_denied': {
                    const { toolName, toolInput } = msg;
                    const inputPreview = JSON.stringify(toolInput, null, 2);
                    const { preview } = truncateContent(inputPreview, 6, 500);

                    state.pages.push({
                        kind: 'alert',
                        label: 'Permission Denied',
                        toolEmbed: {
                            color: 0xff4444,
                            title: `🚫 Permission Denied: \`${formatToolName(toolName)}\``,
                            description: 'Tool blocked by current permission mode.',
                            fields: [
                                { name: 'Tool', value: `\`${toolName}\``, inline: true },
                                { name: 'Input', value: `\`\`\`json\n${escapeCodeBlock(preview)}\n\`\`\``, inline: false },
                            ],
                        },
                        status: 'done',
                    });
                    state.currentPage = state.pages.length - 1;
                    log.debug(`[${id}] +permission_denied page=${state.currentPage} tool=${toolName}`);
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
                    // Show last page with persistent buttons — auto-strip after 30s
                    const lastIdx = total - 1;
                    const row = total > 1
                        ? buildPersistentButtons(sessionId, lastIdx, total, msgOffset, msgLimit)
                        : null;
                    const payload = buildPagePayload(pages[lastIdx]!, lastIdx, total, row ? [row] : []);
                    await editRichMessage(state.threadId, state.messageId, payload);
                    // Save metadata to DB for reaction-triggered restore
                    savePagerMessage(state.messageId, state.threadId, sessionId, msgOffset, msgLimit, workingDir);
                    // Schedule button removal (30s) — or immediately if next pager appears
                    if (row) {
                        schedulePagerButtonRemoval(state.threadId, state.messageId);
                    }
                    log(`[${id}] Finalized (buttons, 30s auto-strip): session=${sessionId}, offset=${msgOffset}, limit=${msgLimit}, pages=${total}`);
                }

                // Free memory only after successful finalization
                activePagers.delete(id);
                state.pages.length = 0;
                state.toolUseIdToPage.clear();
                state.taskIdToPage.clear();
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

        const payload = buildPagePayload(result.page, result.pageIdx, result.total, []);
        await editRichMessage(pagerData.thread_id, messageId, payload);
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
        const payload = buildPagePayload(result.page, result.pageIdx, result.total, [row]);
        await editRichMessage(pagerData.thread_id, messageId, payload);
        log(`Restored pager buttons: message=${messageId}, pages=${result.total}`);
        return true;
    } catch (e) {
        log.error(`Failed to restore pager buttons: ${e}`);
        return false;
    }
}

/** Parsed persistent pager button ID */
interface PagerButtonId {
    sessionId: string;
    msgOffset: number;
    msgLimit: number;
    pageIdx: number;
    action: string;
}

/**
 * Parse a persistent pager button custom ID (pgr:...) into a typed result.
 * Supports two formats:
 *   Current: pgr:<sessionId>:<msgOffset>:<msgLimit>:<pageIdx>:<action>
 *   Legacy:  pgr:<sessionId>:<pageIdx>:<action>  (offset=0, limit=0)
 * Returns null if the format is invalid.
 */
function parsePagerButtonId(customId: string): PagerButtonId | null {
    const parts = customId.split(':');

    if (parts.length >= 6) {
        // Current format: pgr:<sessionId>:<msgOffset>:<msgLimit>:<pageIdx>:<action>
        const msgOffset = parseInt(parts[2]!, 10);
        const msgLimit = parseInt(parts[3]!, 10);
        const pageIdx = parseInt(parts[4]!, 10);
        if (isNaN(pageIdx) || isNaN(msgOffset) || isNaN(msgLimit)) return null;
        return { sessionId: parts[1]!, msgOffset, msgLimit, pageIdx, action: parts[5]! };
    }

    if (parts.length >= 4) {
        // Legacy format: pgr:<sessionId>:<pageIdx>:<action>  (no offset/limit, fetch all)
        const pageIdx = parseInt(parts[2]!, 10);
        if (isNaN(pageIdx)) return null;
        return { sessionId: parts[1]!, msgOffset: 0, msgLimit: 0, pageIdx, action: parts[3]! };
    }

    return null;
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
                        const payload = buildPagePayload(result.page, result.pageIdx, result.total, [row]);
                        await interaction.editReply(payload);
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
            const page = state.pages[state.currentPage]!;
            const row = buildLiveButtons(state.id, state.currentPage, state.pages.length);
            const payload = buildPagePayload(page, state.currentPage, state.pages.length, [row]);
            await interaction.update(payload);
        } catch (e) {
            log.error(`Failed to handle live pager interaction: pagerId=${pagerId}, action=${action}: ${e}`);
        }
        return true;
    }

    // Phase 2: Persistent SDK-backed buttons
    if (customId.startsWith('pgr:')) {
        const parsed = parsePagerButtonId(customId);
        if (!parsed) return false;

        let { sessionId, msgOffset, msgLimit, pageIdx, action } = parsed;

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
                const payload = buildPagePayload(result.page, result.pageIdx, result.total, [row]);
                await interaction.editReply(payload);
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
