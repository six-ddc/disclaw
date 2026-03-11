/**
 * Runner - In-process job runner with concurrency control
 *
 * Uses an async semaphore pattern for concurrency control.
 * JS single-threaded execution guarantees submit() atomicity.
 */

import { queryClaudeSDK, generateTitle } from './claude-client.js';
import { createClaudeSender } from './discord-sender.js';
import { convertToClaudeMessages } from './message-converter.js';
import { sendToThread, editMessage, renameThread, truncateCodePoints, addReaction, removeReaction } from './discord.js';
import { type Query, type ModelInfo, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { getThreadMapping, resolveSessionState, updateThreadSession, getThreadTitle, setThreadTitle } from './db.js';
import { createCanUseTool, cleanupThread } from './user-input.js';
import type { MultimodalPrompt } from './attachment-handler.js';
import { createToolPager } from './tool-pager.js';
import { createLogger } from './logger.js';

export type DisplayMode = 'verbose' | 'simple' | 'pager';

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
    createMcpServers?: () => Record<string, McpServerConfig>;
    /** When false, only show the final result message (hide tool_use, tool_result, thinking etc.) */
    verbose?: boolean;
    /** When false, don't persist session to filesystem */
    persistSession?: boolean;
    /** SDK permission mode override (per-thread from DB) */
    permissionMode?: string;
    /** The Discord message ID that triggered this job (for queue indicator reactions) */
    sourceMessageId?: string;
    /** Channel+message where 👀 reaction was placed (for removal on completion) */
    eyesReaction?: { channelId: string; messageId: string };
    /** Called when the job completes (success or final failure) */
    onComplete?: (error?: Error) => void;
}

interface RunnerOptions {
    concurrency?: number;
    maxAttempts?: number;
    backoffBaseMs?: number;
}

const log = createLogger('runner');

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
        this.concurrency = options.concurrency ?? 2;
        this.maxAttempts = options.maxAttempts ?? 3;
        this.backoffBaseMs = options.backoffBaseMs ?? 1000;
    }

    submit(job: ClaudeJob): void {
        // Per-thread serialization: only one job per thread at a time
        if (this.runningThreads.has(job.threadId)) {
            let queue = this.threadQueues.get(job.threadId);
            if (!queue) {
                queue = [];
                this.threadQueues.set(job.threadId, queue);
            }
            queue.push(job);
            log(`Thread ${job.threadId} busy, queued (${queue.length} pending for thread)`);
            // Add loading reaction to indicate the message is queued
            if (job.sourceMessageId) {
                addReaction(job.threadId, job.sourceMessageId, '⏳').catch(() => {});
            }
            return;
        }

        this.runningThreads.add(job.threadId);

        if (this.active < this.concurrency) {
            this.active++;
            this.run(job);
        } else {
            log(`Queue full (${this.active}/${this.concurrency}), job queued for ${job.username}`);
            this.pending.push(job);
        }
    }

    private async run(job: ClaudeJob): Promise<void> {
        try {
            await this.executeWithRetry(job, 1);
        } finally {
            this.active--;

            // Promote next per-thread job to global pending queue
            const queue = this.threadQueues.get(job.threadId);
            if (queue && queue.length > 0) {
                const next = queue.shift()!;
                if (queue.length === 0) this.threadQueues.delete(job.threadId);
                // Keep runningThreads mark; prioritize by pushing to front
                this.pending.unshift(next);
            } else {
                this.runningThreads.delete(job.threadId);
            }

            // Fill concurrency slots from global queue
            const next = this.pending.shift();
            if (next) {
                this.active++;
                this.run(next);
            } else if (this.active === 0 && this.drainResolve) {
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
            const mapping = getThreadMapping(job.threadId);
            if (mapping) {
                const session = resolveSessionState(job.threadId, mapping);
                job = { ...job, ...session };
            } else {
                // Thread mapping gone (e.g. deleted) — treat as new session
                job = { ...job, sessionId: '', resume: false };
            }
        }

        log(`Processing job for ${job.username} (attempt ${attempt})`);
        log(`Session: ${job.sessionId || '(auto)'}, Resume: ${job.resume}`);

        const sender = createClaudeSender(job.threadId);
        // Resolve display mode: job-level > DB mapping > cron verbose compat > default
        const mapping = getThreadMapping(job.threadId);
        const displayMode: DisplayMode = job.verbose === false ? 'simple'
            : (mapping?.display_mode as DisplayMode) || 'verbose';
        const pager = displayMode === 'pager' ? createToolPager(job.threadId) : null;
        let lastResultText = '';

        const canUseTool = createCanUseTool(job.threadId);

        try {
            const resultSessionId = await queryClaudeSDK({
                prompt: job.prompt,
                sessionId: job.sessionId,
                resume: job.resume ?? false,
                workingDir: job.workingDir,
                model: job.model,
                forkSession: job.forkSession,
                resumeSessionAt: job.resumeSessionAt,
                mcpServers: job.createMcpServers?.(),
                persistSession: job.persistSession,
                permissionMode: job.permissionMode,
                canUseTool,
                onQuery: (q) => {
                    this.activeQueries.set(job.threadId, q);
                    // Cache supported models from the first available query
                    if (this.cachedModels.length === 0) {
                        q.supportedModels().then(models => {
                            this.cachedModels = models;
                            log(`Cached ${models.length} supported models`);
                        }).catch(e => log(`Failed to fetch supported models: ${e}`));
                    }
                },
                onMessage: async (sdkMessage) => {
                    try {
                        // Capture the final result text for status message update
                    if (sdkMessage.type === 'result' && sdkMessage.subtype === 'success') {
                        lastResultText = sdkMessage.result;
                    }

                    // Detect new/changed session from SDK init message
                    // Skip ephemeral sessions (persistSession: false, e.g. cron jobs)
                    if (sdkMessage.type === 'system' && (sdkMessage as Record<string, unknown>).subtype === 'init'
                        && job.persistSession !== false) {
                        const initMsg = sdkMessage as Record<string, unknown>;
                        const initSessionId = initMsg.session_id as string;
                        log(`Init: sdk_session=${initSessionId}, job.sessionId=${job.sessionId || '(empty)'}`);
                        if (initSessionId && initSessionId !== job.sessionId) {
                            // Save SDK-generated session ID to DB
                            updateThreadSession(job.threadId, initSessionId);
                            log(`Session saved for thread ${job.threadId}: ${initSessionId}`);
                            const label = job.forkSession ? 'Forked session' : 'New session';
                            await sender([{
                                type: 'system',
                                content: '',
                                metadata: {
                                    subtype: 'new_session',
                                    label,
                                    model: initMsg.model,
                                    cwd: initMsg.cwd,
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
                        // Track raw user/assistant messages for offset calculation in phase 2
                        pager!.trackRawMessage(sdkMessage);
                        const messages = convertToClaudeMessages(sdkMessage);
                        for (const msg of messages) {
                            if (msg.type === 'system') {
                                await sender([msg]);
                            } else {
                                pager!.handleMessage(msg);
                            }
                        }
                    }
                    } catch (err) {
                        log(`onMessage error (non-fatal): ${err}`);
                    }
                },
            });

            this.activeQueries.delete(job.threadId);
            cleanupThread(job.threadId);
            // Remove eyes reaction now that processing is done
            if (job.eyesReaction) {
                removeReaction(job.eyesReaction.channelId, job.eyesReaction.messageId, '👀').catch(() => {});
            }
            // Finalize pager: switch to persistent SDK-backed buttons (async, non-blocking)
            pager?.destroy(resultSessionId, job.workingDir || process.cwd());

            // If session ID changed (e.g. fork), update DB mapping
            // Skip when no sessionId was provided (e.g. cron jobs with persistSession: false)
            if (job.sessionId && resultSessionId !== job.sessionId) {
                updateThreadSession(job.threadId, resultSessionId);
                log(`Session ID updated for thread ${job.threadId}: ${resultSessionId}`);
            }

            // Update channel status message with the final reply
            if (job.statusMessageId && job.parentChannelId && lastResultText) {
                const statusText = truncateCodePoints(lastResultText, 2000);
                await editMessage(job.parentChannelId, job.statusMessageId, statusText).catch(err => {
                    log(`Failed to update status message: ${err}`);
                });
            }

            // Generate title on first completion (async, non-blocking)
            if (!getThreadTitle(job.threadId) && lastResultText) {
                const promptText = typeof job.prompt === 'string'
                    ? job.prompt
                    : job.prompt.type === 'text' ? job.prompt.text : job.prompt.textSummary;
                this.generateAndSetTitle(job.threadId, promptText, lastResultText);
            }

            log(`Job completed for ${job.username}`);
            job.onComplete?.();
        } catch (error) {
            this.activeQueries.delete(job.threadId);
            cleanupThread(job.threadId);
            // Remove eyes reaction on error too
            if (job.eyesReaction) {
                removeReaction(job.eyesReaction.channelId, job.eyesReaction.messageId, '👀').catch(() => {});
            }
            pager?.destroy(job.sessionId || '', job.workingDir || process.cwd());

            // Update status message to error state
            if (job.statusMessageId && job.parentChannelId) {
                await editMessage(job.parentChannelId, job.statusMessageId, `❌ Error`).catch(() => {});
            }

            const errMsg = error instanceof Error ? error.message : String(error);
            const errStack = error instanceof Error ? error.stack : '';
            log(`Job failed for ${job.username} (attempt ${attempt}): ${errMsg}`);
            if (errStack) log(`Stack: ${errStack}`);

            if (attempt < this.maxAttempts) {
                const delay = this.backoffBaseMs * Math.pow(2, attempt - 1);
                log(`Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.executeWithRetry(job, attempt + 1);
            }

            job.onComplete?.(error instanceof Error ? error : new Error(String(error)));
            await sendToThread(
                job.threadId,
                `Something went wrong. Try again?\n\`\`\`${error}\`\`\``
            );
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
            log(`Interrupt: no active query for thread ${threadId}`);
            return false;
        }
        log(`Interrupting query for thread ${threadId}`);
        await q.interrupt();
        return true;
    }

    /** Generate a title via AI and update both DB and Discord thread name. */
    private async generateAndSetTitle(threadId: string, prompt: string, reply: string): Promise<void> {
        try {
            log(`Generating title for thread ${threadId}`);
            const title = await generateTitle([
                { role: 'user', text: prompt },
                { role: 'assistant', text: reply },
            ]);
            if (!title) {
                log(`Empty title generated for thread ${threadId}`);
                return;
            }
            setThreadTitle(threadId, title);
            await renameThread(threadId, truncateCodePoints(title, 100));
            log(`Title set for thread ${threadId}: ${title}`);
        } catch (err) {
            log(`Failed to generate title: ${err}`);
        }
    }

    /**
     * Wait for all active and pending jobs to complete.
     */
    drain(): Promise<void> {
        if (this.active === 0 && this.pending.length === 0) {
            return Promise.resolve();
        }
        return new Promise(resolve => {
            this.drainResolve = resolve;
        });
    }
}

export const runner = new JobRunner();
