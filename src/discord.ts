/**
 * Discord utilities - Helper functions for posting to Discord
 *
 * Uses discord.js client for all REST calls, getting built-in
 * rate limit handling, queuing, and retry logic for free.
 */

import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, Routes } from 'discord.js';
import type { Client, TextChannel } from 'discord.js';
import { createLogger } from './logger.js';

const log = createLogger('discord');

let client: Client | null = null;

/**
 * Wrap bare URLs in <> to suppress Discord link previews.
 * Skips URLs inside code blocks and URLs already wrapped in <>.
 */
function wrapUrls(text: string): string {
    // Split into code-block and non-code-block segments
    const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
    return parts.map((part, i) => {
        // Odd indices are code blocks — leave untouched
        if (i % 2 === 1) return part;
        // Replace bare URLs not already in <>
        return part.replace(/(?<!<)(https?:\/\/[^\s>)\]]+)/g, '<$1>');
    }).join('');
}

/** When true, wrap bare URLs in <> to suppress link preview cards */
const suppressLinkPreviews = process.env.SHOW_LINK_PREVIEWS === '1'  ? false : true;

/** Initialize with the discord.js client instance. Must be called before any send functions. */
export function initDiscord(c: Client) {
    client = c;
    log('Discord client initialized');
}

/** Get a text channel by ID. Throws if client not initialized or channel not sendable. */
async function getChannel(channelId: string): Promise<TextChannel> {
    if (!client) {
        log.error(`Discord client not initialized when fetching channel ${channelId}`);
        throw new Error('Discord client not initialized — call initDiscord() first');
    }
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !('send' in channel)) {
        log.error(`Channel ${channelId} is not a sendable text channel`);
        throw new Error(`Channel ${channelId} is not a sendable text channel`);
    }
    return channel as TextChannel;
}

/**
 * Truncate a string by code points (not UTF-16 code units) to avoid
 * splitting surrogate pairs (emoji, CJK extensions, etc.).
 * Appends a suffix (default "...") when truncated.
 */
export function truncateCodePoints(text: string, max: number, suffix = '...'): string {
    if (text.length <= max) return text;
    // Truncate by UTF-16 length (what Discord counts) while avoiding
    // splitting surrogate pairs (chars outside BMP like emoji)
    const limit = max - suffix.length;
    let end = limit;
    // If we'd split a surrogate pair, step back one unit
    if (end > 0 && end < text.length) {
        const code = text.charCodeAt(end - 1);
        if (code >= 0xD800 && code <= 0xDBFF) end--;
    }
    return text.slice(0, end) + suffix;
}

/**
 * Convert markdown tables to card-style key-value format.
 * Discord has no table rendering, so each data row becomes a card
 * with **Header**: value pairs, separated by horizontal lines.
 * Skips tables inside code blocks.
 */
export function flattenTables(text: string): string {
    const lines = text.split('\n');
    const result: string[] = [];
    let i = 0;
    let inCodeBlock = false;
    const tableSepRe = /^[\s|:\-]+$/;

    while (i < lines.length) {
        const line = lines[i]!;
        const stripped = line.trim();

        if (stripped.startsWith('```')) {
            inCodeBlock = !inCodeBlock;
            result.push(line);
            i++;
            continue;
        }

        if (inCodeBlock) {
            result.push(line);
            i++;
            continue;
        }

        // Check if this looks like a table header row
        if (stripped.startsWith('|') && stripped.endsWith('|') && stripped.indexOf('|', 1) < stripped.length - 1) {
            const splitRow = (row: string): string[] => {
                const content = row.trim().replace(/^\||\|$/g, '');
                return content.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
            };

            const headers = splitRow(stripped);

            // Next line must be separator (---|---|---)
            if (i + 1 < lines.length) {
                const sepLine = lines[i + 1]!.trim();
                if (sepLine.startsWith('|') && tableSepRe.test(sepLine)) {
                    i += 2; // Skip header + separator
                    const rows: string[][] = [];
                    while (i < lines.length) {
                        const dataLine = lines[i]!.trim();
                        if (dataLine.startsWith('|') && dataLine.endsWith('|')) {
                            rows.push(splitRow(dataLine));
                            i++;
                        } else {
                            break;
                        }
                    }

                    // Build card-style output
                    const separator = '────────────';
                    const cards: string[] = [];
                    for (const row of rows) {
                        const cardLines: string[] = [];
                        for (let j = 0; j < headers.length; j++) {
                            const header = headers[j]!;
                            const value = (j < row.length ? row[j] : '') || '—';
                            cardLines.push(`**${header}**: ${value}`);
                        }
                        cards.push(cardLines.join('\n'));
                    }
                    result.push(cards.join(`\n${separator}\n`));
                    continue;
                }
            }
        }

        result.push(line);
        i++;
    }

    return result.join('\n');
}

export function splitMarkdown(text: string, maxLen = 2000): string[] {
    // Flatten tables before splitting since Discord doesn't render them
    text = flattenTables(text);
    if (text.length <= maxLen) {
        log.debug(`Markdown fits in single chunk (${text.length} chars), no split needed`);
        return [text];
    }
    log.debug(`Splitting markdown into multiple chunks (${text.length} chars, maxLen=${maxLen})`);

    // ---- Step 1: Parse into segments ----

    interface Segment {
        kind: 'text' | 'code';
        raw: string;         // full text including fences for code
        lang: string;        // language tag (code only)
        body: string;        // inner body (code only)
    }

    const segments: Segment[] = [];
    // Match fenced code blocks: ```lang\n…\n```
    const fenceRe = /^(`{3,})([^\n]*)\n([\s\S]*?)\n\1/gm;
    let cursor = 0;

    for (const m of text.matchAll(fenceRe)) {
        const start = m.index!;
        // Push any plain text before this code block
        if (start > cursor) {
            segments.push({ kind: 'text', raw: text.slice(cursor, start), lang: '', body: '' });
        }
        segments.push({
            kind: 'code',
            raw: m[0],
            lang: m[2] || '',
            body: m[3] || '',
        });
        cursor = start + m[0].length;
    }
    // Trailing plain text
    if (cursor < text.length) {
        segments.push({ kind: 'text', raw: text.slice(cursor), lang: '', body: '' });
    }

    // ---- Step 2 & 3: Pack into chunks ----

    const chunks: string[] = [];
    let current = '';

    const flush = () => {
        const trimmed = current.trim();
        if (trimmed) chunks.push(trimmed);
        current = '';
    };

    /** Split plain text at newline / space boundaries, surrogate-safe */
    const splitPlain = (plain: string): string[] => {
        const parts: string[] = [];
        let rem = plain;
        while (rem.length > maxLen) {
            let splitAt = rem.lastIndexOf('\n', maxLen);
            if (splitAt === -1 || splitAt < maxLen / 2) {
                splitAt = rem.lastIndexOf(' ', maxLen);
            }
            if (splitAt === -1 || splitAt < maxLen / 2) {
                splitAt = maxLen;
                const code = rem.charCodeAt(splitAt - 1);
                if (code >= 0xD800 && code <= 0xDBFF) splitAt--;
            }
            parts.push(rem.slice(0, splitAt));
            rem = rem.slice(splitAt).trimStart();
        }
        if (rem) parts.push(rem);
        return parts;
    };

    /** Split a code block body, re-wrapping each piece in fences */
    const splitCodeBlock = (lang: string, body: string): string[] => {
        const fence = '```';
        const open = `${fence}${lang}\n`;
        const close = `\n${fence}`;
        // Available space for body text per chunk
        const overhead = open.length + close.length;
        const bodyMax = maxLen - overhead;
        if (bodyMax <= 0) {
            // Extreme edge case: maxLen is tiny; just hard-wrap
            return [`${open}${body.slice(0, maxLen - overhead - 3)}...${close}`];
        }

        const parts: string[] = [];
        let rem = body;
        while (rem.length > bodyMax) {
            // Prefer splitting at newline within body
            let splitAt = rem.lastIndexOf('\n', bodyMax);
            if (splitAt === -1 || splitAt < bodyMax / 2) {
                splitAt = bodyMax;
                const code = rem.charCodeAt(splitAt - 1);
                if (code >= 0xD800 && code <= 0xDBFF) splitAt--;
            }
            parts.push(`${open}${rem.slice(0, splitAt)}${close}`);
            rem = rem.slice(splitAt);
            // Don't trimStart here — preserve leading whitespace in code
        }
        if (rem) parts.push(`${open}${rem}${close}`);
        return parts;
    };

    for (const seg of segments) {
        if (seg.kind === 'text') {
            // Try appending to current chunk
            if ((current + seg.raw).length <= maxLen) {
                current += seg.raw;
            } else {
                // Flush what we have, then split this text segment
                flush();
                const parts = splitPlain(seg.raw);
                for (let i = 0; i < parts.length; i++) {
                    if (i < parts.length - 1) {
                        chunks.push(parts[i]!.trim());
                    } else {
                        // Last part becomes the start of next chunk
                        current = parts[i]!;
                    }
                }
            }
        } else {
            // Code block
            if ((current + seg.raw).length <= maxLen) {
                current += seg.raw;
            } else {
                flush();
                if (seg.raw.length <= maxLen) {
                    current = seg.raw;
                } else {
                    // Code block too large — split body with re-fencing
                    const parts = splitCodeBlock(seg.lang, seg.body);
                    for (let i = 0; i < parts.length; i++) {
                        if (i < parts.length - 1) {
                            chunks.push(parts[i]!.trim());
                        } else {
                            current = parts[i]!;
                        }
                    }
                }
            }
        }
    }
    flush();

    log.debug(`Markdown split complete: ${chunks.length} chunks from ${text.length} chars`);
    return chunks;
}

/**
 * Build a standard ◀ / info / ▶ pagination button row.
 *
 * @param currentPage  Zero-based current page index
 * @param totalPages   Total number of pages
 * @param idPrefix     Custom ID prefix for buttons (e.g. "pager:p1", "history:abc")
 * @param options      Optional overrides: labels, whether to show info button, extra buttons
 */
export function buildPaginationRow(
    currentPage: number,
    totalPages: number,
    idPrefix: string,
    options?: {
        prevLabel?: string;
        nextLabel?: string;
        prevEmoji?: string;
        nextEmoji?: string;
        /** Show a disabled info button with "N / M" between prev/next (default: true) */
        showInfo?: boolean;
        /** Extra buttons prepended before the nav buttons */
        extraButtonsBefore?: ButtonBuilder[];
        /** Extra buttons appended after the nav buttons */
        extraButtonsAfter?: ButtonBuilder[];
    },
): ActionRowBuilder<ButtonBuilder> {
    const {
        prevLabel, nextLabel,
        prevEmoji = prevLabel ? undefined : '◀',
        nextEmoji = nextLabel ? undefined : '▶',
        showInfo = true,
        extraButtonsBefore = [],
        extraButtonsAfter = [],
    } = options ?? {};

    const prev = new ButtonBuilder()
        .setCustomId(`${idPrefix}:prev`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage <= 0);
    if (prevEmoji) prev.setEmoji(prevEmoji);
    if (prevLabel) prev.setLabel(prevLabel);

    const next = new ButtonBuilder()
        .setCustomId(`${idPrefix}:next`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage >= totalPages - 1);
    if (nextEmoji) next.setEmoji(nextEmoji);
    if (nextLabel) next.setLabel(nextLabel);

    const buttons: ButtonBuilder[] = [...extraButtonsBefore, prev];

    if (showInfo) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`${idPrefix}:info`)
                .setLabel(`${currentPage + 1} / ${totalPages}`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
        );
    }

    buttons.push(next, ...extraButtonsAfter);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

/** Embed data structure for Discord API */
export interface EmbedData {
    color?: number;
    title?: string;
    description?: string;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    footer?: { text: string };
    image?: { url: string };
    thumbnail?: { url: string };
}

/**
 * Send a message to a Discord thread.
 * Splits long messages using markdown-aware chunking to preserve code blocks.
 */
export async function sendToThread(threadId: string, content: string, quiet?: boolean): Promise<void> {
    if (!content.trim()) {
        log.debug(`Skipping empty message for thread ${threadId}`);
        return;
    }
    const channel = await getChannel(threadId);
    const chunks = splitMarkdown(content, 2000);
    log.debug(`Sending message to thread ${threadId} (${content.length} chars, ${chunks.length} chunks)`);
    for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        const text = suppressLinkPreviews ? wrapUrls(chunk) : chunk;
        await channel.send(quiet ? { content: text, flags: MessageFlags.SuppressNotifications } : text);
    }
    log(`Message sent to thread ${threadId} (${content.length} chars, ${chunks.length} chunks)`);
}

/**
 * Send embed messages to a Discord thread. Returns the Discord message ID.
 */
export async function sendEmbed(threadId: string, embeds: EmbedData[], quiet?: boolean): Promise<string> {
    const channel = await getChannel(threadId);
    const msg = await channel.send({ embeds, ...(quiet ? { flags: MessageFlags.SuppressNotifications } : {}) });
    log(`Embed sent to thread ${threadId} (messageId=${msg.id}, ${embeds.length} embeds)`);
    return msg.id;
}

/**
 * Edit an embed message by ID
 */
export async function editEmbed(channelId: string, messageId: string, embeds: EmbedData[]): Promise<void> {
    const channel = await getChannel(channelId);
    await channel.messages.edit(messageId, { embeds });
    log.debug(`Embed edited (channelId=${channelId}, messageId=${messageId}, ${embeds.length} embeds)`);
}

/**
 * Edit a message in a channel/thread.
 * Applies the same content processing as sendToThread (table flattening, URL wrapping).
 */
export async function editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    if (!content.trim()) {
        log.debug(`Skipping empty edit for message ${messageId} in ${channelId}`);
        return;
    }
    let processed = flattenTables(content);
    if (suppressLinkPreviews) processed = wrapUrls(processed);
    if (processed.length > 2000) {
        processed = truncateCodePoints(processed, 2000);
    }
    const channel = await getChannel(channelId);
    await channel.messages.edit(messageId, processed);
    log.debug(`Message edited (channelId=${channelId}, messageId=${messageId}, ${processed.length} chars)`);
}

/**
 * Rename a thread
 */
export async function renameThread(threadId: string, name: string): Promise<void> {
    if (!client) {
        log.error(`Discord client not initialized when renaming thread ${threadId}`);
        throw new Error('Discord client not initialized — call initDiscord() first');
    }
    const channel = await client.channels.fetch(threadId);
    if (channel?.isThread()) {
        await channel.setName(name);
        log(`Thread renamed (threadId=${threadId}, name=${name})`);
    } else {
        log.warn(`Cannot rename: channel ${threadId} is not a thread`);
    }
}

/**
 * Send a rich message (embeds + components) to a channel. Returns the message ID.
 */
export async function sendRichMessage(channelId: string, payload: Parameters<TextChannel['send']>[0], quiet?: boolean): Promise<string> {
    const channel = await getChannel(channelId);
    if (quiet && typeof payload === 'object' && !('body' in payload)) {
        (payload as Record<string, unknown>).flags = MessageFlags.SuppressNotifications;
    }
    const msg = await channel.send(payload);
    log(`Rich message sent (channelId=${channelId}, messageId=${msg.id})`);
    return msg.id;
}

/**
 * Edit a rich message (embeds + components) by ID.
 */
export async function editRichMessage(channelId: string, messageId: string, payload: import('discord.js').MessageEditOptions): Promise<void> {
    const channel = await getChannel(channelId);
    await channel.messages.edit(messageId, payload);
    log.debug(`Rich message edited (channelId=${channelId}, messageId=${messageId})`);
}

/**
 * Add a reaction emoji to a message
 */
export async function deleteMessage(channelId: string, messageId: string): Promise<void> {
    try {
        const channel = await getChannel(channelId);
        await channel.messages.delete(messageId);
        log.debug(`Message deleted (channelId=${channelId}, messageId=${messageId})`);
    } catch (e) {
        log.debug(`Failed to delete message (channelId=${channelId}, messageId=${messageId}): ${e}`);
    }
}

/**
 * Schedule a message for deletion after a delay.
 * Fire-and-forget — failures are silently ignored.
 */
export function scheduleDelete(channelId: string, messageId: string, delayMs = 10_000): void {
    setTimeout(() => {
        deleteMessage(channelId, messageId).catch(() => {});
    }, delayMs);
}

export async function addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await getChannel(channelId);
    await channel.messages.react(messageId, emoji);
    log.debug(`Reaction added (channelId=${channelId}, messageId=${messageId}, emoji=${emoji})`);
}

/**
 * Remove the bot's own reaction from a message
 */
/**
 * Send an image embedded in a rich embed to a Discord thread. Returns the message ID.
 * Always attaches the file and uses attachment:// protocol for reliable rendering.
 * - URL source: downloads to temp file first, then attaches
 * - Local file: attaches directly
 */
export async function sendImageEmbed(threadId: string, source: string, options?: {
    title?: string;
    description?: string;
    color?: number;
}): Promise<string> {
    const channel = await getChannel(threadId);
    const isUrl = /^https?:\/\//.test(source);

    let filePath: string;
    let tmpPath: string | undefined;

    if (isUrl) {
        const filename = source.split('/').pop()?.split('?')[0] || 'image.png';
        tmpPath = join(tmpdir(), `disclaw-${Date.now()}-${filename}`);
        log.debug(`Downloading image URL to temp file: ${source} → ${tmpPath}`);
        const res = await fetch(source);
        if (!res.ok) throw new Error(`Failed to fetch image: ${res.status} ${res.statusText}`);
        if (!res.body) throw new Error('Response body is empty');
        await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), createWriteStream(tmpPath));
        filePath = tmpPath;
    } else {
        filePath = source;
    }

    const filename = filePath.split('/').pop() || 'image.png';
    const embed: EmbedData = {
        color: options?.color ?? 0x5865f2,
        image: { url: `attachment://${filename}` },
        ...(options?.title ? { title: options.title } : {}),
        ...(options?.description ? { description: options.description } : {}),
    };

    try {
        const msg = await channel.send({
            embeds: [embed],
            files: [{ attachment: filePath, name: filename }],
        });
        log(`Image embed sent to thread ${threadId} (source=${isUrl ? 'url' : 'file'}, messageId=${msg.id})`);
        return msg.id;
    } finally {
        if (tmpPath) unlink(tmpPath).catch(() => {});
    }
}

/**
 * Send an audio or video to a Discord thread with native inline player.
 * Discord only renders players for file attachments, not arbitrary URLs.
 * - URL source: streams to temp file, sends as attachment, then cleans up
 * - Local file: sends directly as attachment
 */
export async function sendMediaAttachment(threadId: string, source: string, options?: {
    content?: string;
}): Promise<string> {
    const channel = await getChannel(threadId);
    const isUrl = /^https?:\/\//.test(source);

    let msg;
    if (isUrl) {
        // Stream to temp file — avoids holding large video in memory
        const filename = source.split('/').pop()?.split('?')[0] || 'media';
        const tmpPath = join(tmpdir(), `disclaw-${Date.now()}-${filename}`);
        log.debug(`Streaming media URL to temp file: ${source} → ${tmpPath}`);

        const res = await fetch(source);
        if (!res.ok) throw new Error(`Failed to fetch media: ${res.status} ${res.statusText}`);
        if (!res.body) throw new Error('Response body is empty');

        await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), createWriteStream(tmpPath));

        try {
            msg = await channel.send({
                ...(options?.content ? { content: options.content } : {}),
                files: [{ attachment: tmpPath, name: filename }],
            });
        } finally {
            unlink(tmpPath).catch(() => {});
        }
    } else {
        msg = await channel.send({
            ...(options?.content ? { content: options.content } : {}),
            files: [source],
        });
    }
    log(`Media attachment sent to thread ${threadId} (source=${isUrl ? 'url' : 'file'}, messageId=${msg.id})`);
    return msg.id;
}

/**
 * Send a file as a downloadable attachment to a Discord thread. Returns the message ID.
 * For non-previewable files (PDF, Markdown, ZIP, etc.) that users need to download.
 */
export async function sendFileAttachment(threadId: string, filePath: string, options?: {
    content?: string;
    filename?: string;
}): Promise<string> {
    const channel = await getChannel(threadId);
    const msg = await channel.send({
        ...(options?.content ? { content: options.content } : {}),
        files: [{ attachment: filePath, name: options?.filename || filePath.split('/').pop() }],
    });
    log(`File attachment sent to thread ${threadId} (path=${filePath}, messageId=${msg.id})`);
    return msg.id;
}

export async function removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!client) {
        log.warn(`Cannot remove reaction: client not available (channelId=${channelId}, messageId=${messageId}, emoji=${emoji})`);
        return;
    }
    await client.rest.delete(Routes.channelMessageOwnReaction(channelId, messageId, encodeURIComponent(emoji)));
    log.debug(`Reaction removed (channelId=${channelId}, messageId=${messageId}, emoji=${emoji})`);
}
