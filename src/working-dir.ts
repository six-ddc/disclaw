/**
 * Working Directory Resolution - Centralized fallback chain
 *
 * All working directory resolution flows through this module.
 * Fallback chain: [/path] prefix → mapping.working_dir → channel config → env → cwd()
 */

import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { getChannelConfigCached, getThreadMapping } from './db.js';
import { createLogger } from './logger.js';
import { DEFAULT_WORKING_DIR } from './paths.js';

const log = createLogger('working-dir');

// Allowed working directories (configurable via env, comma-separated)
const ALLOWED_DIRS = process.env.DISCLAW_ALLOWED_DIRS
    ? process.env.DISCLAW_ALLOWED_DIRS.split(',').map(d => resolve(d.trim()))
    : null;

/** Validate that a path is within the allowed directories and exists. */
export function validateWorkingDir(dir: string): string | null {
    const resolved = resolve(dir);
    if (!ALLOWED_DIRS) {
        if (!existsSync(resolved)) {
            log.debug(`validateWorkingDir: directory not found: ${resolved}`);
            return `Directory not found: \`${dir}\``;
        }
        log.debug(`validateWorkingDir: ok (no allowlist) → ${resolved}`);
        return null;
    }
    const isAllowed = ALLOWED_DIRS.some(allowed =>
        resolved === allowed || resolved.startsWith(allowed + '/')
    );
    if (!isAllowed) {
        log.warn(`validateWorkingDir: ${resolved} not in allowed list`);
        return `Directory not in allowed list. Allowed: ${ALLOWED_DIRS.join(', ')}`;
    }
    if (!existsSync(resolved)) {
        log.debug(`validateWorkingDir: directory not found: ${resolved}`);
        return `Directory not found: \`${dir}\``;
    }
    log.debug(`validateWorkingDir: ok → ${resolved}`);
    return null;
}

/**
 * Resolve working directory from the fallback chain (without [/path] prefix parsing).
 *
 * Fallback: threadMapping.working_dir → channelConfig.working_dir → CLAUDE_WORKING_DIR → cwd()
 *
 * @param threadId - Optional thread ID to look up thread-level working_dir
 * @param channelId - Optional channel ID to look up channel config (for threads, use the parent channel ID)
 * @returns Resolved absolute working directory path
 */
export function resolveWorkingDirFromContext(threadId?: string, channelId?: string): string {
    // 1. Thread-level override
    if (threadId) {
        const mapping = getThreadMapping(threadId);
        if (mapping?.working_dir) {
            log.debug(`Working dir resolved via thread mapping: ${mapping.working_dir} thread=${threadId}`);
            return resolve(mapping.working_dir);
        }
    }

    // 2. Channel config
    if (channelId) {
        const channelConfig = getChannelConfigCached(channelId);
        if (channelConfig?.working_dir) {
            log.debug(`Working dir resolved via channel config: ${channelConfig.working_dir} channel=${channelId}`);
            return resolve(channelConfig.working_dir);
        }
    }

    // 3. Environment variable or cwd
    const fallback = process.env.CLAUDE_WORKING_DIR || DEFAULT_WORKING_DIR;
    log.debug(`Working dir resolved via fallback: ${fallback}`);
    return resolve(fallback);
}

/**
 * Resolve working directory from a known mapping and channel ID (no DB lookup).
 *
 * Use this when the thread mapping has already been fetched by the caller.
 * Fallback: mappingWorkingDir → channelConfig.working_dir → CLAUDE_WORKING_DIR → cwd()
 */
export function resolveWorkingDirWithMapping(mappingWorkingDir: string | null, channelId: string): string {
    if (mappingWorkingDir) {
        return resolve(mappingWorkingDir);
    }

    const channelConfig = getChannelConfigCached(channelId);
    if (channelConfig?.working_dir) {
        return resolve(channelConfig.working_dir);
    }

    return resolve(process.env.CLAUDE_WORKING_DIR || DEFAULT_WORKING_DIR);
}

/**
 * Parse a [/path] prefix from a message and resolve the working directory.
 *
 * If the message starts with [/path], validates and uses that path.
 * Otherwise, falls back to channel config → env → cwd().
 *
 * @returns workingDir, cleaned message text, and optional validation error
 */
export function parseWorkingDirFromMessage(message: string, channelId: string): {
    workingDir: string;
    cleanedMessage: string;
    error?: string;
} {
    // Check for [/path] prefix override
    const pathMatch = message.match(/^\[([^\]]+)\]\s*/);
    if (pathMatch && pathMatch[1]) {
        let dir = pathMatch[1];
        if (dir.startsWith('~')) {
            dir = dir.replace('~', homedir());
        }
        const validationError = validateWorkingDir(dir);
        if (validationError) {
            log.debug(`Working dir path override rejected: dir=${dir} channel=${channelId} error="${validationError}"`);
            return {
                workingDir: '',
                cleanedMessage: message.slice(pathMatch[0].length),
                error: validationError
            };
        }
        const resolved = resolve(dir);
        log.debug(`Working dir resolved via [path] override: ${resolved} channel=${channelId}`);
        return {
            workingDir: resolved,
            cleanedMessage: message.slice(pathMatch[0].length)
        };
    }

    // No prefix — use channel-level fallback (no thread mapping here; this is for new mentions)
    const workingDir = resolveWorkingDirWithMapping(null, channelId);
    log.debug(`Working dir resolved for new mention: ${workingDir} channel=${channelId}`);
    return { workingDir, cleanedMessage: message };
}
