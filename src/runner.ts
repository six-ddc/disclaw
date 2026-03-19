/**
 * Runner - In-process job runner with concurrency control
 *
 * Uses an async semaphore pattern for concurrency control.
 * JS single-threaded execution guarantees submit() atomicity.
 */

import { queryClaudeSDK, generateTitle, StallError } from './claude-client.js';
import { createClaudeSender } from './discord-sender.js';
import { convertToClaudeMessages } from './message-converter.js';
import { sendToThread, editMessage, renameThread, truncateCodePoints, addReaction, removeReaction, sendTyping } from './discord.js';
import { type Query, type ModelInfo, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { getThreadMapping, resolveSessionState, updateThreadSession, updateThreadPermissionMode, getThreadTitle, setThreadTitle } from './db.js';
import { createCanUseTool, cleanupThread, pendingPlanApprovals } from './user-input.js';
import type { MultimodalPrompt, ContentBlock } from './attachment-handler.js';
import { createToolPager } from './tool-pager.js';
import type { DisplayMode, PermissionMode } from './types.js';
import { createLogger } from './logger.js';

/** Message types that bypass the pager and go directly to Discord as embeds */
const PAGER_BYPASS_TYPES = new Set(['system']);

export interface ClaudeJob {
    prompt: string | MultimodalPrompt;
    threadId: string;
    sessionId?: string;
    /** true=resume, false=new session, undefined=resolve from DB at execution time */
    resume?: boolean;
    userId: string;
    username: string;
    workingDir?: string;
    /** Channel ID containing the status message (for updating "Processing..." → result) */
    parentChannelId?: string;
    /** The status message ID to update on completion */
    statusMessageId?: string;
    model?: string;
    forkSession?: boolean;
    resumeSessionAt?: string;
    /** Factory that creates fresh MCP servers for each query() call (instances are single-use) */
    createMcpServers?: (getSessionId: () => string | undefined) => Record<string, McpServerConfig>;
    /** When false, don't persist session to filesystem */
    persistSession?: boolean;
    /** SDK permission mode override (per-thread from DB) */
    permissionMode?: PermissionMode;
    /** The Discord message ID that triggered this job (for queue indicator reactions) */
    sourceMessageId?: string;
    /** Channel+message where 👀 reaction was placed (for removal on completion) */
    eyesReaction?: { channelId: string; messageId: string };
    /** Called when the job completes (success or final failure) */
    onComplete?: (error?: Error) => void;
    /** Additional eyes reactions from batched messages (for cleanup on completion) */
    batchedEyesReactions?: { channelId: string; messageId: string }[];
    /** Additional onComplete callbacks from batched messages */
    batchedOnCompletes?: ((error?: Error) => void)[];
}

interface RunnerOptions {
    concurrency?: number;
    maxAttempts?: number;
    backoffBaseMs?: number;
}

const log = createLogger('runner');

/** Extract the XML text portion from a prompt */
function extractPromptText(prompt: string | MultimodalPrompt): string {
    if (typeof prompt === 'string') return prompt;
    if (prompt.type === 'text') return prompt.text;
    const textBlock = prompt.blocks.find(b => b.type === 'text');
    return textBlock?.type === 'text' ? textBlock.text : '';
}

/** Extract binary content blocks (images, PDFs) from a prompt */
function extractMediaBlocks(prompt: string | MultimodalPrompt): ContentBlock[] {
    if (typeof prompt === 'string') return [];
    if (prompt.type === 'text') return [];
    return prompt.blocks.filter(b => b.type !== 'text');
}

class JobRunner {
    private active = 0;
    private pending: ClaudeJob[] = [];
    private readonly concurrency: number;
    private readonly maxAttempts: number;
    private readonly backoffBaseMs: number;
    private drainResolve: (() => void) | null = null;
    private activeQueries = new Map<string, Query>();
    private cachedModels: ModelInfo[] = [];
    /** Tracks threads that have a job running or waiting in the global pending queue */
    private runningThreads = new Set<string>();
    /** Per-thread overflow queue: jobs waiting for the current thread job to finish */
    private threadQueues = new Map<string, ClaudeJob[]>();

    constructor(options: RunnerOptions = {}) {
        this.concurrency = options.concurrency ?? 10;
        this.maxAttempts = options.maxAttempts ?? 3;
        this.backoffBaseMs = options.backoffBaseMs ?? 1000;
        log(`JobRunner initialized: concurrency=${this.concurrency}, maxAttempts=${this.maxAttempts}, backoffBaseMs=${this.backoffBaseMs}`);
    }

    submit(job: ClaudeJob): void {
        log(`Job submitted by ${job.username} for thread=${job.threadId}, sessionId=${job.sessionId || '(none)'}, resume=${job.resume}, model=${job.model || '(default)'}`);
        // Per-thread serialization: only one job per thread at a time
        if (this.runningThreads.has(job.threadId)) {
            let queue = this.threadQueues.get(job.threadId);
            if (!queue) {
                queue = [];
                this.threadQueues.set(job.threadId, queue);
            }
            queue.push(job);
            log(`Thread ${job.threadId} busy, queued by ${job.username} (${queue.length} pending for thread)`);
            // Add loading reaction to indicate the message is queued
            if (job.sourceMessageId) {
                addReaction(job.threadId, job.sourceMessageId, '⏳').catch(() => {});
            }
            return;
        }

        this.runningThreads.add(job.threadId);

        if (this.active < this.concurrency) {
            this.active++;
            log(`Job started immediately for ${job.username}, active=${this.active}/${this.concurrency}, globalPending=${this.pending.length}`);
            this.run(job);
        } else {
            log(`Queue full (${this.active}/${this.concurrency}), job queued for ${job.username}, globalPending=${this.pending.length + 1}`);
            this.pending.push(job);
        }
    }

    private async run(job: ClaudeJob): Promise<void> {
        try {
            await this.executeWithRetry(job, 1);
        } finally {
            this.active--;
            log.debug(`Slot released for thread=${job.threadId}, active=${this.active}/${this.concurrency}`);

            // Promote all per-thread queued jobs as a single merged job
            const queue = this.threadQueues.get(job.threadId);
            if (queue && queue.length > 0) {
                const allJobs = queue.splice(0);
                this.threadQueues.delete(job.threadId);
                const merged = this.mergeThreadJobs(allJobs);
                // Keep runningThreads mark; prioritize by pushing to front
                this.pending.unshift(merged);
                log.debug(`Merged ${allJobs.length} queued jobs for thread=${job.threadId} into one`);
            } else {
                this.runningThreads.delete(job.threadId);
                log.debug(`Thread ${job.threadId} removed from runningThreads`);
            }

            // Fill concurrency slots from global queue
            const next = this.pending.shift();
            if (next) {
                this.active++;
                log(`Dequeued job for ${next.username} thread=${next.threadId}, active=${this.active}/${this.concurrency}, globalPending=${this.pending.length}`);
                this.run(next);
            } else if (this.active === 0 && this.drainResolve) {
                log(`All jobs drained, resolving drain promise`);
                this.drainResolve();
                this.drainResolve = null;
            }
        }
    }

    private async executeWithRetry(job: ClaudeJob, attempt: number): Promise<void> {
        // Remove queued indicator reaction now that execution is starting
        if (job.sourceMessageId) {
            removeReaction(job.threadId, job.sourceMessageId, '⏳').catch(() => {});
        }

        // Lazy session resolution: when resume is undefined, resolve from DB at execution time
        // This ensures queued per-thread jobs always get the latest session state
        if (job.resume === undefined) {
            log.debug(`Lazy session resolution for thread=${job.threadId}`);
            const mapping = getThreadMapping(job.threadId);
            if (mapping) {
                const session = resolveSessionState(job.threadId, mapping);
                job = { ...job, ...session };
                log.debug(`Resolved session from DB: sessionId=${job.sessionId || '(empty)'}, resume=${job.resume}`);
            } else {
                // Thread mapping gone (e.g. deleted) — treat as new session
                job = { ...job, sessionId: '', resume: false };
                log.warn(`Thread mapping not found for thread=${job.threadId}, treating as new session`);
            }
        }

        log(`Processing job for ${job.username} thread=${job.threadId} (attempt ${attempt}/${this.maxAttempts})`);
        log(`Session: ${job.sessionId || '(auto)'}, Resume: ${job.resume}, workingDir=${job.workingDir || '(default)'}, model=${job.model || '(default)'}`);

        const sender = createClaudeSender(job.threadId);
        // Resolve display mode: DB mapping > default
        const mapping = getThreadMapping(job.threadId);
        const displayMode: DisplayMode = mapping?.display_mode ?? 'pager';
        log.debug(`Display mode for thread=${job.threadId}: ${displayMode}`);
        const pager = displayMode === 'pager' ? createToolPager(job.threadId) : null;
        if (pager) log.debug(`Pager created for thread=${job.threadId}`);
        let lastResultText = '';

        let currentSessionId: string | undefined = job.sessionId || undefined;

        const canUseTool = createCanUseTool(job.threadId);
        let lastTypingTime = 0;
        let watchdogResetFn: (() => void) | undefined;

        // Wrap canUseTool to keep watchdog alive during user approval waits
        const canUseToolWithWatchdog: typeof canUseTool = async (...args) => {
            // Tick watchdog at start, then periodically while waiting
            watchdogResetFn?.();
            const keepAlive = setInterval(() => watchdogResetFn?.(), 30_000);
            try {
                return await canUseTool(...args);
            } finally {
                clearInterval(keepAlive);
                watchdogResetFn?.();
            }
        };

        try {
            const resultSessionId = await queryClaudeSDK({
                prompt: job.prompt,
                sessionId: job.sessionId,
                resume: job.resume ?? false,
                workingDir: job.workingDir,
                model: job.model,
                forkSession: job.forkSession,
                resumeSessionAt: job.resumeSessionAt,
                mcpServers: job.createMcpServers?.(() => currentSessionId),
                persistSession: job.persistSession,
                permissionMode: job.permissionMode,
                canUseTool: canUseToolWithWatchdog,
                onWatchdogReset: (resetFn) => { watchdogResetFn = resetFn; },
                onQuery: (q) => {
                    this.activeQueries.set(job.threadId, q);
                    log.debug(`Query object registered for thread=${job.threadId}`);
                    // Cache supported models from the first available query
                    if (this.cachedModels.length === 0) {
                        q.supportedModels().then(models => {
                            this.cachedModels = models;
                            log(`Cached ${models.length} supported models`);
                        }).catch(e => log.warn(`Failed to fetch supported models: ${e}`));
                    }
                },
                onMessage: async (sdkMessage) => {
                    try {
                        // Keep typing indicator alive while processing (throttled to once per 5s)
                        const now = Date.now();
                        if (now - lastTypingTime >= 5000) {
                            lastTypingTime = now;
                            sendTyping(job.threadId);
                        }

                    // Capture result text and send as separate message(s)
                    if (sdkMessage.type === 'result') {
                        const resultText = (sdkMessage as Record<string, unknown>).result as string | undefined;
                        if (resultText) {
                            lastResultText = resultText;
                            if (pager) await sendToThread(job.threadId, resultText);
                        }
                    }

                    // Detect new/changed session from SDK init message
                    // Skip ephemeral sessions (persistSession: false, e.g. cron jobs)
                    if (sdkMessage.type === 'system' && sdkMessage.subtype === 'init'
                        && job.persistSession !== false) {
                        const { session_id: initSessionId, model: initModel, cwd: initCwd } = sdkMessage;
                        log(`Init: sdk_session=${initSessionId}, job.sessionId=${job.sessionId || '(empty)'}`);
                        if (initSessionId && initSessionId !== job.sessionId) {
                            // Save SDK-generated session ID to DB
                            updateThreadSession(job.threadId, initSessionId);
                            currentSessionId = initSessionId;
                            log(`Session saved for thread ${job.threadId}: ${initSessionId}`);
                            const label = job.forkSession ? 'Forked session' : 'New session';
                            await sender([{
                                type: 'system',
                                content: '',
                                subtype: 'new_session',
                                metadata: {
                                    label,
                                    model: initModel,
                                    cwd: initCwd,
                                },
                            }]);
                        }
                    }

                    if (displayMode === 'verbose') {
                        // Verbose: stream all messages as they arrive
                        const messages = convertToClaudeMessages(sdkMessage);
                        if (messages.length > 0) {
                            await sender(messages);
                        }
                    } else if (displayMode === 'simple') {
                        // Simple: only send final result text and system messages (completion stats)
                        // Hide tool_use, tool_result, tool_progress, tool_summary, thinking
                        if (sdkMessage.type === 'result') {
                            if (sdkMessage.subtype === 'success' && sdkMessage.result) {
                                await sender([{ type: 'text', content: sdkMessage.result }]);
                            }
                            const messages = convertToClaudeMessages(sdkMessage);
                            const systemMessages = messages.filter(m => m.type === 'system');
                            if (systemMessages.length > 0) {
                                await sender(systemMessages);
                            }
                        }
                    } else if (displayMode === 'pager') {
                        // Skip subagent-internal messages — they have parent_tool_use_id set.
                        // Task lifecycle events (task_started etc.) don't have this field and are kept.
                        const parentId = (sdkMessage as Record<string, unknown>).parent_tool_use_id;
                        log.debug(`Pager routing: sdk.type=${sdkMessage.type} sdk.subtype=${(sdkMessage as Record<string,unknown>).subtype} parent_tool_use_id=${parentId ?? 'null'}`);
                        if (!parentId) {
                            // Track raw user/assistant messages for offset calculation in phase 2
                            pager!.trackRawMessage(sdkMessage);
                            const messages = convertToClaudeMessages(sdkMessage);
                            for (const msg of messages) {
                                if (PAGER_BYPASS_TYPES.has(msg.type)) {
                                    await sender([msg]);
                                } else {
                                    pager!.handleMessage(msg);
                                }
                            }
                        } else {
                            log.debug(`Skipped subagent message: type=${sdkMessage.type} parent_tool_use_id=${parentId}`);
                        }
                    }
                    } catch (err) {
                        log.error(`onMessage error (non-fatal) for thread=${job.threadId}: ${err}`);
                    }
                },
            });

            this.activeQueries.delete(job.threadId);
            cleanupThread(job.threadId);
            log.debug(`Cleaned up query and thread state for thread=${job.threadId}`);
            // Remove eyes reaction now that processing is done
            if (job.eyesReaction) {
                removeReaction(job.eyesReaction.channelId, job.eyesReaction.messageId, '👀').catch(() => {});
            }
            for (const r of job.batchedEyesReactions || []) {
                removeReaction(r.channelId, r.messageId, '👀').catch(() => {});
            }
            // Finalize pager: remove buttons, save metadata to DB
            await pager?.destroy(resultSessionId, job.workingDir || process.cwd());

            // If session ID changed (e.g. fork), update DB mapping
            // Skip when no sessionId was provided (e.g. cron jobs with persistSession: false)
            if (job.sessionId && resultSessionId !== job.sessionId) {
                updateThreadSession(job.threadId, resultSessionId);
                log(`Session ID updated for thread ${job.threadId}: ${resultSessionId}`);
            }

            // Update channel status message with the final reply
            if (job.statusMessageId && job.parentChannelId && lastResultText) {
                const statusText = truncateCodePoints(lastResultText, 1900);
                log.debug(`Updating status message: channel=${job.parentChannelId} message=${job.statusMessageId} thread=${job.threadId} textLen=${statusText.length}`);
                await editMessage(job.parentChannelId, job.statusMessageId, statusText).catch(err => {
                    log.warn(`Failed to update status message: channel=${job.parentChannelId} message=${job.statusMessageId} thread=${job.threadId}: ${err}`);
                });
            }

            // Check for ExitPlanMode "new session" approval
            const planApproval = pendingPlanApprovals.get(job.threadId);
            if (planApproval) {
                pendingPlanApprovals.delete(job.threadId);
                updateThreadSession(job.threadId, null);
                updateThreadPermissionMode(job.threadId, planApproval.mode);
                log(`Plan approval: auto-submitting new session for thread=${job.threadId}, mode=${planApproval.mode}`);

                const planPrompt = `Implement the following plan:\n\n${planApproval.plan}`;
                this.submit({
                    prompt: planPrompt,
                    threadId: job.threadId,
                    userId: job.userId,
                    username: job.username,
                    workingDir: job.workingDir,
                    model: job.model,
                    permissionMode: planApproval.mode,
                    createMcpServers: job.createMcpServers,
                });
            }

            // Generate title on first completion or after discord_set_title tool clears it
            if (!getThreadTitle(job.threadId) && lastResultText) {
                log.debug(`Triggering title generation for thread=${job.threadId}`);
                this.generateAndSetTitle(job.threadId, resultSessionId, job.workingDir);
            }

            log(`Job completed for ${job.username} thread=${job.threadId}, resultSessionId=${resultSessionId}`);
            job.onComplete?.();
            for (const cb of job.batchedOnCompletes || []) cb();
        } catch (error) {
            this.activeQueries.delete(job.threadId);
            cleanupThread(job.threadId);
            pendingPlanApprovals.delete(job.threadId);
            // Remove eyes reaction on error too
            if (job.eyesReaction) {
                removeReaction(job.eyesReaction.channelId, job.eyesReaction.messageId, '👀').catch(() => {});
            }
            for (const r of job.batchedEyesReactions || []) {
                removeReaction(r.channelId, r.messageId, '👀').catch(() => {});
            }
            await pager?.destroy(job.sessionId || '', job.workingDir || process.cwd());

            // Update status message to error state
            if (job.statusMessageId && job.parentChannelId) {
                await editMessage(job.parentChannelId, job.statusMessageId, `❌ Error`).catch((err) => {
                    log.warn(`Failed to update status message to error state for thread=${job.threadId}: ${err}`);
                });
            }

            const errMsg = error instanceof Error ? error.message : String(error);
            const errStack = error instanceof Error ? error.stack : '';
            log.error(`Job failed for ${job.username} thread=${job.threadId} (attempt ${attempt}/${this.maxAttempts}): ${errMsg}`);
            if (errStack) log.error(`Stack trace for thread=${job.threadId}: ${errStack}`);

            // StallError: special recovery path
            if (error instanceof StallError) {
                if (job.persistSession === false) {
                    // Ephemeral (e.g. cron) — delegate error handling to caller
                    log.warn(`StallError on ephemeral session for thread=${job.threadId}, delegating to caller`);
                    job.onComplete?.(error);
                    for (const cb of job.batchedOnCompletes || []) cb(error);
                    return;
                }
                // Persistent session — auto-resume
                log.warn(`StallError on persistent session for thread=${job.threadId}, auto-resuming`);
                await sendToThread(job.threadId, `\u26A0\uFE0F Query stalled. Resuming...`).catch(() => {});
                this.submit({
                    prompt: 'continue',
                    threadId: job.threadId,
                    sessionId: job.sessionId,
                    resume: true,
                    userId: job.userId,
                    username: job.username,
                    workingDir: job.workingDir,
                    model: job.model,
                    permissionMode: job.permissionMode,
                    createMcpServers: job.createMcpServers,
                    persistSession: job.persistSession,
                    onComplete: job.onComplete,
                    batchedOnCompletes: job.batchedOnCompletes,
                });
                return;
            }

            if (attempt < this.maxAttempts) {
                const delay = this.backoffBaseMs * Math.pow(2, attempt - 1);
                log(`Retrying job for ${job.username} thread=${job.threadId} in ${delay}ms (next attempt ${attempt + 1}/${this.maxAttempts})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.executeWithRetry(job, attempt + 1);
            }

            log.error(`Job exhausted all ${this.maxAttempts} attempts for ${job.username} thread=${job.threadId}, giving up`);
            const finalError = error instanceof Error ? error : new Error(String(error));
            job.onComplete?.(finalError);
            for (const cb of job.batchedOnCompletes || []) cb(finalError);
            await sendToThread(
                job.threadId,
                `Something went wrong. Try again?\n\`\`\`${error}\`\`\``
            ).catch((sendErr) => {
                log.error(`Failed to send error message to thread=${job.threadId}: ${sendErr}`);
            });
        }
    }

    getModels(): ModelInfo[] {
        return this.cachedModels;
    }

    isRunning(threadId: string): boolean {
        return this.runningThreads.has(threadId);
    }

    async interrupt(threadId: string): Promise<boolean> {
        const q = this.activeQueries.get(threadId);
        if (!q) {
            log.warn(`Interrupt requested but no active query for thread=${threadId}`);
            return false;
        }
        log(`Interrupting query for thread=${threadId}`);
        try {
            await q.interrupt();
            log(`Interrupt completed for thread=${threadId}`);
        } catch (err) {
            log.error(`Interrupt failed for thread=${threadId}: ${err}`);
            throw err;
        }
        return true;
    }

    /** Generate a title via AI and update both DB and Discord thread name. */
    private async generateAndSetTitle(threadId: string, sessionId: string, workingDir?: string): Promise<void> {
        try {
            log.debug(`Generating title for thread=${threadId} session=${sessionId}`);
            const title = await generateTitle(sessionId, workingDir);
            if (!title) {
                log.warn(`Empty title generated for thread=${threadId}`);
                return;
            }
            setThreadTitle(threadId, title);
            await renameThread(threadId, truncateCodePoints(title, 100));
            log(`Title set for thread ${threadId}: ${title}`);
        } catch (err) {
            log.error(`Failed to generate title for thread=${threadId}: ${err}`);
        }
    }

    /**
     * Merge multiple per-thread queued jobs into a single job.
     * Concatenates XML message elements and combines media blocks.
     */
    private mergeThreadJobs(jobs: ClaudeJob[]): ClaudeJob {
        if (jobs.length === 1) return jobs[0]!;

        const base = jobs[0]!;
        const rest = jobs.slice(1);

        // Merge prompts: concatenate XML text, combine media blocks
        const allMediaBlocks: ContentBlock[] = [];
        let textSummary = '';

        for (const job of jobs) {
            allMediaBlocks.push(...extractMediaBlocks(job.prompt));
            if (!textSummary && typeof job.prompt !== 'string' && job.prompt.type === 'multimodal') {
                textSummary = job.prompt.textSummary;
            }
        }

        const mergedText = jobs.map(j => extractPromptText(j.prompt)).filter(Boolean).join('\n\n');

        let prompt: string | MultimodalPrompt;
        if (allMediaBlocks.length > 0) {
            prompt = {
                type: 'multimodal',
                blocks: [{ type: 'text', text: mergedText }, ...allMediaBlocks],
                textSummary: textSummary || mergedText.slice(0, 200),
            };
        } else {
            prompt = mergedText;
        }

        // Remove ⏳ from absorbed jobs (base's ⏳ is removed in executeWithRetry)
        for (const job of rest) {
            if (job.sourceMessageId) {
                removeReaction(job.threadId, job.sourceMessageId, '⏳').catch(() => {});
            }
        }

        // Collect eyes reactions and onComplete callbacks from absorbed jobs
        const batchedEyesReactions = [
            ...(base.batchedEyesReactions || []),
            ...rest.filter(j => j.eyesReaction).map(j => j.eyesReaction!),
        ];
        const batchedOnCompletes = [
            ...(base.batchedOnCompletes || []),
            ...rest.filter(j => j.onComplete).map(j => j.onComplete!),
        ];

        return {
            ...base,
            prompt,
            batchedEyesReactions: batchedEyesReactions.length > 0 ? batchedEyesReactions : undefined,
            batchedOnCompletes: batchedOnCompletes.length > 0 ? batchedOnCompletes : undefined,
        };
    }

    /**
     * Wait for all active and pending jobs to complete.
     */
    drain(): Promise<void> {
        if (this.active === 0 && this.pending.length === 0) {
            log.debug(`Drain called with no active/pending jobs, resolving immediately`);
            return Promise.resolve();
        }
        log(`Drain requested: waiting for active=${this.active}, globalPending=${this.pending.length}, threadQueues=${this.threadQueues.size}`);
        return new Promise(resolve => {
            this.drainResolve = resolve;
        });
    }
}

export const runner = new JobRunner();
