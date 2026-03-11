/**
 * Attachment Handler - Extract multimodal content from Discord messages
 *
 * Processes image attachments, PDF/text file attachments, and reply references
 * into Claude API content blocks for multimodal conversations.
 */

import type { Message, Attachment } from 'discord.js';
import { createLogger } from './logger.js';

// --- Types ---

export type TextBlock = { type: 'text'; text: string };
export type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
export type DocumentBlock = { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };
export type ContentBlock = TextBlock | ImageBlock | DocumentBlock;

export type MultimodalPrompt =
    | { type: 'text'; text: string }
    | { type: 'multimodal'; blocks: ContentBlock[]; textSummary: string };

// --- Constants ---

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 100 * 1024;
const MAX_IMAGES_PER_MESSAGE = 5;

const SUPPORTED_IMAGE_TYPES = new Set([
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);

const TEXT_EXTENSIONS = new Set([
    'txt', 'md', 'csv', 'log', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
    'py', 'rb', 'rs', 'go', 'java', 'kt', 'kts', 'scala', 'c', 'cpp', 'h', 'hpp',
    'cs', 'swift', 'lua', 'r', 'pl', 'pm', 'php',
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'html', 'css', 'scss', 'sass', 'less', 'vue', 'svelte',
    'sql', 'graphql', 'gql', 'proto',
    'dockerfile', 'makefile', 'cmake',
    'env', 'gitignore', 'editorconfig', 'eslintrc', 'prettierrc',
]);

const log = createLogger('attachment');

// --- Helpers ---

type AttachmentKind = 'image' | 'pdf' | 'text' | 'unsupported';

function classifyAttachment(attachment: Attachment): AttachmentKind {
    const contentType = attachment.contentType?.toLowerCase() || '';

    if (SUPPORTED_IMAGE_TYPES.has(contentType)) return 'image';
    if (contentType === 'application/pdf') return 'pdf';
    if (contentType.startsWith('text/')) return 'text';

    // Fall back to extension check
    const ext = attachment.name?.split('.').pop()?.toLowerCase() || '';
    if (TEXT_EXTENSIONS.has(ext)) return 'text';

    return 'unsupported';
}

async function downloadAttachment(url: string, maxBytes: number): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
        throw new Error(`File too large (${Math.round(parseInt(contentLength, 10) / 1024 / 1024)}MB, max ${Math.round(maxBytes / 1024 / 1024)}MB)`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
        throw new Error(`File too large (${Math.round(buffer.length / 1024 / 1024)}MB, max ${Math.round(maxBytes / 1024 / 1024)}MB)`);
    }

    return buffer;
}

function buildImageBlock(buffer: Buffer, mediaType: string): ImageBlock {
    return {
        type: 'image',
        source: {
            type: 'base64',
            media_type: mediaType,
            data: buffer.toString('base64'),
        },
    };
}

function buildDocumentBlock(buffer: Buffer): DocumentBlock {
    return {
        type: 'document',
        source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: buffer.toString('base64'),
        },
    };
}

function buildTextFileBlock(buffer: Buffer, filename: string): TextBlock {
    const text = buffer.toString('utf-8');
    return {
        type: 'text',
        text: `[File: ${filename}]\n\`\`\`\n${text}\n\`\`\``,
    };
}

async function processAttachments(attachments: Attachment[]): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = [];
    let imageCount = 0;

    for (const attachment of attachments) {
        try {
            const kind = classifyAttachment(attachment);

            switch (kind) {
                case 'image': {
                    if (imageCount >= MAX_IMAGES_PER_MESSAGE) {
                        blocks.push({ type: 'text', text: `[Skipped image "${attachment.name}": max ${MAX_IMAGES_PER_MESSAGE} images per message]` });
                        break;
                    }
                    const buffer = await downloadAttachment(attachment.url, MAX_IMAGE_BYTES);
                    blocks.push(buildImageBlock(buffer, attachment.contentType || 'image/png'));
                    imageCount++;
                    log(`Image attached: ${attachment.name} (${Math.round(buffer.length / 1024)}KB)`);
                    break;
                }
                case 'pdf': {
                    const buffer = await downloadAttachment(attachment.url, MAX_PDF_BYTES);
                    blocks.push(buildDocumentBlock(buffer));
                    log(`PDF attached: ${attachment.name} (${Math.round(buffer.length / 1024)}KB)`);
                    break;
                }
                case 'text': {
                    const buffer = await downloadAttachment(attachment.url, MAX_TEXT_FILE_BYTES);
                    blocks.push(buildTextFileBlock(buffer, attachment.name || 'file.txt'));
                    log(`Text file attached: ${attachment.name} (${Math.round(buffer.length / 1024)}KB)`);
                    break;
                }
                case 'unsupported':
                    blocks.push({ type: 'text', text: `[Unsupported attachment: "${attachment.name}" (${attachment.contentType || 'unknown type'})]` });
                    break;
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log(`Failed to process attachment "${attachment.name}": ${errMsg}`);
            blocks.push({ type: 'text', text: `[Failed to process attachment "${attachment.name}": ${errMsg}]` });
        }
    }

    return blocks;
}

async function fetchReplyContext(message: Message): Promise<ContentBlock[]> {
    if (!message.reference?.messageId) return [];

    try {
        const channel = message.channel;
        const referenced = await channel.messages.fetch(message.reference.messageId);
        if (!referenced) return [];

        const blocks: ContentBlock[] = [];

        // Header
        blocks.push({
            type: 'text',
            text: `[Replying to @${referenced.author.tag}:]`,
        });

        // Referenced message text
        if (referenced.content) {
            blocks.push({ type: 'text', text: referenced.content });
        }

        // Referenced message attachments (images only, to keep context manageable)
        const imageAttachments = [...referenced.attachments.values()]
            .filter(a => SUPPORTED_IMAGE_TYPES.has(a.contentType?.toLowerCase() || ''));

        for (const attachment of imageAttachments.slice(0, MAX_IMAGES_PER_MESSAGE)) {
            try {
                const buffer = await downloadAttachment(attachment.url, MAX_IMAGE_BYTES);
                blocks.push(buildImageBlock(buffer, attachment.contentType || 'image/png'));
                log(`Reply image attached: ${attachment.name}`);
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                log(`Failed to fetch reply image: ${errMsg}`);
            }
        }

        return blocks;
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Failed to fetch referenced message: ${errMsg}`);
        return [];
    }
}

// --- Main export ---

/**
 * Extract multimodal content from a Discord message.
 *
 * Returns `{ type: 'text' }` for plain text messages,
 * `{ type: 'multimodal' }` when images/PDFs/files/replies are present.
 *
 * @param message - The Discord message
 * @param overrideText - Optional pre-processed text (e.g. after [/path] prefix removal)
 */
export async function extractMessageContent(message: Message, overrideText?: string): Promise<MultimodalPrompt> {
    const text = overrideText ?? message.content.replace(/<@!?\d+>/g, '').trim();

    const attachments = [...message.attachments.values()];
    const hasAttachments = attachments.length > 0;
    const hasReply = !!message.reference?.messageId;

    // Fast path: pure text, no rich content
    if (!hasAttachments && !hasReply) {
        return { type: 'text', text };
    }

    const blocks: ContentBlock[] = [];

    // 1. Reply context first (provides conversation context)
    if (hasReply) {
        const replyBlocks = await fetchReplyContext(message);
        blocks.push(...replyBlocks);
    }

    // 2. User's text
    if (text) {
        blocks.push({ type: 'text', text });
    }

    // 3. Attachments
    if (hasAttachments) {
        const attachmentBlocks = await processAttachments(attachments);
        blocks.push(...attachmentBlocks);
    }

    // If all we got are text blocks, flatten back to plain text
    const hasNonTextBlocks = blocks.some(b => b.type !== 'text');
    if (!hasNonTextBlocks) {
        const combinedText = blocks.map(b => (b as TextBlock).text).join('\n\n');
        return { type: 'text', text: combinedText };
    }

    // Build a text summary for title generation and status messages
    const textSummary = blocks
        .filter((b): b is TextBlock => b.type === 'text')
        .map(b => b.text)
        .join(' ')
        .slice(0, 200);

    return { type: 'multimodal', blocks, textSummary };
}
