/**
 * Database - SQLite for thread → session mappings
 *
 * Simple key-value store:
 * - thread_id (Discord thread ID)
 * - session_id (Claude session UUID)
 *
 * When a follow-up message comes in a thread, we look up
 * the session ID to use --resume.
 */

import { Database } from 'bun:sqlite';
import { createLogger } from './logger.js';

const log = createLogger('db');
const DB_PATH = process.env.DB_PATH || './data/threads.db';

// Ensure data directory exists
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
try {
    mkdirSync(dirname(DB_PATH), { recursive: true });
} catch (err) {
    log.warn(`Failed to create data directory for ${DB_PATH}: ${err}`);
}

// Open database
export const db = new Database(DB_PATH);

// Create tables if they don't exist
db.run(`
    CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Create channels config table
db.run(`
    CREATE TABLE IF NOT EXISTS channels (
        channel_id TEXT PRIMARY KEY,
        working_dir TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Add working_dir column to threads table (migration)
try {
    db.run(`ALTER TABLE threads ADD COLUMN working_dir TEXT`);
} catch {} // Column may already exist

// Add model column to threads table (migration)
try {
    db.run(`ALTER TABLE threads ADD COLUMN model TEXT`);
} catch {} // Column may already exist

// Add fork_from column to threads table (migration)
// When set, the next message should fork from this session ID, then clear it
try {
    db.run(`ALTER TABLE threads ADD COLUMN fork_from TEXT`);
} catch {} // Column may already exist

// Add title column to threads table (migration)
try {
    db.run(`ALTER TABLE threads ADD COLUMN title TEXT`);
} catch {} // Column may already exist

// Add permission_mode column to threads table (migration)
try {
    db.run(`ALTER TABLE threads ADD COLUMN permission_mode TEXT`);
} catch {} // Column may already exist

// Add display_mode column to threads table (migration)
try {
    db.run(`ALTER TABLE threads ADD COLUMN display_mode TEXT`);
} catch {} // Column may already exist

// Create index for faster lookups
db.run(`
    CREATE INDEX IF NOT EXISTS idx_threads_session
    ON threads(session_id)
`);

// Create cron_jobs table
db.run(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
        job_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        schedule TEXT NOT NULL,
        prompt TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Add name column to cron_jobs table (migration)
try {
    db.run(`ALTER TABLE cron_jobs ADD COLUMN name TEXT`);
} catch {} // Column may already exist

// Add last_run_at column to cron_jobs table (migration)
try {
    db.run(`ALTER TABLE cron_jobs ADD COLUMN last_run_at TEXT`);
} catch {} // Column may already exist

// Create pager_messages table — stores pager embed metadata for reaction-triggered restore
db.run(`
    CREATE TABLE IF NOT EXISTS pager_messages (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        msg_offset INTEGER NOT NULL,
        msg_limit INTEGER NOT NULL,
        working_dir TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_pager_thread ON pager_messages(thread_id)`);

log(`Database initialized at ${DB_PATH}`);

// In-memory cache for channel configs (TTL: 5 minutes)
const CACHE_TTL_MS = 5 * 60 * 1000;
const channelConfigCache = new Map<string, { data: { working_dir: string | null } | null; expiresAt: number }>();

// Helper functions for channel config
function getChannelConfig(channelId: string): { working_dir: string | null } | null {
    return db.query('SELECT working_dir FROM channels WHERE channel_id = ?')
        .get(channelId) as { working_dir: string | null } | null;
}

export function getChannelConfigCached(channelId: string): { working_dir: string | null } | null {
    const cached = channelConfigCache.get(channelId);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
        log.debug(`Channel config cache hit: channel=${channelId}`);
        return cached.data;
    }

    // Cache miss or expired - fetch from DB
    const data = getChannelConfig(channelId);
    channelConfigCache.set(channelId, { data, expiresAt: now + CACHE_TTL_MS });
    log.debug(`Channel config cache miss: channel=${channelId}, workingDir=${data?.working_dir || '(none)'}`);
    return data;
}

// Thread mapping helpers
export interface ThreadMapping {
    session_id: string;
    working_dir: string | null;
    model: string | null;
    fork_from: string | null;
    permission_mode: string | null;
    display_mode: string | null;
}

export function getThreadMapping(threadId: string): ThreadMapping | null {
    const mapping = db.query('SELECT session_id, working_dir, model, fork_from, permission_mode, display_mode FROM threads WHERE thread_id = ?')
        .get(threadId) as ThreadMapping | null;
    log.debug(`getThreadMapping: thread=${threadId}, found=${!!mapping}${mapping ? `, session=${mapping.session_id || '(empty)'}` : ''}`);
    return mapping;
}

export function updateThreadSession(threadId: string, sessionId: string | null): void {
    db.run('UPDATE threads SET session_id = ? WHERE thread_id = ?', [sessionId ?? '', threadId]);
    log(`Thread session updated: thread=${threadId}, session=${sessionId || '(cleared)'}`);
}

export function updateThreadModel(threadId: string, model: string): void {
    db.run('UPDATE threads SET model = ? WHERE thread_id = ?', [model, threadId]);
    log.debug(`Thread model updated: thread=${threadId}, model=${model}`);
}

export function updateThreadPermissionMode(threadId: string, mode: string | null): void {
    db.run('UPDATE threads SET permission_mode = ? WHERE thread_id = ?', [mode, threadId]);
    log.debug(`Thread permission mode updated: thread=${threadId}, mode=${mode || '(default)'}`);
}

export function updateThreadDisplayMode(threadId: string, mode: string | null): void {
    db.run('UPDATE threads SET display_mode = ? WHERE thread_id = ?', [mode, threadId]);
    log.debug(`Thread display mode updated: thread=${threadId}, mode=${mode || '(default)'}`);
}

export function updateThreadWorkingDir(threadId: string, workingDir: string): void {
    const absDir = resolve(workingDir);
    db.run('UPDATE threads SET working_dir = ? WHERE thread_id = ?', [absDir, threadId]);
    log(`Thread working dir updated: thread=${threadId}, dir=${absDir}`);
}

function clearForkFrom(threadId: string): void {
    db.run('UPDATE threads SET fork_from = NULL WHERE thread_id = ?', [threadId]);
}

export function getThreadTitle(threadId: string): string | null {
    const row = db.query('SELECT title FROM threads WHERE thread_id = ?')
        .get(threadId) as { title: string | null } | null;
    return row?.title || null;
}

export function setThreadTitle(threadId: string, title: string): void {
    db.run('UPDATE threads SET title = ? WHERE thread_id = ?', [title, threadId]);
    log.debug(`Thread title set: thread=${threadId}, title=${title}`);
}

/**
 * Resolve the session state for a thread and return job parameters.
 *
 * Three states:
 * 1. fork_from set → fork: resume original session with forkSession flag, clear fork_from
 * 2. session_id empty → new: generate UUID, persist it, start fresh session
 * 3. session_id present → resume: continue existing session
 *
 * All DB writes happen here so callers don't need to worry about state transitions.
 */
export function resolveSessionState(threadId: string, mapping: ThreadMapping): {
    sessionId: string;
    resume: boolean;
    forkSession?: true;
} {
    // Fork: resume from original session, then detach
    if (mapping.fork_from) {
        const sessionId = mapping.fork_from;
        db.run('UPDATE threads SET fork_from = NULL WHERE thread_id = ?', [threadId]);
        log(`Session state: fork (thread=${threadId}, from=${sessionId})`);
        return { sessionId, resume: true, forkSession: true };
    }

    // Cleared / new: let SDK auto-generate session ID (saved on init message)
    if (!mapping.session_id) {
        log(`Session state: new (thread=${threadId})`);
        return { sessionId: '', resume: false };
    }

    // Normal resume
    log(`Session state: resume (thread=${threadId}, session=${mapping.session_id})`);
    return { sessionId: mapping.session_id, resume: true };
}

export function setChannelConfig(channelId: string, workingDir: string): void {
    const absDir = resolve(workingDir);
    db.run(`
        INSERT INTO channels (channel_id, working_dir) VALUES (?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET working_dir = ?, updated_at = CURRENT_TIMESTAMP
    `, [channelId, absDir, absDir]);

    // Invalidate cache
    channelConfigCache.delete(channelId);
    log(`Channel config updated: channel=${channelId}, workingDir=${absDir}`);
}

// =========================================================================
// CRON JOBS
// =========================================================================

export interface CronJob {
    job_id: string;
    thread_id: string;
    creator_id: string;
    schedule: string;
    prompt: string;
    enabled: number;
    name: string | null;
    last_run_at: string | null;
}

/** Display name for a cron job: explicit name or truncated prompt fallback */
export function cronJobDisplayName(job: CronJob, maxLen = 50): string {
    if (job.name) return job.name;
    // Fallback: first line of prompt, truncated
    const firstLine = job.prompt.split('\n')[0] || job.prompt;
    return firstLine.length > maxLen ? firstLine.slice(0, maxLen - 1) + '…' : firstLine;
}

export function createCronJob(jobId: string, threadId: string, creatorId: string, schedule: string, prompt: string, name?: string): void {
    db.run(
        'INSERT INTO cron_jobs (job_id, thread_id, creator_id, schedule, prompt, name) VALUES (?, ?, ?, ?, ?, ?)',
        [jobId, threadId, creatorId, schedule, prompt, name || null]
    );
    log(`Cron job created: jobId=${jobId}, thread=${threadId}, schedule=${schedule}, name=${name || '(unnamed)'}`);
}

export function updateCronJob(jobId: string, fields: { name?: string; schedule?: string; prompt?: string }): void {
    const sets: string[] = [];
    const values: (string)[] = [];
    if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
    if (fields.schedule !== undefined) { sets.push('schedule = ?'); values.push(fields.schedule); }
    if (fields.prompt !== undefined) { sets.push('prompt = ?'); values.push(fields.prompt); }
    if (sets.length === 0) return;
    values.push(jobId);
    db.run(`UPDATE cron_jobs SET ${sets.join(', ')} WHERE job_id = ?`, values);
    log.debug(`Cron job updated: jobId=${jobId}, fields=${Object.keys(fields).join(',')}`);
}

export function getCronJob(jobId: string): CronJob | null {
    return db.query('SELECT job_id, thread_id, creator_id, schedule, prompt, enabled, name, last_run_at FROM cron_jobs WHERE job_id = ?')
        .get(jobId) as CronJob | null;
}

export function getCronJobByThread(threadId: string): CronJob | null {
    return db.query('SELECT job_id, thread_id, creator_id, schedule, prompt, enabled, name, last_run_at FROM cron_jobs WHERE thread_id = ?')
        .get(threadId) as CronJob | null;
}

export function listCronJobs(): CronJob[] {
    return db.query('SELECT job_id, thread_id, creator_id, schedule, prompt, enabled, name, last_run_at FROM cron_jobs ORDER BY created_at DESC')
        .all() as CronJob[];
}

export function setCronJobEnabled(jobId: string, enabled: boolean): void {
    db.run('UPDATE cron_jobs SET enabled = ? WHERE job_id = ?', [enabled ? 1 : 0, jobId]);
    log(`Cron job ${enabled ? 'enabled' : 'disabled'}: jobId=${jobId}`);
}

export function setCronJobLastRun(jobId: string): void {
    const timestamp = new Date().toISOString();
    db.run('UPDATE cron_jobs SET last_run_at = ? WHERE job_id = ?', [timestamp, jobId]);
    log.debug(`Cron job last run updated: jobId=${jobId}, at=${timestamp}`);
}

export function deleteCronJob(jobId: string): void {
    db.run('DELETE FROM cron_jobs WHERE job_id = ?', [jobId]);
    log(`Cron job deleted: jobId=${jobId}`);
}

// =========================================================================
// PAGER MESSAGES
// =========================================================================

export interface PagerMessage {
    message_id: string;
    thread_id: string;
    session_id: string;
    msg_offset: number;
    msg_limit: number;
    working_dir: string | null;
}

export function savePagerMessage(messageId: string, threadId: string, sessionId: string, msgOffset: number, msgLimit: number, workingDir?: string): void {
    db.run(
        'INSERT OR REPLACE INTO pager_messages (message_id, thread_id, session_id, msg_offset, msg_limit, working_dir) VALUES (?, ?, ?, ?, ?, ?)',
        [messageId, threadId, sessionId, msgOffset, msgLimit, workingDir || null]
    );
    // Keep only last 10 per thread — delete oldest beyond limit
    db.run(
        `DELETE FROM pager_messages WHERE message_id IN (
            SELECT message_id FROM pager_messages WHERE thread_id = ?
            ORDER BY created_at DESC LIMIT -1 OFFSET 10
        )`,
        [threadId]
    );
    log.debug(`Pager message saved: messageId=${messageId}, thread=${threadId}, session=${sessionId}, offset=${msgOffset}, limit=${msgLimit}`);
}

export function getPagerMessage(messageId: string): PagerMessage | null {
    return db.query('SELECT message_id, thread_id, session_id, msg_offset, msg_limit, working_dir FROM pager_messages WHERE message_id = ?')
        .get(messageId) as PagerMessage | null;
}
