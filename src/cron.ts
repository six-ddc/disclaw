/**
 * Cron Scheduler - Manages scheduled tasks with croner
 *
 * Provides CronScheduler class for job lifecycle management and
 * a factory function to create an SDK MCP server exposing cron tools.
 */

import { resolve } from 'path';
import { Cron } from 'croner';
import { z } from 'zod/v4';
import {
    createSdkMcpServer,
    tool,
    type McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';
import {
    type Client,
    TextChannel,
    ThreadAutoArchiveDuration,
} from 'discord.js';
import { runner } from './runner.js';
import {
    db,
    createCronJob,
    getCronJob,
    listCronJobs,
    setCronJobEnabled,
    setCronJobLastRun,
    deleteCronJob,
    updateCronJob,
    getThreadMapping,
    getChannelConfigCached,
    setThreadTitle,
    cronJobDisplayName,
    type CronJob,
} from './db.js';
import { sendEmbed, renameThread, truncateCodePoints } from './discord.js';
import { sendCronControlPanel } from './cron-buttons.js';
import { generateTitle } from './claude-client.js';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

const log = (msg: string) => process.stdout.write(`[cron] ${msg}\n`);

const TIMEZONE = process.env.TZ;
const MAX_FAILURES = 3;

export class CronScheduler {
    private jobs = new Map<string, Cron>();
    private failures = new Map<string, number>();
    private client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    /** Load all enabled jobs from DB and register them, catching up missed runs */
    loadAll(): void {
        const jobs = listCronJobs();
        let count = 0;
        const missed: string[] = [];
        for (const job of jobs) {
            if (job.enabled) {
                this.register(job);
                count++;
                // Check if a run was missed while the server was down
                if (job.last_run_at) {
                    try {
                        const lastRun = new Date(job.last_run_at);
                        // Compute when the next run should have been after last_run_at
                        const expectedNext = new Cron(job.schedule, {
                            ...(TIMEZONE ? { timezone: TIMEZONE } : {}),
                        }).nextRun(lastRun);
                        if (expectedNext && expectedNext < new Date()) {
                            missed.push(job.job_id);
                        }
                    } catch {}
                }
            }
        }
        log(`Loaded ${count} cron jobs`);
        if (missed.length > 0) {
            log(`Catching up ${missed.length} missed job(s): ${missed.join(', ')}`);
            for (const jobId of missed) {
                this.execute(jobId);
            }
        }
    }

    /** Register a croner instance for a job */
    register(job: CronJob): void {
        // Stop existing if any
        this.unregister(job.job_id);

        try {
            const cron = new Cron(job.schedule, {
                ...(TIMEZONE ? { timezone: TIMEZONE } : {}),
            }, () => {
                this.execute(job.job_id);
            });
            this.jobs.set(job.job_id, cron);
            log(`Registered job ${job.job_id}: ${job.schedule}`);
        } catch (err) {
            log(`Failed to register job ${job.job_id}: ${err}`);
        }
    }

    /** Stop and remove a croner instance */
    private unregister(jobId: string): void {
        const existing = this.jobs.get(jobId);
        if (existing) {
            existing.stop();
            this.jobs.delete(jobId);
        }
    }

    /** Execute a scheduled job */
    private async execute(jobId: string): Promise<void> {
        const job = getCronJob(jobId);
        if (!job || !job.enabled) return;

        log(`Executing job ${jobId}: ${job.prompt.slice(0, 50)}`);

        // Record execution time
        setCronJobLastRun(jobId);

        // Get thread info for working dir and model
        const mapping = getThreadMapping(job.thread_id);
        const workingDir = resolve(mapping?.working_dir ||
            getChannelConfigCached(job.thread_id)?.working_dir ||
            process.env.CLAUDE_WORKING_DIR ||
            process.cwd());

        // Send separator embed
        const now = new Date();
        const timeStr = now.toLocaleString('en-US', {
            month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', hour12: true,
            ...(TIMEZONE ? { timeZone: TIMEZONE } : {}),
        });
        await sendEmbed(job.thread_id, [{
            color: 0x5865f2,
            description: `**Scheduled Run** · ${timeStr}`,
        }]).catch(err => log(`Failed to send separator: ${err}`));

        // Submit to runner (no sessionId — SDK auto-generates; persistSession: false to avoid filesystem clutter)
        runner.submit({
            prompt: job.prompt,
            threadId: job.thread_id,
            resume: false,
            persistSession: false,
            permissionMode: 'bypassPermissions',
            userId: job.creator_id,
            username: 'cron',
            workingDir,
            model: mapping?.model || undefined,
            verbose: !!job.verbose,
            onComplete: (error) => {
                if (error) {
                    const count = (this.failures.get(jobId) || 0) + 1;
                    this.failures.set(jobId, count);
                    log(`Job ${jobId} failed (${count}/${MAX_FAILURES}): ${error.message}`);

                    if (count >= MAX_FAILURES) {
                        log(`Auto-pausing job ${jobId} after ${MAX_FAILURES} consecutive failures`);
                        this.pause(jobId);
                        sendEmbed(job.thread_id, [{
                            color: 0xff4444,
                            title: 'Scheduled Task Auto-Paused',
                            description: `Paused after ${MAX_FAILURES} consecutive failures.\nLast error: ${truncateCodePoints(error.message, 200)}`,
                        }]).catch(() => {});
                    }
                } else {
                    // Reset failure count on success
                    this.failures.delete(jobId);
                }
            },
        });
    }

    /** Pause a job */
    pause(jobId: string): boolean {
        const job = getCronJob(jobId);
        if (!job) return false;
        setCronJobEnabled(jobId, false);
        this.unregister(jobId);
        this.failures.delete(jobId);
        log(`Paused job ${jobId}`);
        return true;
    }

    /** Resume a paused job */
    resume(jobId: string): boolean {
        const job = getCronJob(jobId);
        if (!job) return false;
        setCronJobEnabled(jobId, true);
        this.register(job);
        this.failures.delete(jobId);
        log(`Resumed job ${jobId}`);
        return true;
    }

    /** Delete a job completely */
    delete(jobId: string): boolean {
        this.unregister(jobId);
        this.failures.delete(jobId);
        const job = getCronJob(jobId);
        if (!job) return false;
        deleteCronJob(jobId);
        log(`Deleted job ${jobId}`);
        return true;
    }

    /** Run a job immediately (outside schedule) */
    runNow(jobId: string): boolean {
        const job = getCronJob(jobId);
        if (!job) return false;
        this.execute(jobId);
        return true;
    }

    /** Get next run time for a job */
    getNextRun(jobId: string): Date | null {
        const cron = this.jobs.get(jobId);
        if (!cron) return null;
        return cron.nextRun() || null;
    }

    /** Create a job with a dedicated Discord thread */
    async createJobWithThread(params: {
        parentChannelId: string;
        creatorId: string;
        schedule: string;
        prompt: string;
        workingDir: string;
        model?: string;
        name?: string;
    }): Promise<{ jobId: string; threadId: string }> {
        const jobId = crypto.randomUUID().slice(0, 8);

        // Create thread in parent channel
        const parentChannel = await this.client.channels.fetch(params.parentChannelId);
        if (!parentChannel?.isTextBased() || !(parentChannel instanceof TextChannel)) {
            throw new Error('Parent channel is not a text channel');
        }

        // Use explicit name or fall back to prompt prefix
        const displayName = params.name || params.prompt;
        const threadName = truncateCodePoints(
            `\u{23F0} ${displayName}`,
            50,
        );

        const statusMessage = await parentChannel.send(
            `Scheduled task created: \`${params.schedule}\``
        );

        const thread = await statusMessage.startThread({
            name: threadName,
            autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        });

        // Store thread mapping (empty session_id — first message or cron execution will create one)
        // Pre-set title to prevent auto-title generation from overriding it
        db.run(
            'INSERT INTO threads (thread_id, session_id, working_dir, model, title) VALUES (?, ?, ?, ?, ?)',
            [thread.id, '', params.workingDir, params.model || null, threadName]
        );

        // Store cron job
        createCronJob(jobId, thread.id, params.creatorId, params.schedule, params.prompt, params.name);

        // Register croner
        const job = getCronJob(jobId)!;
        this.register(job);

        // Send control panel
        const nextRun = this.getNextRun(jobId);
        await sendCronControlPanel(thread.id, job, nextRun);

        log(`Created job ${jobId} in thread ${thread.id}`);
        return { jobId, threadId: thread.id };
    }

    /** Stop all cron jobs */
    stopAll(): void {
        for (const [jobId, cron] of this.jobs) {
            cron.stop();
            log(`Stopped job ${jobId}`);
        }
        this.jobs.clear();
        this.failures.clear();
        log('All jobs stopped');
    }
}

// =========================================================================
// MODULE-LEVEL SINGLETON
// =========================================================================

let scheduler: CronScheduler | null = null;

export function initCronScheduler(client: Client): void {
    scheduler = new CronScheduler(client);
    scheduler.loadAll();
}

export function getCronScheduler(): CronScheduler {
    if (!scheduler) throw new Error('CronScheduler not initialized');
    return scheduler;
}

// =========================================================================
// SDK MCP SERVER FACTORY
// =========================================================================

/**
 * Create a cron MCP server bound to a specific parent channel and user.
 * Each query() call gets its own instance so the tool handler knows context.
 */
export function createCronMcpServer(
    parentChannelId: string,
    userId: string,
    workingDir: string,
    model?: string,
    sourceThreadId?: string,
): McpSdkServerConfigWithInstance {
    const sched = getCronScheduler();

    // Resolve display timezone for tool descriptions
    const tzLabel = TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

    const cronCreateTool = tool(
        'cron_create',
        `Create a scheduled task that runs on a cron schedule. The task will execute in a dedicated Discord thread. Use standard cron expressions (e.g. "0 9 * * *" for daily at 9am, "*/30 * * * *" for every 30 minutes). IMPORTANT: All times are in the server's local timezone (${tzLabel}). Do NOT convert to UTC.`,
        {
            schedule: z.string().describe('Cron expression (e.g. "0 9 * * *" for daily at 9am)'),
            prompt: z.string().describe('The prompt/instruction to execute on each run'),
            name: z.string().optional().describe('Short display name for the task (used in thread title and listings). If omitted, the prompt is used as fallback.'),
        },
        async (args) => {
            // Validate cron expression
            try {
                new Cron(args.schedule);
            } catch (err) {
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

                // Send reference in the source thread
                if (sourceThreadId) {
                    await sendEmbed(sourceThreadId, [{
                        color: 0x5865f2,
                        title: 'Scheduled Task Created',
                        description: `\`${args.schedule}\` → <#${result.threadId}>`,
                        footer: { text: `Job ID: ${result.jobId}` },
                    }]).catch(err => log(`Failed to send cron ref: ${err}`));
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
            const jobs = listCronJobs();
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
            const deleted = sched.delete(args.job_id);
            if (!deleted) {
                return {
                    content: [{ type: 'text' as const, text: `Job not found: ${args.job_id}` }],
                    isError: true,
                };
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
            const job = getCronJob(args.job_id);
            if (!job) {
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
            }

            // Update thread name if name changed
            if (args.name !== undefined) {
                const newThreadName = truncateCodePoints(`\u{23F0} ${args.name}`, 50);
                await renameThread(job.thread_id, newThreadName).catch(() => {});
                setThreadTitle(job.thread_id, newThreadName);
            }

            const changed = Object.keys(fields).join(', ');
            return {
                content: [{ type: 'text' as const, text: `Updated job ${args.job_id}: ${changed}` }],
            };
        },
    );

    const titleGenerateTool = tool(
        'title_generate',
        'Regenerate or update the title of the current Discord thread. Fetches the latest conversation context and generates a short emoji-prefixed title. Use when the user asks to update, regenerate, or change the thread title.',
        {},
        async () => {
            if (!sourceThreadId) {
                return {
                    content: [{ type: 'text' as const, text: 'No thread context available.' }],
                    isError: true,
                };
            }

            try {
                // Get current session ID for this thread
                const mapping = getThreadMapping(sourceThreadId);
                if (!mapping?.session_id) {
                    return {
                        content: [{ type: 'text' as const, text: 'No session found for this thread.' }],
                        isError: true,
                    };
                }

                // Fetch session messages and extract last 5 turns (10 messages)
                const rawMessages = await getSessionMessages(mapping.session_id, { dir: workingDir });

                interface MessageEntry { type: 'user' | 'assistant'; message?: { content?: unknown } }
                const entries: Array<{ role: string; text: string }> = [];
                for (const msg of rawMessages as MessageEntry[]) {
                    if (msg.type !== 'user' && msg.type !== 'assistant') continue;
                    const content = msg.message?.content;
                    let text = '';
                    if (typeof content === 'string') {
                        text = content;
                    } else if (Array.isArray(content)) {
                        text = content
                            .filter((c: { type?: string }) => c.type === 'text')
                            .map((c: { text?: string }) => c.text || '')
                            .join('');
                    }
                    if (text.trim()) {
                        entries.push({ role: msg.type, text });
                    }
                }

                // Take last 5 turns (last 10 entries)
                const recentEntries = entries.slice(-10);

                if (recentEntries.length === 0) {
                    return {
                        content: [{ type: 'text' as const, text: 'No conversation content found.' }],
                        isError: true,
                    };
                }

                const title = await generateTitle(recentEntries);
                if (!title) {
                    return {
                        content: [{ type: 'text' as const, text: 'Failed to generate title.' }],
                        isError: true,
                    };
                }

                // Update DB and Discord thread name
                setThreadTitle(sourceThreadId, title);
                await renameThread(sourceThreadId, truncateCodePoints(title, 100));

                return {
                    content: [{ type: 'text' as const, text: `Title updated: ${title}` }],
                };
            } catch (err) {
                return {
                    content: [{ type: 'text' as const, text: `Failed to generate title: ${err}` }],
                    isError: true,
                };
            }
        },
    );

    return createSdkMcpServer({
        name: 'disclaw',
        tools: [cronCreateTool, cronListTool, cronDeleteTool, cronUpdateTool, titleGenerateTool],
    });
}
