/**
 * Cron Scheduler - Manages scheduled tasks with croner
 *
 * Provides CronScheduler class for job lifecycle management.
 * MCP server factory is in mcp-server.ts.
 */

import { Cron } from 'croner';
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
    getThreadMapping,
    type CronJob,
} from './db.js';
import { sendEmbed, truncateCodePoints } from './discord.js';
import { sendCronControlPanel } from './cron-buttons.js';
import { createLogger } from './logger.js';
import { resolveWorkingDirWithMapping } from './working-dir.js';

const log = createLogger('cron');

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
        log.debug(`Found ${jobs.length} total cron jobs in DB`);
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
                    } catch (err) {
                        log.warn(`Failed to check missed run for job ${job.job_id}: ${err}`);
                    }
                }
            } else {
                log.debug(`Skipping disabled job ${job.job_id}`);
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
            log.debug(`Unregistered croner instance for job ${jobId}`);
        }
    }

    /** Execute a scheduled job */
    private async execute(jobId: string): Promise<void> {
        const job = getCronJob(jobId);
        if (!job || !job.enabled) {
            log.debug(`Skipping execution for job ${jobId}: ${!job ? 'not found' : 'disabled'}`);
            return;
        }

        log(`Executing job ${jobId} (thread=${job.thread_id}): ${job.prompt.slice(0, 80)}`);

        // Record execution time
        setCronJobLastRun(jobId);

        // Get thread info for working dir and model
        const mapping = getThreadMapping(job.thread_id);
        const workingDir = resolveWorkingDirWithMapping(mapping?.working_dir ?? null, job.thread_id);

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
        }]).catch(err => log.error(`Failed to send separator for job ${jobId}: ${err}`));

        // Resolve parent channel for status message updates
        // Thread ID === starter message ID (Discord creates threads from messages)
        let parentChannelId: string | undefined;
        try {
            const thread = await this.client.channels.fetch(job.thread_id);
            parentChannelId = thread?.isThread() ? thread.parentId || undefined : undefined;
        } catch (err) {
            log.warn(`Failed to fetch thread ${job.thread_id} for parent channel: ${err}`);
        }

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
            parentChannelId,
            statusMessageId: parentChannelId ? job.thread_id : undefined,
            onComplete: (error) => {
                if (error) {
                    const count = (this.failures.get(jobId) || 0) + 1;
                    this.failures.set(jobId, count);
                    log.error(`Job ${jobId} failed (${count}/${MAX_FAILURES}): ${error.message}`);

                    if (count >= MAX_FAILURES) {
                        log.warn(`Auto-pausing job ${jobId} after ${MAX_FAILURES} consecutive failures`);
                        this.pause(jobId);
                        sendEmbed(job.thread_id, [{
                            color: 0xff4444,
                            title: 'Scheduled Task Auto-Paused',
                            description: `Paused after ${MAX_FAILURES} consecutive failures.\nLast error: ${truncateCodePoints(error.message, 200)}`,
                        }]).catch(err => log.error(`Failed to send auto-pause embed for job ${jobId}: ${err}`));
                    }
                } else {
                    // Reset failure count on success
                    this.failures.delete(jobId);
                    log(`Job ${jobId} completed successfully`);
                }
            },
        });
    }

    /** Pause a job */
    pause(jobId: string): boolean {
        const job = getCronJob(jobId);
        if (!job) {
            log.warn(`Cannot pause job ${jobId}: not found`);
            return false;
        }
        setCronJobEnabled(jobId, false);
        this.unregister(jobId);
        this.failures.delete(jobId);
        log(`Paused job ${jobId}`);
        return true;
    }

    /** Resume a paused job */
    resume(jobId: string): boolean {
        const job = getCronJob(jobId);
        if (!job) {
            log.warn(`Cannot resume job ${jobId}: not found`);
            return false;
        }
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
        if (!job) {
            log.warn(`Cannot delete job ${jobId}: not found`);
            return false;
        }
        deleteCronJob(jobId);
        log(`Deleted job ${jobId}`);
        return true;
    }

    /** Run a job immediately (outside schedule) */
    runNow(jobId: string): boolean {
        const job = getCronJob(jobId);
        if (!job) {
            log.warn(`Cannot run job ${jobId}: not found`);
            return false;
        }
        log(`Manual run triggered for job ${jobId}`);
        this.execute(jobId);
        return true;
    }

    /** Get next run time for a job */
    getNextRun(jobId: string): Date | null {
        const cron = this.jobs.get(jobId);
        if (!cron) {
            log.debug(`No croner instance for job ${jobId}, cannot get next run`);
            return null;
        }
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
        log(`Creating job ${jobId} in channel ${params.parentChannelId} (schedule=${params.schedule})`);

        const parentChannel = await this.client.channels.fetch(params.parentChannelId);
        if (!parentChannel?.isTextBased() || !(parentChannel instanceof TextChannel)) {
            log.error(`Cannot create job ${jobId}: channel ${params.parentChannelId} is not a text channel`);
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
            'INSERT INTO threads (thread_id, session_id, working_dir, model, title, display_mode) VALUES (?, ?, ?, ?, ?, ?)',
            [thread.id, '', params.workingDir, params.model || null, threadName, 'simple']
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
    log('Initializing CronScheduler');
    scheduler = new CronScheduler(client);
    scheduler.loadAll();
    log('CronScheduler initialized');
}

export function getCronScheduler(): CronScheduler {
    if (!scheduler) throw new Error('CronScheduler not initialized');
    return scheduler;
}

