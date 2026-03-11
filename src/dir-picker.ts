/**
 * Directory Picker - Interactive file browser for Discord
 *
 * Button-based directory navigation inspired by clawgo's mountdir picker.
 * Shows current path + subdirectory buttons + navigation controls.
 */

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    type ButtonInteraction,
    type InteractionEditReplyOptions,
    type Message,
    type MessagePayload,
} from 'discord.js';
import { readdirSync, statSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { createLogger } from './logger.js';

const log = createLogger('dir-picker');
const DIRS_PER_PAGE = 10; // 2 rows of 5
const TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

interface PendingPick {
    pickId: string;
    currentDir: string;
    page: number;
    resolve: (dir: string | null) => void;
    timeout: Timer;
    message?: Message;
}

const pendingPicks = new Map<string, PendingPick>();

/** List subdirectories of a path, sorted alphabetically. */
function listDirs(dir: string): string[] {
    try {
        const dirs = readdirSync(dir)
            .filter(name => {
                if (name.startsWith('.')) return false;
                try {
                    return statSync(resolve(dir, name)).isDirectory();
                } catch {
                    return false;
                }
            })
            .sort();
        log.debug(`Listed ${dirs.length} subdirectories in ${dir}`);
        return dirs;
    } catch (err) {
        log.warn(`Failed to list directories in ${dir}: ${err}`);
        return [];
    }
}

/** Build the message content and button components for the current state. */
function buildPickerMessage(pick: PendingPick) {
    log.debug(`Building picker message: pickId=${pick.pickId}, dir=${pick.currentDir}, page=${pick.page}`);
    const dirs = listDirs(pick.currentDir);
    const totalPages = Math.max(1, Math.ceil(dirs.length / DIRS_PER_PAGE));
    const page = Math.min(pick.page, totalPages - 1);
    const start = page * DIRS_PER_PAGE;
    const pageDirs = dirs.slice(start, start + DIRS_PER_PAGE);

    const content = `**Select Working Directory**\n\`${pick.currentDir}\`\n` +
        (dirs.length > 0
            ? `Page ${page + 1}/${totalPages} · ${dirs.length} subdirectories`
            : 'No subdirectories');

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];

    // Directory buttons (up to 2 rows of 5)
    for (let r = 0; r < 2; r++) {
        const rowDirs = pageDirs.slice(r * 5, r * 5 + 5);
        if (rowDirs.length === 0) break;
        rows.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                rowDirs.map((name, i) =>
                    new ButtonBuilder()
                        .setCustomId(`dirpick:${pick.pickId}:dir:${start + r * 5 + i}`)
                        .setLabel(name.length > 25 ? name.slice(0, 22) + '...' : name)
                        .setStyle(ButtonStyle.Secondary)
                )
            )
        );
    }

    // Navigation row: Up | Prev | Next
    const isRoot = pick.currentDir === '/';
    rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`dirpick:${pick.pickId}:up`)
                .setLabel('↑ Up')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(isRoot),
            new ButtonBuilder()
                .setCustomId(`dirpick:${pick.pickId}:prev`)
                .setLabel('◀')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0),
            new ButtonBuilder()
                .setCustomId(`dirpick:${pick.pickId}:next`)
                .setLabel('▶')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page >= totalPages - 1),
        )
    );

    // Action row: Select | Cancel
    rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`dirpick:${pick.pickId}:select`)
                .setLabel('Select This')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`dirpick:${pick.pickId}:cancel`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger),
        )
    );

    return { content, components: rows };
}

/**
 * Start an interactive directory picker.
 * Returns the selected directory path, or null if cancelled/timed out.
 *
 * @param interaction - The deferred interaction to edit with picker UI
 * @param startDir - Starting directory (default: cwd)
 */
export function startDirPicker(interaction: { editReply: (opts: string | MessagePayload | InteractionEditReplyOptions) => Promise<Message> }, startDir?: string): Promise<string | null> {
    const pickId = crypto.randomUUID().slice(0, 8);
    const currentDir = resolve(startDir || process.cwd());

    log(`Picker opened: pickId=${pickId}, startDir=${currentDir}`);

    return new Promise<string | null>(async (resolvePromise) => {
        const timeout = setTimeout(() => {
            log.warn(`Picker timed out: pickId=${pickId}, lastDir=${pendingPicks.get(pickId)?.currentDir}`);
            pendingPicks.delete(pickId);
            interaction.editReply({ content: 'Directory selection timed out.', components: [] }).catch(() => {});
            resolvePromise(null);
        }, TIMEOUT_MS);

        const pick: PendingPick = { pickId, currentDir, page: 0, resolve: resolvePromise, timeout };
        pendingPicks.set(pickId, pick);

        try {
            const msg = buildPickerMessage(pick);
            pick.message = await interaction.editReply(msg);
        } catch (err) {
            log.error(`Failed to send initial picker message: pickId=${pickId}, error=${err}`);
            clearTimeout(timeout);
            pendingPicks.delete(pickId);
            resolvePromise(null);
        }
    });
}

/**
 * Handle a button interaction for the directory picker.
 * Returns true if the interaction was handled, false otherwise.
 */
export async function handleDirPickInteraction(interaction: ButtonInteraction): Promise<boolean> {
    const { customId } = interaction;
    if (!customId.startsWith('dirpick:')) return false;

    const parts = customId.split(':');
    const pickId = parts[1]!;
    const action = parts[2]!;

    const pick = pendingPicks.get(pickId);
    if (!pick) {
        log.warn(`Picker interaction for expired picker: pickId=${pickId}, action=${action}`);
        await interaction.update({ content: 'This picker has expired.', components: [] });
        return true;
    }

    const dirs = listDirs(pick.currentDir);

    if (action === 'dir') {
        const idx = parseInt(parts[3]!, 10);
        const target = dirs[idx];
        if (target) {
            const prevDir = pick.currentDir;
            pick.currentDir = resolve(pick.currentDir, target);
            pick.page = 0;
            log(`Directory navigated: pickId=${pickId}, ${prevDir} → ${pick.currentDir}`);
        }
        await interaction.update(buildPickerMessage(pick));
    } else if (action === 'up') {
        const prevDir = pick.currentDir;
        pick.currentDir = dirname(pick.currentDir);
        pick.page = 0;
        log(`Directory navigated up: pickId=${pickId}, ${prevDir} → ${pick.currentDir}`);
        await interaction.update(buildPickerMessage(pick));
    } else if (action === 'prev') {
        pick.page = Math.max(0, pick.page - 1);
        log.debug(`Picker page prev: pickId=${pickId}, page=${pick.page}`);
        await interaction.update(buildPickerMessage(pick));
    } else if (action === 'next') {
        pick.page++;
        log.debug(`Picker page next: pickId=${pickId}, page=${pick.page}`);
        await interaction.update(buildPickerMessage(pick));
    } else if (action === 'select') {
        clearTimeout(pick.timeout);
        pendingPicks.delete(pickId);
        log(`Directory selected: pickId=${pickId}, dir=${pick.currentDir}`);
        await interaction.update({
            content: `Selected: \`${pick.currentDir}\``,
            components: [],
        });
        pick.resolve(pick.currentDir);
    } else if (action === 'cancel') {
        clearTimeout(pick.timeout);
        pendingPicks.delete(pickId);
        log(`Picker cancelled: pickId=${pickId}, lastDir=${pick.currentDir}`);
        await interaction.update({ content: 'Cancelled.', components: [] });
        pick.resolve(null);
    }

    return true;
}
