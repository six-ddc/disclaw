/**
 * Context Builder - XML-formatted prompts with Discord context
 *
 * Formats user messages as structured XML with sender attribution, timestamps,
 * reply references, and attachment metadata. When adopting existing threads
 * (e.g. forum posts), prepends <context> with channel info, forum post content,
 * and thread history.
 */

import type { Message, AnyThreadChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import type { ContentBlock, MultimodalPrompt } from './attachment-handler.js';
import { processAttachments, fetchReplyContext, classifyAttachment } from './attachment-handler.js';
import { createLogger } from './logger.js';

const log = createLogger('context');

// --- XML utilities ---

/** Escape special XML characters */
function escapeXml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Format a Date as ISO 8601 string */
function formatTimestamp(date: Date): string {
    return date.toISOString();
}

// --- Discord context fetching ---

/** Map Discord channel type to a simple string label */
function channelTypeLabel(type: ChannelType): string {
    switch (type) {
        case ChannelType.GuildForum: return 'forum';
        case ChannelType.GuildMedia: return 'media';
        default: return 'text';
    }
}

/** Build <channel name="..." type="..." guild="..." /> tag from a thread */
function buildChannelInfoXml(thread: AnyThreadChannel): string {
    const parent = thread.parent;
    if (!parent) return '';
    const name = escapeXml(parent.name);
    const type = channelTypeLabel(parent.type);
    const guild = thread.guild ? escapeXml(thread.guild.name) : '';
    return `  <channel name="${name}" type="${type}" guild="${guild}" />`;
}

/** Fetch the forum/media thread starter message and return title + body */
async function fetchForumContext(thread: AnyThreadChannel): Promise<{ title: string; body: string } | null> {
    const parentType = thread.parent?.type;
    if (parentType !== ChannelType.GuildForum && parentType !== ChannelType.GuildMedia) {
        return null;
    }

    try {
        const starter = await thread.fetchStarterMessage();
        if (!starter) return null;
        return {
            title: thread.name || '',
            body: starter.content || '',
        };
    } catch (err) {
        log.warn(`Failed to fetch starter message for thread=${thread.id}: ${err}`);
        return null;
    }
}

/** Fetch up to `limit` messages before the current one, max `maxChars` total */
async function fetchThreadHistory(
    thread: AnyThreadChannel,
    beforeMessageId: string,
    limit = 10,
    maxChars = 2000,
): Promise<string> {
    try {
        const messages = await thread.messages.fetch({ before: beforeMessageId, limit });
        if (messages.size === 0) return '';

        // Messages come newest-first; reverse to chronological order
        const sorted = [...messages.values()].reverse();

        let totalChars = 0;
        const lines: string[] = [];

        for (const msg of sorted) {
            const sender = escapeXml(msg.author.displayName || msg.author.username);
            const time = formatTimestamp(msg.createdAt);
            const content = msg.content?.replace(/<@!?\d+>/g, '').trim() || '';
            if (!content) continue;

            // Check reply reference
            let replyTag = '';
            if (msg.reference?.messageId) {
                try {
                    const ref = await thread.messages.fetch(msg.reference.messageId);
                    if (ref) {
                        const refSender = escapeXml(ref.author.displayName || ref.author.username);
                        const refContent = escapeXml((ref.content || '').slice(0, 200));
                        replyTag = `\n      <reply sender="${refSender}">${refContent}</reply>`;
                    }
                } catch { /* ignore missing refs */ }
            }

            const escapedContent = escapeXml(content);
            const line = `    <message sender="${sender}" time="${time}">${replyTag}\n${escapedContent}\n    </message>`;

            if (totalChars + line.length > maxChars) break;
            totalChars += line.length;
            lines.push(line);
        }

        if (lines.length === 0) return '';
        return `  <history>\n${lines.join('\n')}\n  </history>`;
    } catch (err) {
        log.warn(`Failed to fetch thread history for thread=${thread.id}: ${err}`);
        return '';
    }
}

// --- Message formatting ---

interface MessageFormatResult {
    xml: string;
    mediaBlocks: ContentBlock[];
}

/**
 * Format the current user message as a <message> XML element.
 * Text content (including text file contents and reply) goes into XML.
 * Binary content (images, PDFs) returned as separate ContentBlocks.
 */
async function formatUserMessage(message: Message, overrideText?: string): Promise<MessageFormatResult> {
    const text = overrideText ?? message.content.replace(/<@!?\d+>/g, '').trim();
    const sender = escapeXml(message.author.displayName || message.author.username);
    const time = formatTimestamp(message.createdAt);

    const innerParts: string[] = [];
    const mediaBlocks: ContentBlock[] = [];

    // 1. Reply reference
    if (message.reference?.messageId) {
        try {
            const ref = await message.channel.messages.fetch(message.reference.messageId);
            if (ref) {
                const refSender = escapeXml(ref.author.displayName || ref.author.username);
                const refContent = escapeXml((ref.content || '').slice(0, 200));
                innerParts.push(`  <reply sender="${refSender}">${refContent}</reply>`);

                // Also fetch reply images as media blocks (same as existing behavior)
                const replyMediaBlocks = await fetchReplyContext(message);
                // Only keep non-text blocks from reply context (images)
                for (const block of replyMediaBlocks) {
                    if (block.type !== 'text') {
                        mediaBlocks.push(block);
                    }
                }
            }
        } catch (err) {
            log.warn(`Failed to fetch reply reference: ${err}`);
        }
    }

    // 2. User's text
    if (text) {
        innerParts.push(escapeXml(text));
    }

    // 3. Attachments
    const attachments = [...message.attachments.values()];
    for (const attachment of attachments) {
        const kind = classifyAttachment(attachment);
        switch (kind) {
            case 'text': {
                // Inline text file content in XML
                try {
                    const response = await fetch(attachment.url);
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const buffer = Buffer.from(await response.arrayBuffer());
                    const fileContent = buffer.toString('utf-8');
                    const fileName = escapeXml(attachment.name || 'file.txt');
                    innerParts.push(`  <attachment type="file" name="${fileName}">\n${escapeXml(fileContent)}\n  </attachment>`);
                } catch (err) {
                    innerParts.push(`  <attachment type="file" name="${escapeXml(attachment.name || 'file')}" error="${escapeXml(String(err))}" />`);
                }
                break;
            }
            case 'image': {
                // Self-closing reference; actual binary as separate ContentBlock
                const fileName = escapeXml(attachment.name || 'image');
                innerParts.push(`  <attachment type="image" name="${fileName}" />`);
                break;
            }
            case 'pdf': {
                const fileName = escapeXml(attachment.name || 'document.pdf');
                innerParts.push(`  <attachment type="pdf" name="${fileName}" />`);
                break;
            }
            case 'unsupported': {
                const fileName = escapeXml(attachment.name || 'file');
                innerParts.push(`  <attachment type="unsupported" name="${fileName}" />`);
                break;
            }
        }
    }

    // Process attachments for binary content blocks (images, PDFs)
    if (attachments.length > 0) {
        const blocks = await processAttachments(attachments);
        for (const block of blocks) {
            if (block.type !== 'text') {
                mediaBlocks.push(block);
            }
        }
    }

    const inner = innerParts.length > 0 ? '\n' + innerParts.join('\n') + '\n' : '';
    const xml = `<message sender="${sender}" time="${time}">${inner}</message>`;

    return { xml, mediaBlocks };
}

// --- Entry point ---

export interface BuildPromptOptions {
    message: Message;
    overrideText?: string;
    /** true only when adopting an existing untracked thread (forum posts, etc.) */
    includeContext: boolean;
}

/**
 * Build a structured XML prompt for the Claude Agent SDK.
 *
 * 1. Format current message as <message> XML
 * 2. If includeContext: prepend <context> (channel info + forum post + history)
 * 3. Combine XML text with any binary content blocks into a MultimodalPrompt
 */
export async function buildPrompt(options: BuildPromptOptions): Promise<MultimodalPrompt> {
    const { message, overrideText, includeContext } = options;

    // Format the user's message as XML
    const { xml: messageXml, mediaBlocks } = await formatUserMessage(message, overrideText);

    let fullXml: string;

    if (includeContext && message.channel.isThread()) {
        const thread = message.channel;

        // Build context parts
        const contextParts: string[] = [];

        // Channel info
        const channelInfo = buildChannelInfoXml(thread);
        if (channelInfo) contextParts.push(channelInfo);

        // Forum post title + body
        const forum = await fetchForumContext(thread);
        if (forum) {
            const title = escapeXml(forum.title);
            const body = forum.body ? escapeXml(forum.body) : '';
            if (body) {
                contextParts.push(`  <forumPost title="${title}">\n${body}\n  </forumPost>`);
            } else {
                contextParts.push(`  <forumPost title="${title}" />`);
            }
        }

        // Thread history
        const history = await fetchThreadHistory(thread, message.id);
        if (history) contextParts.push(history);

        if (contextParts.length > 0) {
            fullXml = `<context>\n${contextParts.join('\n')}\n</context>\n\n${messageXml}`;
        } else {
            fullXml = messageXml;
        }
    } else {
        fullXml = messageXml;
    }

    // If there are binary content blocks (images, PDFs), return multimodal
    if (mediaBlocks.length > 0) {
        const blocks: ContentBlock[] = [
            { type: 'text', text: fullXml },
            ...mediaBlocks,
        ];

        // Build a text summary for title generation
        const text = overrideText ?? message.content.replace(/<@!?\d+>/g, '').trim();
        const textSummary = text.slice(0, 200);

        return { type: 'multimodal', blocks, textSummary };
    }

    return { type: 'text', text: fullXml };
}
