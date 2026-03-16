/**
 * MCP Server Factory - Creates SDK MCP servers for Claude Agent queries
 *
 * Provides tools for cron management, thread control, and Discord media
 * sending. Each query() call gets a fresh instance bound to the
 * requesting thread/channel/user context.
 */

import { resolve, isAbsolute } from 'path';
import { existsSync, statSync } from 'fs';
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
import { sendEmbed, sendImageEmbed, sendMediaAttachment, sendFileAttachment, renameThread, truncateCodePoints } from './discord.js';
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
    'log', 'env.example', 'ini', 'conf', 'cfg',
    // Images/media (fallback for discord_send_file)
    ...ALLOWED_IMAGE_EXTS, ...ALLOWED_MEDIA_EXTS,
]);

/** Get lowercase file extension from a path or URL */
function getFileExt(pathOrUrl: string): string {
    const basename = pathOrUrl.split('/').pop() || '';
    const dotIdx = basename.lastIndexOf('.');
    return dotIdx >= 0 ? basename.slice(dotIdx + 1).toLowerCase() : '';
}

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
): McpSdkServerConfigWithInstance {
    const sched = getCronScheduler();

    // Resolve display timezone for tool descriptions
    const tzLabel = TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

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
                await renameThread(job.thread_id, newThreadName).catch(err => log.error(`Failed to rename thread for job ${args.job_id}: ${err}`));
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
    // Thread tools
    // =====================================================================

    const titleGenerateTool = tool(
        'title_generate',
        'Regenerate or update the title of the current Discord thread. Clears the current title so it will be regenerated when this query completes. Use when the user asks to update, regenerate, or change the thread title.',
        {},
        async () => {
            log.debug(`MCP title_generate invoked (sourceThreadId=${sourceThreadId || 'none'})`);
            if (!sourceThreadId) {
                log.warn('MCP title_generate: no thread context available');
                return {
                    content: [{ type: 'text' as const, text: 'No thread context available.' }],
                    isError: true,
                };
            }

            // Clear the title — runner will regenerate it after this query completes
            setThreadTitle(sourceThreadId, '');
            log(`Title cleared for thread ${sourceThreadId}, will regenerate on query completion`);

            return {
                content: [{ type: 'text' as const, text: 'Title will be regenerated when this response completes.' }],
            };
        },
    );

    // =====================================================================
    // Discord media tools
    // =====================================================================

    /** Guard: require thread context */
    function requireThread(toolName: string): string | { content: Array<{ type: 'text'; text: string }>; isError: true } {
        if (!sourceThreadId) {
            log.warn(`MCP ${toolName}: no thread context`);
            return {
                content: [{ type: 'text' as const, text: 'No thread context available. This tool can only be used within a Discord thread.' }],
                isError: true,
            };
        }
        return sourceThreadId;
    }

    /** Resolve a source that could be a URL or local path. Returns resolved path or URL string. */
    function resolveSource(source: string): { type: 'url'; value: string } | { type: 'file'; value: string } {
        if (/^https?:\/\//.test(source)) return { type: 'url', value: source };
        const resolved = isAbsolute(source) ? source : resolve(workingDir, source);
        return { type: 'file', value: resolved };
    }

    /** Validate a local file: extension whitelist + exists + size check. Returns error result or null. */
    function validateFile(path: string, toolName: string, allowedExts: Set<string>): { content: Array<{ type: 'text'; text: string }>; isError: true } | null {
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
    function validateUrlExt(url: string, toolName: string, allowedExts: Set<string>): { content: Array<{ type: 'text'; text: string }>; isError: true } | null {
        const ext = getFileExt(url);
        if (!ext || !allowedExts.has(ext)) {
            log.warn(`MCP ${toolName}: blocked URL extension ".${ext}": ${url}`);
            return { content: [{ type: 'text' as const, text: `URL file type ".${ext}" is not allowed. Allowed: ${[...allowedExts].join(', ')}` }], isError: true };
        }
        return null;
    }

    const discordSendImageTool = tool(
        'discord_send_image',
        'Send an image to the current Discord thread, rendered inline as a rich embed preview. Accepts a local file path (absolute or relative) or an HTTP(S) URL. Supported formats: PNG, JPG, GIF, WebP, AVIF. Local files max 25MB.',
        {
            source: z.string().describe('Image file path or URL (e.g. "/tmp/chart.png" or "https://example.com/img.png")'),
            title: z.string().optional().describe('Optional title shown above the image'),
            description: z.string().optional().describe('Optional description shown below the title'),
        },
        async (args) => {
            log(`MCP discord_send_image invoked: source=${args.source}`);
            const thread = requireThread('discord_send_image');
            if (typeof thread !== 'string') return thread;

            const src = resolveSource(args.source);
            if (src.type === 'file') {
                const err = validateFile(src.value, 'discord_send_image', ALLOWED_IMAGE_EXTS);
                if (err) return err;
            } else {
                const err = validateUrlExt(src.value, 'discord_send_image', ALLOWED_IMAGE_EXTS);
                if (err) return err;
            }

            try {
                const msgId = await sendImageEmbed(thread, src.value, {
                    title: args.title,
                    description: args.description,
                });
                log(`MCP discord_send_image succeeded: source=${src.value}, msgId=${msgId}`);
                return { content: [{ type: 'text' as const, text: 'Image sent and rendered in Discord.' }] };
            } catch (err) {
                log.error(`MCP discord_send_image failed: ${err}`);
                return { content: [{ type: 'text' as const, text: `Failed to send image: ${err}` }], isError: true };
            }
        },
    );

    const discordSendMediaTool = tool(
        'discord_send_media',
        'Send audio or video to the current Discord thread with a native inline player. Accepts a local file path (absolute or relative) or an HTTP(S) URL. Discord auto-renders playable players for: MP3, WAV, OGG (audio), MP4, WebM (video). Local files max 25MB.',
        {
            source: z.string().describe('Audio/video file path or URL (e.g. "/tmp/music.mp3" or "https://example.com/video.mp4")'),
            content: z.string().optional().describe('Optional text message to accompany the media'),
        },
        async (args) => {
            log(`MCP discord_send_media invoked: source=${args.source}`);
            const thread = requireThread('discord_send_media');
            if (typeof thread !== 'string') return thread;

            const src = resolveSource(args.source);
            if (src.type === 'file') {
                const err = validateFile(src.value, 'discord_send_media', ALLOWED_MEDIA_EXTS);
                if (err) return err;
            } else {
                const err = validateUrlExt(src.value, 'discord_send_media', ALLOWED_MEDIA_EXTS);
                if (err) return err;
            }

            try {
                const msgId = await sendMediaAttachment(thread, src.value, {
                    content: args.content,
                });
                log(`MCP discord_send_media succeeded: source=${src.value}, msgId=${msgId}`);
                return { content: [{ type: 'text' as const, text: 'Media sent with inline player in Discord.' }] };
            } catch (err) {
                log.error(`MCP discord_send_media failed: ${err}`);
                return { content: [{ type: 'text' as const, text: `Failed to send media: ${err}` }], isError: true };
            }
        },
    );

    const discordSendFileTool = tool(
        'discord_send_file',
        'Send a file as a downloadable attachment to the current Discord thread. For non-previewable files like PDF, Markdown, ZIP, CSV, logs, etc. Local files only, max 25MB. Use discord_send_image for images and discord_send_media for audio/video instead.',
        {
            file_path: z.string().describe('Absolute or relative path to the file to send'),
            message: z.string().optional().describe('Optional text message to accompany the file'),
            filename: z.string().optional().describe('Override the displayed filename (e.g. "report.pdf")'),
        },
        async (args) => {
            log(`MCP discord_send_file invoked: file=${args.file_path}`);
            const thread = requireThread('discord_send_file');
            if (typeof thread !== 'string') return thread;

            const resolved = isAbsolute(args.file_path) ? args.file_path : resolve(workingDir, args.file_path);
            const err = validateFile(resolved, 'discord_send_file', ALLOWED_FILE_EXTS);
            if (err) return err;

            try {
                const msgId = await sendFileAttachment(thread, resolved, {
                    content: args.message,
                    filename: args.filename,
                });
                log(`MCP discord_send_file succeeded: file=${resolved}, msgId=${msgId}`);
                return { content: [{ type: 'text' as const, text: 'File sent as attachment in Discord.' }] };
            } catch (err) {
                log.error(`MCP discord_send_file failed: ${err}`);
                return { content: [{ type: 'text' as const, text: `Failed to send file: ${err}` }], isError: true };
            }
        },
    );

    return createSdkMcpServer({
        name: 'disclaw',
        tools: [cronCreateTool, cronListTool, cronDeleteTool, cronUpdateTool, cronRunNowTool, titleGenerateTool, discordSendImageTool, discordSendMediaTool, discordSendFileTool],
    });
}
