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

const log = (msg: string) => process.stdout.write(`[db] ${msg}\n`);
const DB_PATH = process.env.DB_PATH || './data/threads.db';

// Ensure data directory exists
import { mkdirSync } from 'fs';
import { dirname } from 'path';
try {
    mkdirSync(dirname(DB_PATH), { recursive: true });
} catch {}

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

// Add verbose column to cron_jobs table (migration, default 0 = off)
try {
    db.run(`ALTER TABLE cron_jobs ADD COLUMN verbose INTEGER DEFAULT 0`);
} catch {} // Column may already exist

console.log(`[db] SQLite database ready at ${DB_PATH}`);

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
        return cached.data;
    }

    // Cache miss or expired - fetch from DB
    const data = getChannelConfig(channelId);
    channelConfigCache.set(channelId, { data, expiresAt: now + CACHE_TTL_MS });
    return data;
}

// Thread mapping helpers
export interface ThreadMapping {
    session_id: string;
    working_dir: string | null;
    model: string | null;
    fork_from: string | null;
}

export function getThreadMapping(threadId: string): ThreadMapping | null {
    return db.query('SELECT session_id, working_dir, model, fork_from FROM threads WHERE thread_id = ?')
        .get(threadId) as ThreadMapping | null;
}

export function updateThreadSession(threadId: string, sessionId: string | null): void {
    db.run('UPDATE threads SET session_id = ? WHERE thread_id = ?', [sessionId ?? '', threadId]);
}

export function updateThreadModel(threadId: string, model: string): void {
    db.run('UPDATE threads SET model = ? WHERE thread_id = ?', [model, threadId]);
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

    // Cleared / new: generate fresh session ID and persist
    if (!mapping.session_id) {
        const sessionId = crypto.randomUUID();
        db.run('UPDATE threads SET session_id = ? WHERE thread_id = ?', [sessionId, threadId]);
        log(`Session state: new (thread=${threadId}, session=${sessionId})`);
        return { sessionId, resume: false };
    }

    // Normal resume
    log(`Session state: resume (thread=${threadId}, session=${mapping.session_id})`);
    return { sessionId: mapping.session_id, resume: true };
}

export function setChannelConfig(channelId: string, workingDir: string): void {
    db.run(`
        INSERT INTO channels (channel_id, working_dir) VALUES (?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET working_dir = ?, updated_at = CURRENT_TIMESTAMP
    `, [channelId, workingDir, workingDir]);

    // Invalidate cache
    channelConfigCache.delete(channelId);
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
    verbose: number;
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
}

export function getCronJob(jobId: string): CronJob | null {
    return db.query('SELECT job_id, thread_id, creator_id, schedule, prompt, enabled, name, verbose FROM cron_jobs WHERE job_id = ?')
        .get(jobId) as CronJob | null;
}

export function getCronJobByThread(threadId: string): CronJob | null {
    return db.query('SELECT job_id, thread_id, creator_id, schedule, prompt, enabled, name, verbose FROM cron_jobs WHERE thread_id = ?')
        .get(threadId) as CronJob | null;
}

export function listCronJobs(): CronJob[] {
    return db.query('SELECT job_id, thread_id, creator_id, schedule, prompt, enabled, name, verbose FROM cron_jobs ORDER BY created_at DESC')
        .all() as CronJob[];
}

export function setCronJobVerbose(jobId: string, verbose: boolean): void {
    db.run('UPDATE cron_jobs SET verbose = ? WHERE job_id = ?', [verbose ? 1 : 0, jobId]);
}

export function setCronJobEnabled(jobId: string, enabled: boolean): void {
    db.run('UPDATE cron_jobs SET enabled = ? WHERE job_id = ?', [enabled ? 1 : 0, jobId]);
}

export function deleteCronJob(jobId: string): void {
    db.run('DELETE FROM cron_jobs WHERE job_id = ?', [jobId]);
}
