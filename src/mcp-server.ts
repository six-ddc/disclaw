/**
 * MCP Server Factory - Creates SDK MCP servers for Claude Agent queries
 *
 * Provides tools for cron management, thread control, and Discord operations.
 * Each query() call gets a fresh instance bound to the
 * requesting thread/channel/user context.
 */

import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import { resolve, isAbsolute } from 'path';
import { existsSync, statSync } from 'fs';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { Cron } from 'croner';
import { z } from 'zod/v4';
import {
    createSdkMcpServer,
    tool,
    type McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';
import { getCronScheduler } from './cron.js';
import { updateCronControlPanel, markPanelDeleted } from './cron-buttons.js';
import {
    getCronJob,
    listCronJobs,
    updateCronJob,
    setThreadTitle,
} from './db.js';
import {
    sendEmbed,
    sendRichMessage,
    splitMarkdown,
    renameThread,
    truncateCodePoints,
    fetchMessage,
    fetchMessages,
    createThread,
    fetchChannelTree,
    fetchThreads,
    addReaction,
    removeReaction,
    deleteMessage,
    type EmbedData,
} from './discord.js';
import { generateTitle } from './claude-client.js';
import { createLogger } from './logger.js';

const log = createLogger('mcp-server');

const TIMEZONE = process.env.TZ;
const DISCORD_MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB (non-boosted server limit)

/** Allowed file extensions by category (only formats Discord renders inline) */
const ALLOWED_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif']);
const ALLOWED_MEDIA_EXTS = new Set(['mp3', 'wav', 'ogg', 'mp4', 'webm']);
const ALLOWED_FILE_EXTS = new Set([
    // Documents
    'pdf', 'md', 'txt', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'toml',
    // Archives
    'zip', 'tar', 'gz', 'tgz',
    // Code
    'js', 'ts', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'rb',
    'html', 'css', 'scss', 'sql', 'swift', 'kt',
    // Data
    'log', 'example', 'ini', 'conf', 'cfg',
    // Images/media (fallback for discord_send_file)
    ...ALLOWED_IMAGE_EXTS, ...ALLOWED_MEDIA_EXTS,
]);

/** Get lowercase file extension from a path or URL */
function getFileExt(pathOrUrl: string): string {
    const basename = pathOrUrl.split('/').pop() || '';
    const dotIdx = basename.lastIndexOf('.');
    return dotIdx >= 0 ? basename.slice(dotIdx + 1).toLowerCase() : '';
}

/** MCP tool error result type */
type ToolError = { content: Array<{ type: 'text'; text: string }>; isError: true };

/**
 * Create the disclaw MCP server bound to a specific context.
 * Each query() call gets its own instance so tool handlers know
 * which thread/channel/user they're operating on.
 */
export function createDisclawMcpServer(
    parentChannelId: string,
    userId: string,
    workingDir: string,
    model?: string,
    sourceThreadId?: string,
    getSessionId?: () => string | undefined,
): McpSdkServerConfigWithInstance {
    const sched = getCronScheduler();

    // Resolve display timezone for tool descriptions
    const tzLabel = TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

    // =====================================================================
    // Internal helpers
    // =====================================================================

    /** Resolve target channel/thread: explicit param > sourceThreadId > parentChannelId */
    function resolveTarget(explicit?: string): string {
        return explicit || sourceThreadId || parentChannelId;
    }

    /** Parse a color value: "#5865F2" → number, decimal number → number */
    function parseColor(color?: string | number): number | undefined {
        if (color === undefined || color === null) return undefined;
        if (typeof color === 'number') return color;
        const str = String(color).trim();
        if (str.startsWith('#')) return parseInt(str.slice(1), 16);
        const n = parseInt(str, 10);
        return isNaN(n) ? undefined : n;
    }

    /** Build an EmbedData from MCP embed schema, handling local image/thumbnail files as attachments */
    function buildEmbed(schema: {
        title?: string;
        description?: string;
        color?: string | number;
        footer?: string;
        image?: string;
        thumbnail?: string;
        fields?: Array<{ name: string; value: string; inline?: boolean }>;
        url?: string;
    }, attachedImages?: Map<string, string>): EmbedData {
        const embed: EmbedData = {};
        if (schema.title) embed.title = schema.title;
        if (schema.url) embed.url = schema.url;
        if (schema.description) embed.description = schema.description;
        const color = parseColor(schema.color);
        if (color !== undefined) embed.color = color;
        if (schema.footer) embed.footer = { text: schema.footer };
        if (schema.fields && schema.fields.length > 0) embed.fields = schema.fields;
        if (schema.image) {
            const imgUrl = attachedImages?.get(schema.image) || schema.image;
            embed.image = { url: imgUrl };
        }
        if (schema.thumbnail) {
            const thumbUrl = attachedImages?.get(schema.thumbnail) || schema.thumbnail;
            embed.thumbnail = { url: thumbUrl };
        }
        return embed;
    }

    /** Resolve a source that could be a URL or local path. Returns resolved path or URL string. */
    function resolveSource(source: string): { type: 'url'; value: string } | { type: 'file'; value: string } {
        if (/^https?:\/\//.test(source)) return { type: 'url', value: source };
        const resolved = isAbsolute(source) ? source : resolve(workingDir, source);
        return { type: 'file', value: resolved };
    }

    /** Validate a local file: extension whitelist + exists + size check. Returns error result or null. */
    function validateFile(path: string, toolName: string, allowedExts: Set<string>): ToolError | null {
        const ext = getFileExt(path);
        if (!ext || !allowedExts.has(ext)) {
            log.warn(`MCP ${toolName}: blocked extension ".${ext}": ${path}`);
            return { content: [{ type: 'text' as const, text: `File type ".${ext}" is not allowed. Allowed: ${[...allowedExts].join(', ')}` }], isError: true };
        }
        if (!existsSync(path)) {
            log.warn(`MCP ${toolName}: file not found: ${path}`);
            return { content: [{ type: 'text' as const, text: `File not found: ${path}` }], isError: true };
        }
        const stat = statSync(path);
        if (stat.size > DISCORD_MAX_FILE_SIZE) {
            log.warn(`MCP ${toolName}: file too large (${stat.size} bytes): ${path}`);
            return { content: [{ type: 'text' as const, text: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Discord limit is 25MB.` }], isError: true };
        }
        return null;
    }

    /** Validate a URL extension against whitelist. Returns error result or null. */
    function validateUrlExt(url: string, toolName: string, allowedExts: Set<string>): ToolError | null {
        const ext = getFileExt(url);
        if (!ext || !allowedExts.has(ext)) {
            log.warn(`MCP ${toolName}: blocked URL extension ".${ext}": ${url}`);
            return { content: [{ type: 'text' as const, text: `URL file type ".${ext}" is not allowed. Allowed: ${[...allowedExts].join(', ')}` }], isError: true };
        }
        return null;
    }

    /** Download a URL to a temp file. Returns the temp path. Caller must clean up. */
    async function downloadToTemp(url: string): Promise<string> {
        const filename = url.split('/').pop()?.split('?')[0] || 'file';
        const tmpPath = join(tmpdir(), `disclaw-${Date.now()}-${filename}`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
        if (!res.body) throw new Error('Response body is empty');
        await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), createWriteStream(tmpPath));
        return tmpPath;
    }

    // =====================================================================
    // Cron tools
    // =====================================================================

    const cronCreateTool = tool(
        'cron_create',
        `Create a scheduled task that runs on a cron schedule. The task will execute in a dedicated Discord thread. Use standard cron expressions (e.g. "0 9 * * *" for daily at 9am, "*/30 * * * *" for every 30 minutes). IMPORTANT: All times are in the server's local timezone (${tzLabel}). Do NOT convert to UTC.`,
        {
            schedule: z.string().describe('Cron expression (e.g. "0 9 * * *" for daily at 9am)'),
            prompt: z.string().describe('The prompt/instruction to execute on each run'),
            name: z.string().optional().describe('Short display name for the task (used in thread title and listings). If omitted, the prompt is used as fallback.'),
        },
        async (args) => {
            log(`MCP cron_create invoked: schedule=${args.schedule}, name=${args.name || '(none)'}`);
            // Validate cron expression
            try {
                new Cron(args.schedule);
            } catch (err) {
                log.warn(`MCP cron_create: invalid cron expression "${args.schedule}": ${err}`);
                return {
                    content: [{ type: 'text' as const, text: `Invalid cron expression: ${err}` }],
                    isError: true,
                };
            }

            try {
                const result = await sched.createJobWithThread({
                    parentChannelId,
                    creatorId: userId,
                    schedule: args.schedule,
                    prompt: args.prompt,
                    workingDir,
                    model,
                    name: args.name,
                });

                const nextRun = sched.getNextRun(result.jobId);

                log(`MCP cron_create succeeded: jobId=${result.jobId}, threadId=${result.threadId}`);

                // Send reference in the source thread
                if (sourceThreadId) {
                    await sendEmbed(sourceThreadId, [{
                        color: 0x5865f2,
                        title: 'Scheduled Task Created',
                        description: `\`${args.schedule}\` → <#${result.threadId}>`,
                        footer: { text: `Job ID: ${result.jobId}` },
                    }]).catch(err => log.error(`Failed to send cron ref to thread ${sourceThreadId}: ${err}`));
                }

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            job_id: result.jobId,
                            thread_id: result.threadId,
                            schedule: args.schedule,
                            name: args.name || null,
                            next_run: nextRun?.toISOString() || 'unknown',
                        }),
                    }],
                };
            } catch (err) {
                log.error(`MCP cron_create failed: ${err}`);
                return {
                    content: [{ type: 'text' as const, text: `Failed to create cron job: ${err}` }],
                    isError: true,
                };
            }
        },
    );

    const cronListTool = tool(
        'cron_list',
        'List all scheduled tasks',
        {},
        async () => {
            log.debug('MCP cron_list invoked');
            const jobs = listCronJobs();
            log.debug(`MCP cron_list: returning ${jobs.length} jobs`);
            const result = jobs.map(j => ({
                job_id: j.job_id,
                name: j.name || null,
                schedule: j.schedule,
                prompt: truncateCodePoints(j.prompt, 100),
                enabled: !!j.enabled,
                thread_id: j.thread_id,
                next_run: sched.getNextRun(j.job_id)?.toISOString() || null,
            }));
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            };
        },
    );

    const cronDeleteTool = tool(
        'cron_delete',
        'Delete a scheduled task by job ID',
        {
            job_id: z.string().describe('The job ID to delete'),
        },
        async (args) => {
            log(`MCP cron_delete invoked: jobId=${args.job_id}`);
            const job = getCronJob(args.job_id);
            const deleted = sched.delete(args.job_id);
            if (!deleted) {
                log.warn(`MCP cron_delete: job not found: ${args.job_id}`);
                return {
                    content: [{ type: 'text' as const, text: `Job not found: ${args.job_id}` }],
                    isError: true,
                };
            }
            if (job) {
                await markPanelDeleted(job).catch(err => log.error(`Failed to mark panel deleted for job ${args.job_id}: ${err}`));
            }
            return {
                content: [{ type: 'text' as const, text: `Deleted job ${args.job_id}` }],
            };
        },
    );

    const cronUpdateTool = tool(
        'cron_update',
        `Update a scheduled task. Can modify any combination of name, schedule, and prompt. If name is changed, the thread title is updated accordingly. If schedule is changed, the cron job is re-registered. All times are in the server's local timezone (${tzLabel}).`,
        {
            job_id: z.string().describe('The job ID to update'),
            name: z.string().optional().describe('New display name for the task'),
            schedule: z.string().optional().describe('New cron expression'),
            prompt: z.string().optional().describe('New prompt/instruction'),
        },
        async (args) => {
            log(`MCP cron_update invoked: jobId=${args.job_id}`);
            const job = getCronJob(args.job_id);
            if (!job) {
                log.warn(`MCP cron_update: job not found: ${args.job_id}`);
                return {
                    content: [{ type: 'text' as const, text: `Job not found: ${args.job_id}` }],
                    isError: true,
                };
            }

            // Validate new schedule if provided
            if (args.schedule) {
                try {
                    new Cron(args.schedule);
                } catch (err) {
                    log.warn(`MCP cron_update: invalid cron expression "${args.schedule}": ${err}`);
                    return {
                        content: [{ type: 'text' as const, text: `Invalid cron expression: ${err}` }],
                        isError: true,
                    };
                }
            }

            // Update DB fields
            const fields: { name?: string; schedule?: string; prompt?: string } = {};
            if (args.name !== undefined) fields.name = args.name;
            if (args.schedule !== undefined) fields.schedule = args.schedule;
            if (args.prompt !== undefined) fields.prompt = args.prompt;
            updateCronJob(args.job_id, fields);

            // Re-register if schedule changed
            if (args.schedule && job.enabled) {
                const updated = getCronJob(args.job_id)!;
                sched.register(updated);
                log(`Re-registered job ${args.job_id} with new schedule: ${args.schedule}`);
            }

            // Update thread name if name changed
            if (args.name !== undefined) {
                const newThreadName = truncateCodePoints(`\u{23F0} ${args.name}`, 50);
                renameThread(job.thread_id, newThreadName).catch(err => log.error(`Failed to rename thread for job ${args.job_id}: ${err}`));
                setThreadTitle(job.thread_id, newThreadName);
            }

            // Update the control panel to reflect changes
            await updateCronControlPanel(args.job_id).catch(err => log.error(`Failed to update panel for job ${args.job_id}: ${err}`));

            const changed = Object.keys(fields).join(', ');
            log(`MCP cron_update succeeded for job ${args.job_id}: updated ${changed}`);
            return {
                content: [{ type: 'text' as const, text: `Updated job ${args.job_id}: ${changed}` }],
            };
        },
    );

    const cronRunNowTool = tool(
        'cron_run_now',
        'Immediately trigger a scheduled task to run now, outside its normal schedule. Useful for retrying failed runs or testing.',
        {
            job_id: z.string().describe('The job ID to run immediately'),
        },
        async (args) => {
            log(`MCP cron_run_now invoked: jobId=${args.job_id}`);
            const ran = sched.runNow(args.job_id);
            if (!ran) {
                log.warn(`MCP cron_run_now: job not found: ${args.job_id}`);
                return {
                    content: [{ type: 'text' as const, text: `Job not found: ${args.job_id}` }],
                    isError: true,
                };
            }
            return {
                content: [{ type: 'text' as const, text: `Triggered immediate run for job ${args.job_id}` }],
            };
        },
    );

    // =====================================================================
    // Discord tools
    // =====================================================================

    const embedFieldSchema = z.object({
        name: z.string().describe('Field name'),
        value: z.string().describe('Field value'),
        inline: z.boolean().optional().describe('Display inline'),
    });

    const embedSchema = z.object({
        title: z.string().optional().describe('Embed title'),
        description: z.string().optional().describe('Embed body text (markdown supported)'),
        color: z.union([z.string(), z.number()]).optional().describe('Color as "#5865F2" or decimal number'),
        footer: z.string().optional().describe('Footer text'),
        image: z.string().optional().describe('Image: local file path or URL (rendered large below description)'),
        thumbnail: z.string().optional().describe('Thumbnail: local file path or URL (rendered small top-right)'),
        fields: z.array(embedFieldSchema).optional().describe('Structured key-value fields'),
        url: z.string().optional().describe('URL that the embed title links to'),
    });

    const discordSendTool = tool(
        'discord_send',
        'Send a message to Discord. Supports text content, rich embeds (up to 10), file attachments, and replies. Defaults to the current thread. For images/media in embeds, use local paths or URLs. Files are validated against an extension whitelist and 25MB size limit.',
        {
            content: z.string().optional().describe('Text content (markdown supported, max 2000 chars per message; auto-split if sole payload)'),
            embeds: z.array(embedSchema).optional().describe('Rich embed objects (max 10). For a single embed, pass a one-element array.'),
            files: z.array(z.string()).optional().describe('File paths or URLs to attach (validated against extension whitelist, max 25MB each)'),
            reply_to: z.string().optional().describe('Message ID to reply to'),
            target: z.string().optional().describe('Target channel/thread ID (defaults to current thread)'),
        },
        async (args) => {
            log(`MCP discord_send invoked: content=${args.content?.length ?? 0}chars embeds=${args.embeds?.length ?? 0} files=${args.files?.length ?? 0} target=${args.target || 'default'}`);
            const target = resolveTarget(args.target);

            const tempFiles: string[] = [];
            try {
                const fileAttachments: Array<{ attachment: string; name: string }> = [];
                const attachedImages = new Map<string, string>(); // original path/url → attachment://filename

                // Process embed images/thumbnails: local files need to be attached
                if (args.embeds) {
                    for (const embed of args.embeds) {
                        for (const key of ['image', 'thumbnail'] as const) {
                            const value = embed[key];
                            if (!value || attachedImages.has(value)) continue;
                            const src = resolveSource(value);
                            if (src.type === 'file') {
                                const err = validateFile(src.value, 'discord_send', ALLOWED_IMAGE_EXTS);
                                if (err) return err;
                                const filename = src.value.split('/').pop() || 'image.png';
                                fileAttachments.push({ attachment: src.value, name: filename });
                                attachedImages.set(value, `attachment://${filename}`);
                            } else if (src.type === 'url') {
                                const tmpPath = await downloadToTemp(src.value);
                                tempFiles.push(tmpPath);
                                const filename = tmpPath.split('/').pop()!;
                                fileAttachments.push({ attachment: tmpPath, name: filename });
                                attachedImages.set(value, `attachment://${filename}`);
                            }
                        }
                    }
                }

                // Process file attachments
                if (args.files) {
                    for (const file of args.files) {
                        const src = resolveSource(file);
                        if (src.type === 'file') {
                            const err = validateFile(src.value, 'discord_send', ALLOWED_FILE_EXTS);
                            if (err) return err;
                            const filename = src.value.split('/').pop() || 'file';
                            fileAttachments.push({ attachment: src.value, name: filename });
                        } else {
                            const err = validateUrlExt(src.value, 'discord_send', ALLOWED_FILE_EXTS);
                            if (err) return err;
                            const tmpPath = await downloadToTemp(src.value);
                            tempFiles.push(tmpPath);
                            const filename = tmpPath.split('/').pop()!;
                            fileAttachments.push({ attachment: tmpPath, name: filename });
                        }
                    }
                }

                // Auto-split long content when it's the sole payload
                const hasEmbeds = args.embeds && args.embeds.length > 0;
                const hasFiles = fileAttachments.length > 0;
                const isSoleContent = args.content && !hasEmbeds && !hasFiles;

                if (isSoleContent && args.content!.length > 2000) {
                    const chunks = splitMarkdown(args.content!, 2000);
                    let lastMsgId = '';
                    for (const chunk of chunks) {
                        if (!chunk.trim()) continue;
                        lastMsgId = await sendRichMessage(target, {
                            content: chunk,
                            ...(args.reply_to && lastMsgId === '' ? { reply: { messageReference: args.reply_to } } : {}),
                        });
                    }
                    log(`MCP discord_send: auto-split ${chunks.length} chunks, lastMsgId=${lastMsgId}`);
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ message_id: lastMsgId, chunks: chunks.length }) }] };
                }

                // Build payload
                const payload: Record<string, unknown> = {};
                if (args.content) {
                    payload.content = args.content.length > 2000
                        ? truncateCodePoints(args.content, 2000)
                        : args.content;
                }
                if (args.embeds && args.embeds.length > 0) {
                    payload.embeds = args.embeds.slice(0, 10).map(e => buildEmbed(e, attachedImages));
                }
                if (fileAttachments.length > 0) {
                    payload.files = fileAttachments;
                }
                if (args.reply_to) {
                    payload.reply = { messageReference: args.reply_to };
                }

                const msgId = await sendRichMessage(target, payload as Parameters<typeof sendRichMessage>[1]);
                log(`MCP discord_send succeeded: msgId=${msgId}`);
                return { content: [{ type: 'text' as const, text: JSON.stringify({ message_id: msgId }) }] };
            } catch (err) {
                log.error(`MCP discord_send failed: ${err}`);
                return { content: [{ type: 'text' as const, text: `Failed to send message: ${err}` }], isError: true };
            } finally {
                for (const tmp of tempFiles) unlink(tmp).catch(() => {});
            }
        },
    );

    const discordEditTool = tool(
        'discord_edit',
        "Edit a message sent by the bot. Can update content and/or embeds. Set content to empty string to remove text. Only the bot's own messages can be edited.",
        {
            message_id: z.string().describe('The message ID to edit'),
            content: z.string().optional().describe('New text content (empty string to remove, omit to keep unchanged)'),
            embeds: z.array(embedSchema).nullable().optional().describe('New embeds array (null or empty to remove all, omit to keep unchanged)'),
            target: z.string().optional().describe('Channel/thread ID containing the message (defaults to current thread)'),
        },
        async (args) => {
            log(`MCP discord_edit invoked: messageId=${args.message_id} target=${args.target || 'default'}`);
            const target = resolveTarget(args.target);

            const tempFiles: string[] = [];
            try {
                const { editRichMessage } = await import('./discord.js');
                const payload: Record<string, unknown> = {};
                if (args.content !== undefined) {
                    payload.content = args.content.length > 2000
                        ? truncateCodePoints(args.content, 2000)
                        : args.content;
                }
                if (args.embeds !== undefined) {
                    if (!args.embeds || args.embeds.length === 0) {
                        payload.embeds = [];
                    } else {
                        const fileAttachments: Array<{ attachment: string; name: string }> = [];
                        const attachedImages = new Map<string, string>();
                        for (const embed of args.embeds) {
                            for (const key of ['image', 'thumbnail'] as const) {
                                const value = embed[key];
                                if (!value || attachedImages.has(value)) continue;
                                const src = resolveSource(value);
                                if (src.type === 'file') {
                                    const err = validateFile(src.value, 'discord_edit', ALLOWED_IMAGE_EXTS);
                                    if (err) return err;
                                    const filename = src.value.split('/').pop() || 'image.png';
                                    fileAttachments.push({ attachment: src.value, name: filename });
                                    attachedImages.set(value, `attachment://${filename}`);
                                } else if (src.type === 'url') {
                                    const tmpPath = await downloadToTemp(src.value);
                                    tempFiles.push(tmpPath);
                                    const filename = tmpPath.split('/').pop()!;
                                    fileAttachments.push({ attachment: tmpPath, name: filename });
                                    attachedImages.set(value, `attachment://${filename}`);
                                }
                            }
                        }
                        payload.embeds = args.embeds.slice(0, 10).map(e => buildEmbed(e, attachedImages));
                        if (fileAttachments.length > 0) payload.files = fileAttachments;
                    }
                }
                await editRichMessage(target, args.message_id, payload as import('discord.js').MessageEditOptions);
                log(`MCP discord_edit succeeded: messageId=${args.message_id}`);
                return { content: [{ type: 'text' as const, text: `Message ${args.message_id} updated.` }] };
            } catch (err) {
                log.error(`MCP discord_edit failed: ${err}`);
                return { content: [{ type: 'text' as const, text: `Failed to edit message: ${err}` }], isError: true };
            } finally {
                for (const tmp of tempFiles) unlink(tmp).catch(() => {});
            }
        },
    );

    const discordGetTool = tool(
        'discord_get',
        'Fetch a single Discord message by ID. Returns full message details including content, embeds, attachments, reactions, and metadata.',
        {
            message_id: z.string().describe('The message ID to fetch'),
            target: z.string().optional().describe('Channel/thread ID containing the message (defaults to current thread)'),
        },
        async (args) => {
            log(`MCP discord_get invoked: messageId=${args.message_id} target=${args.target || 'default'}`);
            const target = resolveTarget(args.target);

            try {
                const msg = await fetchMessage(target, args.message_id);
                return { content: [{ type: 'text' as const, text: JSON.stringify(msg, null, 2) }] };
            } catch (err) {
                log.error(`MCP discord_get failed: ${err}`);
                return { content: [{ type: 'text' as const, text: `Failed to fetch message: ${err}` }], isError: true };
            }
        },
    );

    const discordListTool = tool(
        'discord_list',
        'List messages in a channel/thread. Returns message summaries (ID, author, truncated content, timestamp, etc.). Supports pagination via before/after/around.',
        {
            limit: z.number().optional().describe('Max messages to return (1-100, default 25)'),
            before: z.string().optional().describe('Get messages before this message ID'),
            after: z.string().optional().describe('Get messages after this message ID'),
            around: z.string().optional().describe('Get messages around this message ID'),
            target: z.string().optional().describe('Channel/thread ID to list from (defaults to current thread)'),
        },
        async (args) => {
            log(`MCP discord_list invoked: limit=${args.limit ?? 25} target=${args.target || 'default'}`);
            const target = resolveTarget(args.target);

            try {
                const limit = Math.min(Math.max(args.limit ?? 25, 1), 100);
                const msgs = await fetchMessages(target, {
                    limit,
                    before: args.before,
                    after: args.after,
                    around: args.around,
                });
                return { content: [{ type: 'text' as const, text: JSON.stringify(msgs, null, 2) }] };
            } catch (err) {
                log.error(`MCP discord_list failed: ${err}`);
                return { content: [{ type: 'text' as const, text: `Failed to list messages: ${err}` }], isError: true };
            }
        },
    );

    const discordCreateThreadTool = tool(
        'discord_create_thread',
        'Create a new thread in a channel. Defaults to the parent channel (not current thread, since threads cannot nest). Optionally attach to an existing message or send an initial message.',
        {
            name: z.string().describe('Thread name (max 100 characters)'),
            message_id: z.string().optional().describe('Message ID to start thread from (creates thread attached to that message)'),
            message: z.string().optional().describe('Initial message to send in the new thread'),
            auto_archive_duration: z.number().optional().describe('Auto-archive after minutes of inactivity (60, 1440, 4320, 10080). Default: 1440'),
            target: z.string().optional().describe('Channel ID to create thread in (defaults to parent channel)'),
        },
        async (args) => {
            log(`MCP discord_create_thread invoked: name="${args.name}" target=${args.target || 'parent'}`);
            // Default to parentChannelId for thread creation (threads can't nest)
            const target = args.target || parentChannelId;

            try {
                const result = await createThread(target, {
                    name: truncateCodePoints(args.name, 100),
                    messageId: args.message_id,
                    autoArchiveDuration: args.auto_archive_duration,
                    message: args.message,
                });
                log(`MCP discord_create_thread succeeded: threadId=${result.threadId}`);

                // Send a clickable reference in the source thread so the user can navigate
                if (sourceThreadId && sourceThreadId !== target) {
                    await sendRichMessage(sourceThreadId, `Thread created: <#${result.threadId}>`)
                        .catch(err => log.error(`Failed to send thread ref to ${sourceThreadId}: ${err}`));
                }

                return { content: [{ type: 'text' as const, text: JSON.stringify({ thread_id: result.threadId, name: result.name, message_id: result.messageId || null }) }] };
            } catch (err) {
                log.error(`MCP discord_create_thread failed: ${err}`);
                return { content: [{ type: 'text' as const, text: `Failed to create thread: ${err}` }], isError: true };
            }
        },
    );

    const discordSetTitleTool = tool(
        'discord_set_title',
        'Set or auto-generate the title of a Discord thread. If no title is provided, auto-generates one from conversation context using AI. The title should be short (max 8 words) and start with an emoji.',
        {
            title: z.string().optional().describe('The title to set (max 8 words, should start with an emoji). If omitted, auto-generates from conversation.'),
            target: z.string().optional().describe('Thread ID to rename (defaults to current thread)'),
        },
        async (args) => {
            // Default to sourceThreadId for title operations
            const target = args.target || sourceThreadId;
            log(`MCP discord_set_title invoked: target=${target || 'none'} title="${args.title || '(auto)'}"`);

            if (!target) {
                log.warn('MCP discord_set_title: no thread context available');
                return { content: [{ type: 'text' as const, text: 'No thread context available.' }], isError: true };
            }

            try {
                let title: string;
                if (args.title) {
                    title = truncateCodePoints(args.title.trim(), 100);
                } else {
                    // Auto-generate title from session
                    const sessionId = getSessionId?.();
                    if (!sessionId) {
                        return { content: [{ type: 'text' as const, text: 'Cannot auto-generate title: no active session.' }], isError: true };
                    }
                    const generated = await generateTitle(sessionId, workingDir);
                    if (!generated) {
                        return { content: [{ type: 'text' as const, text: 'Title generation returned empty result.' }], isError: true };
                    }
                    title = truncateCodePoints(generated.trim(), 100);
                }

                setThreadTitle(target, title);
                // Fire-and-forget: Discord rate-limits thread renames (2/10min),
                // so don't block the tool response on the API call
                renameThread(target, title).catch(err =>
                    log.error(`Failed to rename thread ${target}: ${err}`)
                );
                log(`MCP discord_set_title succeeded: thread=${target} title="${title}"`);
                return { content: [{ type: 'text' as const, text: `Title saved: ${title} (Discord rename is async — may take a moment due to rate limits)` }] };
            } catch (err) {
                log.error(`MCP discord_set_title failed: ${err}`);
                return { content: [{ type: 'text' as const, text: `Failed to set title: ${err}` }], isError: true };
            }
        },
    );

    const discordChannelsTool = tool(
        'discord_channels',
        'List all channels and categories in the server, returned as a tree structure. Categories contain their child channels. Each entry includes id, name, type (text/voice/forum/announcement/stage/media/category), position, and optional topic.',
        {},
        async () => {
            log('MCP discord_channels invoked');
            // Use parentChannelId to resolve the guild
            const target = sourceThreadId || parentChannelId;
            try {
                const tree = await fetchChannelTree(target);
                return { content: [{ type: 'text' as const, text: JSON.stringify(tree, null, 2) }] };
            } catch (err) {
                log.error(`MCP discord_channels failed: ${err}`);
                return { content: [{ type: 'text' as const, text: `Failed to list channels: ${err}` }], isError: true };
            }
        },
    );

    const discordThreadsTool = tool(
        'discord_threads',
        'List threads in a channel. Returns active threads by default. Set archived=true to also include recently archived threads (up to 25). Each entry includes id, name, archived, locked, message_count, created_at, archive_at.',
        {
            target: z.string().optional().describe('Channel ID to list threads from (defaults to parent channel of current thread)'),
            archived: z.boolean().optional().describe('Also include archived threads (default: false)'),
        },
        async (args) => {
            const target = args.target || parentChannelId;
            log(`MCP discord_threads invoked: target=${target} archived=${args.archived ?? false}`);
            try {
                const threads = await fetchThreads(target, { archived: args.archived });
                return { content: [{ type: 'text' as const, text: JSON.stringify(threads, null, 2) }] };
            } catch (err) {
                log.error(`MCP discord_threads failed: ${err}`);
                return { content: [{ type: 'text' as const, text: `Failed to list threads: ${err}` }], isError: true };
            }
        },
    );

    const discordReactTool = tool(
        'discord_react',
        'Add an emoji reaction to a message. Use standard emoji (e.g. "👍", "🎉") or custom emoji in the format "<:name:id>".',
        {
            message_id: z.string().describe('The message ID to react to'),
            emoji: z.string().describe('Emoji to react with (e.g. "👍", "🔥", "✅")'),
            target: z.string().optional().describe('Channel/thread ID containing the message (defaults to current thread)'),
        },
        async (args) => {
            log(`MCP discord_react invoked: messageId=${args.message_id} emoji=${args.emoji}`);
            const target = resolveTarget(args.target);
            try {
                await addReaction(target, args.message_id, args.emoji);
                return { content: [{ type: 'text' as const, text: `Reacted with ${args.emoji}` }] };
            } catch (err) {
                log.error(`MCP discord_react failed: ${err}`);
                return { content: [{ type: 'text' as const, text: `Failed to add reaction: ${err}` }], isError: true };
            }
        },
    );

    const discordUnreactTool = tool(
        'discord_unreact',
        "Remove the bot's own reaction from a message.",
        {
            message_id: z.string().describe('The message ID to remove reaction from'),
            emoji: z.string().describe('Emoji to remove (must match exactly what was added)'),
            target: z.string().optional().describe('Channel/thread ID containing the message (defaults to current thread)'),
        },
        async (args) => {
            log(`MCP discord_unreact invoked: messageId=${args.message_id} emoji=${args.emoji}`);
            const target = resolveTarget(args.target);
            try {
                await removeReaction(target, args.message_id, args.emoji);
                return { content: [{ type: 'text' as const, text: `Removed reaction ${args.emoji}` }] };
            } catch (err) {
                log.error(`MCP discord_unreact failed: ${err}`);
                return { content: [{ type: 'text' as const, text: `Failed to remove reaction: ${err}` }], isError: true };
            }
        },
    );

    const discordDeleteTool = tool(
        'discord_delete',
        "Delete a message. The bot can only delete its own messages, or messages in channels where it has Manage Messages permission.",
        {
            message_id: z.string().describe('The message ID to delete'),
            target: z.string().optional().describe('Channel/thread ID containing the message (defaults to current thread)'),
        },
        async (args) => {
            log(`MCP discord_delete invoked: messageId=${args.message_id}`);
            const target = resolveTarget(args.target);
            try {
                await deleteMessage(target, args.message_id);
                return { content: [{ type: 'text' as const, text: `Message ${args.message_id} deleted.` }] };
            } catch (err) {
                log.error(`MCP discord_delete failed: ${err}`);
                return { content: [{ type: 'text' as const, text: `Failed to delete message: ${err}` }], isError: true };
            }
        },
    );

    return createSdkMcpServer({
        name: 'disclaw',
        tools: [
            cronCreateTool, cronListTool, cronDeleteTool, cronUpdateTool, cronRunNowTool,
            discordSendTool, discordEditTool, discordGetTool, discordListTool,
            discordCreateThreadTool, discordSetTitleTool,
            discordReactTool, discordUnreactTool, discordDeleteTool,
            discordChannelsTool, discordThreadsTool,
        ],
    });
}
