/**
 * Discord utilities - Helper functions for posting to Discord
 *
 * Uses discord.js client for all REST calls, getting built-in
 * rate limit handling, queuing, and retry logic for free.
 */

import type { Client, TextChannel } from 'discord.js';

const log = (msg: string) => process.stdout.write(`[discord] ${msg}\n`);

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
    log('Client initialized');
}

/** Get a text channel by ID. Throws if client not initialized or channel not sendable. */
async function getChannel(channelId: string): Promise<TextChannel> {
    if (!client) throw new Error('Discord client not initialized — call initDiscord() first');
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !('send' in channel)) {
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
    const codePoints = [...text];
    if (codePoints.length <= max) return text;
    return codePoints.slice(0, max - suffix.length).join('') + suffix;
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
    if (text.length <= maxLen) return [text];

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

    return chunks;
}

/** Embed data structure for Discord API */
export interface EmbedData {
    color?: number;
    title?: string;
    description?: string;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    footer?: { text: string };
}

/**
 * Send a message to a Discord thread.
 * Splits long messages using markdown-aware chunking to preserve code blocks.
 */
export async function sendToThread(threadId: string, content: string): Promise<void> {
    const channel = await getChannel(threadId);
    const chunks = splitMarkdown(content, 2000);
    for (const chunk of chunks) {
        await channel.send(suppressLinkPreviews ? wrapUrls(chunk) : chunk);
    }
}

/**
 * Send embed messages to a Discord thread. Returns the Discord message ID.
 */
export async function sendEmbed(threadId: string, embeds: EmbedData[]): Promise<string> {
    const channel = await getChannel(threadId);
    const msg = await channel.send({ embeds });
    return msg.id;
}

/**
 * Edit an embed message by ID
 */
export async function editEmbed(channelId: string, messageId: string, embeds: EmbedData[]): Promise<void> {
    const channel = await getChannel(channelId);
    const msg = await channel.messages.fetch(messageId);
    await msg.edit({ embeds });
}

/**
 * Edit a message in a channel/thread
 */
export async function editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const channel = await getChannel(channelId);
    const message = await channel.messages.fetch(messageId);
    await message.edit(content);
}

/**
 * Rename a thread
 */
export async function renameThread(threadId: string, name: string): Promise<void> {
    if (!client) throw new Error('Discord client not initialized — call initDiscord() first');
    const channel = await client.channels.fetch(threadId);
    if (channel?.isThread()) {
        await channel.setName(name);
    }
}

/**
 * Send a rich message (embeds + components) to a channel. Returns the message ID.
 */
export async function sendRichMessage(channelId: string, payload: Parameters<TextChannel['send']>[0]): Promise<string> {
    const channel = await getChannel(channelId);
    const msg = await channel.send(payload);
    return msg.id;
}

/**
 * Edit a rich message (embeds + components) by ID.
 */
export async function editRichMessage(channelId: string, messageId: string, payload: import('discord.js').MessageEditOptions): Promise<void> {
    const channel = await getChannel(channelId);
    const msg = await channel.messages.fetch(messageId);
    await msg.edit(payload);
}
