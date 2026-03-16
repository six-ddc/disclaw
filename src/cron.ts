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
import { buildControlEmbed, buildButtons, updateCronControlPanel } from './cron-buttons.js';
import { createLogger } from './logger.js';
import { resolveWorkingDirWithMapping } from './working-dir.js';

const log = createLogger('cron');

const TIMEZONE = process.env.TZ;
const MAX_FAILURES = 3;
const EXECUTION_TIMEOUT_MS = 15 * 60 * 1000;  // 15 minutes
const TIMEOUT_CHECK_INTERVAL_MS = 60 * 1000;  // check every 60s

export class CronScheduler {
    private jobs = new Map<string, Cron>();
    private failures = new Map<string, number>();
    private client: Client;
    /** Tracks when each executing job started (jobId → timestamp) */
    private executionStarts = new Map<string, number>();
    private timeoutChecker: ReturnType<typeof setInterval> | null = null;

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

        // Start execution timeout checker
        this.startTimeoutChecker();
    }

    /** Periodically check for cron jobs that have exceeded the execution timeout */
    private startTimeoutChecker(): void {
        if (this.timeoutChecker) return;
        this.timeoutChecker = setInterval(() => {
            const now = Date.now();
            for (const [jobId, startTime] of this.executionStarts) {
                const elapsed = now - startTime;
                if (elapsed < EXECUTION_TIMEOUT_MS) continue;

                log.warn(`Job ${jobId} exceeded execution timeout (${Math.round(elapsed / 1000)}s)`);
                // Remove from tracking so onComplete knows it was timed out
                this.executionStarts.delete(jobId);

                const count = (this.failures.get(jobId) || 0) + 1;
                this.failures.set(jobId, count);

                const job = getCronJob(jobId);
                if (!job) continue;

                if (count >= MAX_FAILURES) {
                    log.warn(`Auto-pausing job ${jobId} after ${MAX_FAILURES} consecutive failures (timeout)`);
                    this.pause(jobId);
                    updateCronControlPanel(jobId).catch(err => log.error(`Failed to update panel after timeout auto-pause for job ${jobId}: ${err}`));
                    sendEmbed(job.thread_id, [{
                        color: 0xff4444,
                        title: 'Scheduled Task Auto-Paused',
                        description: `Paused after ${MAX_FAILURES} consecutive failures.\nLast: execution timed out (>${Math.round(EXECUTION_TIMEOUT_MS / 60000)} min)`,
                    }]).catch(err => log.error(`Failed to send timeout auto-pause embed for job ${jobId}: ${err}`));
                } else {
                    sendEmbed(job.thread_id, [{
                        color: 0xffaa00,
                        description: `\u26A0\uFE0F Execution timed out after ${Math.round(EXECUTION_TIMEOUT_MS / 60000)} min (failure ${count}/${MAX_FAILURES})`,
                    }]).catch(err => log.error(`Failed to send timeout warning for job ${jobId}: ${err}`));
                }
            }
        }, TIMEOUT_CHECK_INTERVAL_MS);
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

        // Track execution start for timeout detection
        this.executionStarts.set(jobId, Date.now());

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

        // Submit to runner (no sessionId — SDK auto-generates; persistSession: false to avoid filesystem clutter)
        // No statusMessageId/parentChannelId — starter message is the control panel, not overwritten
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
            onComplete: (error) => {
                // Check if timeout checker already handled this job
                const wasTimedOut = !this.executionStarts.has(jobId);
                this.executionStarts.delete(jobId);

                if (error) {
                    if (wasTimedOut) {
                        // Timeout checker already counted this failure — skip
                        log.debug(`Job ${jobId} errored after timeout — already counted`);
                        return;
                    }
                    const count = (this.failures.get(jobId) || 0) + 1;
                    this.failures.set(jobId, count);
                    log.error(`Job ${jobId} failed (${count}/${MAX_FAILURES}): ${error.message}`);

                    if (count >= MAX_FAILURES) {
                        log.warn(`Auto-pausing job ${jobId} after ${MAX_FAILURES} consecutive failures`);
                        this.pause(jobId);
                        updateCronControlPanel(jobId).catch(err => log.error(`Failed to update panel after auto-pause for job ${jobId}: ${err}`));
                        sendEmbed(job.thread_id, [{
                            color: 0xff4444,
                            title: 'Scheduled Task Auto-Paused',
                            description: `Paused after ${MAX_FAILURES} consecutive failures.\nLast error: ${truncateCodePoints(error.message, 200)}`,
                        }]).catch(err => log.error(`Failed to send auto-pause embed for job ${jobId}: ${err}`));
                    }
                } else {
                    // Success — reset failure count (even if it was timed out but completed late)
                    this.failures.delete(jobId);
                    log(`Job ${jobId} completed successfully${wasTimedOut ? ' (after timeout)' : ''}`);
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

        // Store cron job first (need jobId for buttons), then build panel
        createCronJob(jobId, '', params.creatorId, params.schedule, params.prompt, params.name);
        const job = getCronJob(jobId)!;
        this.register(job);

        // Send control panel as starter message, then create thread from it
        const nextRun = this.getNextRun(jobId);
        const embed = buildControlEmbed(job, nextRun);
        const buttons = buildButtons(job);
        const statusMessage = await parentChannel.send({ embeds: [embed], components: [buttons] });

        const thread = await statusMessage.startThread({
            name: threadName,
            autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        });

        // Update cron job with actual thread ID
        db.run('UPDATE cron_jobs SET thread_id = ? WHERE job_id = ?', [thread.id, jobId]);

        // Store thread mapping (empty session_id — first message or cron execution will create one)
        // Pre-set title to prevent auto-title generation from overriding it
        db.run(
            'INSERT INTO threads (thread_id, session_id, working_dir, model, title, display_mode) VALUES (?, ?, ?, ?, ?, ?)',
            [thread.id, '', params.workingDir, params.model || null, threadName, 'simple']
        );

        log(`Created job ${jobId} in thread ${thread.id}`);
        return { jobId, threadId: thread.id };
    }

    /** Stop all cron jobs */
    stopAll(): void {
        if (this.timeoutChecker) {
            clearInterval(this.timeoutChecker);
            this.timeoutChecker = null;
        }
        for (const [jobId, cron] of this.jobs) {
            cron.stop();
            log(`Stopped job ${jobId}`);
        }
        this.jobs.clear();
        this.failures.clear();
        this.executionStarts.clear();
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

