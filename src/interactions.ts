/**
 * Interactions - Slash command handlers and interactive component logic
 *
 * All /disclaw subcommand handlers live here, keeping bot.ts focused on
 * event routing and message handling.
 */

import {
    TextChannel,
    ThreadAutoArchiveDuration,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ComponentType,
    ModalBuilder,
    LabelBuilder,
    MessageFlags,
    type AutocompleteInteraction,
    type ChatInputCommandInteraction,
    type StringSelectMenuInteraction,
    type ModalSubmitInteraction,
    type Client,
} from 'discord.js';
import { existsSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { runner } from './runner.js';
import {
    db,
    getChannelConfigCached,
    setChannelConfig,
    getThreadMapping,
    updateThreadSession,
    updateThreadModel,
    updateThreadPermissionMode,
    updateThreadDisplayMode,
    updateThreadWorkingDir,
    listCronJobs,
    cronJobDisplayName,
} from './db.js';
import { truncateCodePoints, sendToThread, sendEmbed } from './discord.js';
import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { startDirPicker } from './dir-picker.js';
import { sendHistory } from './history.js';
import { createLogger } from './logger.js';

const log = createLogger('interactions');

// Allowed working directories (configurable via env, comma-separated)
const ALLOWED_DIRS = process.env.DISCLAW_ALLOWED_DIRS
    ? process.env.DISCLAW_ALLOWED_DIRS.split(',').map(d => resolve(d.trim()))
    : null;

/** Validate that a path is within the allowed directories. */
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

// =========================================================================
// HELPERS
// =========================================================================

/** Validate that the interaction is in a thread with an active session. */
function requireThreadSession(interaction: ChatInputCommandInteraction) {
    if (!interaction.channel?.isThread()) {
        log.debug(`requireThreadSession: rejected — not in a thread (channel=${interaction.channelId}, user=${interaction.user.tag})`);
        interaction.reply({ content: 'This command can only be used in a Disclaw thread.', flags: MessageFlags.Ephemeral });
        return null;
    }
    const threadId = interaction.channel.id;
    const mapping = getThreadMapping(threadId);
    if (!mapping) {
        log.debug(`requireThreadSession: rejected — no mapping for thread ${threadId} (user=${interaction.user.tag})`);
        interaction.reply({ content: 'No active session in this thread.', flags: MessageFlags.Ephemeral });
        return null;
    }
    return { threadId, mapping };
}

// =========================================================================
// COMMAND HANDLERS
// =========================================================================

/** Resolve the base working directory for the current context. */
function resolveBaseDir(interaction: ChatInputCommandInteraction | AutocompleteInteraction): string {
    const isThread = interaction.channel?.isThread();
    if (isThread) {
        const mapping = getThreadMapping(interaction.channel!.id);
        const parentId = interaction.channel!.parentId || '';
        return mapping?.working_dir ||
            getChannelConfigCached(parentId)?.working_dir ||
            process.env.CLAUDE_WORKING_DIR || process.cwd();
    }
    const config = getChannelConfigCached(interaction.channelId);
    return config?.working_dir || process.env.CLAUDE_WORKING_DIR || process.cwd();
}

/** List subdirectories matching a partial input for autocomplete. */
function listDirCompletions(input: string, baseDir: string): { name: string; value: string }[] {
    try {
        // Resolve input relative to baseDir
        const inputPath = input ? resolve(baseDir, input) : baseDir;

        // Determine the directory to list and the prefix to filter
        let dirToList: string;
        let prefix: string;
        if (existsSync(inputPath) && statSync(inputPath).isDirectory()) {
            // Input is a complete directory — list its children
            dirToList = inputPath;
            prefix = '';
        } else {
            // Input is partial — list parent and filter by prefix
            dirToList = dirname(inputPath);
            prefix = basename(inputPath).toLowerCase();
        }

        if (!existsSync(dirToList)) return [];

        const entries = readdirSync(dirToList, { withFileTypes: true });
        const dirs = entries
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .filter(e => !prefix || e.name.toLowerCase().startsWith(prefix))
            .slice(0, 25)
            .map(e => {
                const full = resolve(dirToList, e.name);
                return { name: full, value: full };
            });

        // If the input itself is a valid directory, include it at the top
        if (existsSync(inputPath) && statSync(inputPath).isDirectory() && input) {
            const resolved = resolve(inputPath);
            dirs.unshift({ name: `${resolved} (select)`, value: resolved });
            return dirs.slice(0, 25);
        }

        return dirs;
    } catch {
        return [];
    }
}

export async function handleCdAutocomplete(interaction: AutocompleteInteraction) {
    const focused = interaction.options.getFocused();
    const baseDir = resolveBaseDir(interaction);
    const choices = listDirCompletions(focused, baseDir);
    await interaction.respond(choices);
}

export async function handleCd(interaction: ChatInputCommandInteraction) {
    const isThread = interaction.channel?.isThread();
    log(`/disclaw cd invoked by ${interaction.user.tag} in ${isThread ? 'thread' : 'channel'} ${interaction.channelId}`);

    const pathOption = interaction.options.getString('path');

    // Thread context: require an active session
    if (isThread) {
        const threadId = interaction.channel!.id;
        const mapping = getThreadMapping(threadId);
        if (!mapping) {
            log.warn(`cd: no mapping for thread ${threadId}`);
            await interaction.reply({ content: 'No active session in this thread.', flags: MessageFlags.Ephemeral });
            return;
        }

        if (pathOption) {
            // Direct path from autocomplete
            const selected = resolve(pathOption);
            const validationError = validateWorkingDir(selected);
            if (validationError) {
                log.warn(`cd: validation failed for "${selected}" in thread ${threadId}: ${validationError}`);
                await interaction.reply({ content: validationError, flags: MessageFlags.Ephemeral });
                return;
            }
            updateThreadWorkingDir(threadId, selected);
            updateThreadSession(threadId, null);
            await interaction.reply({ content: `Working directory set to \`${selected}\``, flags: MessageFlags.Ephemeral });
            log(`Thread ${threadId} working dir set to: ${selected} (session cleared)`);
            return;
        }

        // No path — fall back to interactive dir picker
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const parentId = interaction.channel!.parentId || '';
        const startDir = mapping.working_dir ||
            getChannelConfigCached(parentId)?.working_dir ||
            process.env.CLAUDE_WORKING_DIR || process.cwd();
        log.debug(`cd: start dir resolved to ${startDir} for thread ${threadId}`);

        const selected = await startDirPicker(interaction, startDir);
        if (!selected) {
            log.debug(`cd: dir picker cancelled in thread ${threadId}`);
            return;
        }

        const validationError = validateWorkingDir(selected);
        if (validationError) {
            log.warn(`cd: validation failed for "${selected}" in thread ${threadId}: ${validationError}`);
            await interaction.editReply({ content: validationError, components: [] });
            return;
        }

        updateThreadWorkingDir(threadId, selected);
        updateThreadSession(threadId, null); // Clear session — new dir needs fresh session
        log(`Thread ${threadId} working dir set to: ${selected} (session cleared)`);
        return;
    }

    // Channel context: set channel default
    if (pathOption) {
        const selected = resolve(pathOption);
        const validationError = validateWorkingDir(selected);
        if (validationError) {
            log.warn(`cd: validation failed for "${selected}" in channel ${interaction.channelId}: ${validationError}`);
            await interaction.reply({ content: validationError, flags: MessageFlags.Ephemeral });
            return;
        }
        setChannelConfig(interaction.channelId, selected);
        await interaction.reply({ content: `Channel working directory set to \`${selected}\``, flags: MessageFlags.Ephemeral });
        log(`Channel ${interaction.channelId} configured with working dir: ${selected}`);
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const currentConfig = getChannelConfigCached(interaction.channelId);
    const startDir = currentConfig?.working_dir || process.env.CLAUDE_WORKING_DIR || process.cwd();
    log.debug(`cd: channel start dir resolved to ${startDir} for channel ${interaction.channelId}`);

    const selected = await startDirPicker(interaction, startDir);
    if (!selected) {
        log.debug(`cd: dir picker cancelled in channel ${interaction.channelId}`);
        return;
    }

    const validationError = validateWorkingDir(selected);
    if (validationError) {
        log.warn(`cd: validation failed for "${selected}" in channel ${interaction.channelId}: ${validationError}`);
        await interaction.editReply({ content: validationError, components: [] });
        return;
    }

    setChannelConfig(interaction.channelId, selected);
    log(`Channel ${interaction.channelId} configured with working dir: ${selected}`);
}

export async function handleClear(interaction: ChatInputCommandInteraction) {
    log(`/disclaw clear invoked by ${interaction.user.tag} in channel ${interaction.channelId}`);
    const ctx = requireThreadSession(interaction);
    if (!ctx) return;
    updateThreadSession(ctx.threadId, null);
    await interaction.reply({ content: 'Context cleared.', flags: MessageFlags.Ephemeral });
    log(`Context cleared in thread ${ctx.threadId} by ${interaction.user.tag}`);
}

export async function handleInterrupt(interaction: ChatInputCommandInteraction) {
    log(`/disclaw interrupt invoked by ${interaction.user.tag} in channel ${interaction.channelId}`);
    const ctx = requireThreadSession(interaction);
    if (!ctx) return;
    if (!runner.isRunning(ctx.threadId)) {
        log.debug(`interrupt: nothing running in thread ${ctx.threadId}`);
        await interaction.reply({ content: 'Nothing running.', flags: MessageFlags.Ephemeral });
        return;
    }
    await runner.interrupt(ctx.threadId);
    await interaction.reply({ content: 'Interrupted.', flags: MessageFlags.Ephemeral });
    log(`Interrupted job in thread ${ctx.threadId} by ${interaction.user.tag}`);
}

export async function handleConfig(interaction: ChatInputCommandInteraction) {
    log(`/disclaw config invoked by ${interaction.user.tag} in channel ${interaction.channelId}`);
    const ctx = requireThreadSession(interaction);
    if (!ctx) return;

    const models = runner.getModels();
    if (models.length === 0) {
        log.warn(`config: model list not available yet for thread ${ctx.threadId}`);
        await interaction.reply({
            content: 'Model list not available yet. Send a message first, then try again.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const currentModel = ctx.mapping.model || models[0]?.value || '';
    const currentPermission = ctx.mapping.permission_mode || process.env.DISCLAW_PERMISSION_MODE || 'default';
    const currentDisplay = ctx.mapping.display_mode || 'pager';

    log.debug(`config: current model=${currentModel} permission=${currentPermission} display=${currentDisplay} thread=${ctx.threadId}`);

    const modelSelect = new StringSelectMenuBuilder()
        .setCustomId('config_model')
        .setPlaceholder('Pick a model')
        .addOptions(
            models.slice(0, 25).map(m => ({
                label: m.displayName,
                value: m.value,
                description: truncateCodePoints(m.description, 100),
                default: m.value === currentModel,
            }))
        );

    const permissionSelect = new StringSelectMenuBuilder()
        .setCustomId('config_permission')
        .addOptions(
            PERMISSION_MODES.map(m => ({
                label: m.label,
                value: m.value,
                description: m.description,
                default: m.value === currentPermission,
            }))
        );

    const displaySelect = new StringSelectMenuBuilder()
        .setCustomId('config_display')
        .addOptions(
            DISPLAY_MODES.map(m => ({
                label: m.label,
                value: m.value,
                description: m.description,
                default: m.value === currentDisplay,
            }))
        );

    const modal = new ModalBuilder()
        .setCustomId('disclaw_config_modal')
        .setTitle('Thread Config')
        .addLabelComponents(
            new LabelBuilder().setLabel('Model').setStringSelectMenuComponent(modelSelect),
            new LabelBuilder().setLabel('Permission Mode').setStringSelectMenuComponent(permissionSelect),
            new LabelBuilder().setLabel('Display Mode').setStringSelectMenuComponent(displaySelect),
        );

    await interaction.showModal(modal);
    log.debug(`config: modal shown for thread ${ctx.threadId}`);
}

export async function handleConfigSubmit(interaction: ModalSubmitInteraction) {
    const threadId = interaction.channel?.isThread() ? interaction.channel.id : null;
    if (!threadId) return;

    const mapping = getThreadMapping(threadId);
    if (!mapping) return;

    log(`Config modal submitted by ${interaction.user.tag} in thread ${threadId}`);

    const changes: string[] = [];

    // Model
    const modelValues = interaction.fields.getStringSelectValues('config_model');
    if (modelValues.length > 0) {
        const modelValue = modelValues[0]!;
        updateThreadModel(threadId, modelValue);
        const models = runner.getModels();
        const modelInfo = models.find(m => m.value === modelValue);
        changes.push(`Model → **${modelInfo?.displayName || modelValue}**`);
        log(`Model set to ${modelValue} in thread ${threadId}`);
    }

    // Permission
    const permValues = interaction.fields.getStringSelectValues('config_permission');
    if (permValues.length > 0) {
        const modeValue = permValues[0]!;
        const envDefault = process.env.DISCLAW_PERMISSION_MODE || 'default';
        updateThreadPermissionMode(threadId, modeValue === envDefault ? null : modeValue);
        const modeInfo = PERMISSION_MODES.find(m => m.value === modeValue);
        changes.push(`Permission → **${modeInfo?.label || modeValue}**`);
        log(`Permission mode set to ${modeValue} in thread ${threadId}`);
    }

    // Display
    const displayValues = interaction.fields.getStringSelectValues('config_display');
    if (displayValues.length > 0) {
        const modeValue = displayValues[0]!;
        updateThreadDisplayMode(threadId, modeValue === 'verbose' ? null : modeValue);
        const modeInfo = DISPLAY_MODES.find(m => m.value === modeValue);
        changes.push(`Display → **${modeInfo?.label || modeValue}**`);
        log(`Display mode set to ${modeValue} in thread ${threadId}`);
    }

    const summary = changes.length > 0 ? changes.join('\n') : 'No changes.';
    await interaction.reply({ content: summary, flags: MessageFlags.Ephemeral });
}

export async function handleFork(interaction: ChatInputCommandInteraction, client: Client) {
    log(`/disclaw fork invoked by ${interaction.user.tag} in channel ${interaction.channelId}`);
    const ctx = requireThreadSession(interaction);
    if (!ctx) return;

    if (!ctx.mapping.session_id) {
        log.warn(`fork: no session to fork in thread ${ctx.threadId} (context was cleared)`);
        await interaction.reply({ content: 'No session to fork (context was cleared).', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const thread = interaction.channel!;
        if (!thread.isThread() || !thread.parentId) {
            log.warn(`fork: could not find parent channel for thread ${ctx.threadId}`);
            await interaction.editReply('Could not find parent channel.');
            return;
        }
        const parentChannelId = thread.parentId;

        const parentChannel = await client.channels.fetch(parentChannelId);
        if (!parentChannel?.isTextBased()) {
            log.warn(`fork: parent channel ${parentChannelId} is not a text channel`);
            await interaction.editReply('Parent channel is not a text channel.');
            return;
        }

        // Determine working dir (inherit from original thread)
        const workingDir = resolve(ctx.mapping.working_dir ||
            getChannelConfigCached(parentChannelId)?.working_dir ||
            process.env.CLAUDE_WORKING_DIR ||
            process.cwd());
        log.debug(`fork: working dir resolved to ${workingDir} for thread ${ctx.threadId}`);

        // Create status message and new thread in parent channel
        const statusMessage = await (parentChannel as TextChannel).send('Forked conversation');
        const newThread = await statusMessage.startThread({
            name: `Fork of ${thread.name}`,
            autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        });

        // Store mapping with fork_from — first user message will trigger the actual fork
        db.run(
            'INSERT INTO threads (thread_id, session_id, working_dir, model, fork_from) VALUES (?, ?, ?, ?, ?)',
            [newThread.id, '', workingDir, ctx.mapping.model, ctx.mapping.session_id]
        );

        await sendToThread(newThread.id, `Forked from <#${ctx.threadId}>`);
        await sendHistory(newThread.id, ctx.mapping.session_id, workingDir);

        await interaction.editReply(`Forked → <#${newThread.id}>`);
        log(`Forked thread ${ctx.threadId} → ${newThread.id} (session=${ctx.mapping.session_id}) by ${interaction.user.tag}`);
    } catch (error) {
        log.error(`fork: failed for thread ${ctx.threadId}: ${error}`);
        await interaction.editReply('Failed to fork conversation.');
    }
}

export async function handleResume(interaction: ChatInputCommandInteraction) {
    log(`/disclaw resume invoked by ${interaction.user.tag} in channel ${interaction.channelId}`);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        // Determine working dir: thread working_dir → channel config → env → cwd
        const isThread = interaction.channel?.isThread();
        const threadMapping = isThread ? getThreadMapping(interaction.channel!.id) : null;
        const channelId = isThread
            ? (interaction.channel!.parentId || interaction.channelId)
            : interaction.channelId;
        const channelConfig = getChannelConfigCached(channelId);
        const workingDir = resolve(
            threadMapping?.working_dir ||
            channelConfig?.working_dir ||
            process.env.CLAUDE_WORKING_DIR || process.cwd());
        log.debug(`resume: working dir resolved to ${workingDir}`);

        // List recent sessions
        const sessions = await listSessions({ dir: workingDir, limit: 25 });
        if (sessions.length === 0) {
            log.debug(`resume: no sessions found in ${workingDir}`);
            await interaction.editReply('No sessions found.');
            return;
        }

        const top = sessions.slice(0, 25);
        log.debug(`resume: found ${sessions.length} sessions, presenting ${top.length}`);

        // Build select menu — use summary/firstPrompt (already available), no extra fetches
        const select = new StringSelectMenuBuilder()
            .setCustomId('disclaw_resume_select')
            .setPlaceholder('Pick a session to resume')
            .addOptions(
                top.map((s) => {
                    const time = new Date(s.lastModified).toLocaleString('en-US', {
                        month: 'short', day: 'numeric',
                        hour: 'numeric', minute: '2-digit', hour12: true,
                    });
                    const desc = s.firstPrompt
                        ? `${time} · ${truncateCodePoints(s.firstPrompt.replace(/\n/g, ' '), 100 - time.length - 3)}`
                        : time;
                    return {
                        label: truncateCodePoints(s.summary || s.firstPrompt || s.sessionId, 100),
                        value: s.sessionId,
                        description: truncateCodePoints(desc, 100),
                    };
                })
            );

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
        const reply = await interaction.editReply({ content: 'Pick a session:', components: [row] });

        let selected: StringSelectMenuInteraction;
        try {
            selected = await reply.awaitMessageComponent({
                componentType: ComponentType.StringSelect,
                time: 60_000,
            }) as StringSelectMenuInteraction;
        } catch {
            log.debug(`resume: selection timed out for ${interaction.user.tag}`);
            await interaction.editReply({ content: 'Selection timed out.', components: [] });
            return;
        }

        const selectedSessionId = selected.values[0]!;
        const selectedSession = sessions.find(s => s.sessionId === selectedSessionId);
        const summary = selectedSession?.summary || selectedSessionId.slice(0, 8);

        if (interaction.channel?.isThread()) {
            const threadId = interaction.channel.id;
            const mapping = getThreadMapping(threadId);
            if (mapping) {
                updateThreadSession(threadId, selectedSessionId);
                await selected.update({ content: `Resumed: ${summary}`, components: [] });
                await sendEmbed(threadId, [{
                    color: 0x57f287,
                    description: `**Resumed session** · \`${workingDir}\``,
                }]);
                await sendHistory(threadId, selectedSessionId, workingDir);
                log(`Resumed session ${selectedSessionId} in thread ${threadId} by ${interaction.user.tag}`);
            } else {
                log.warn(`resume: no mapping for thread ${threadId} when trying to resume`);
                await selected.update({ content: 'No active session in this thread.', components: [] });
            }
        } else {
            const parentChannel = interaction.channel as TextChannel;
            const statusMessage = await parentChannel.send(`Resuming: ${truncateCodePoints(summary, 100)}`);
            const newThread = await statusMessage.startThread({
                name: truncateCodePoints(summary, 50),
                autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
            });

            db.run(
                'INSERT INTO threads (thread_id, session_id, working_dir) VALUES (?, ?, ?)',
                [newThread.id, selectedSessionId, workingDir]
            );

            await selected.update({ content: `Resumed in <#${newThread.id}>`, components: [] });
            await sendEmbed(newThread.id, [{
                color: 0x57f287,
                description: `**Resumed session** · \`${workingDir}\``,
            }]);
            await sendHistory(newThread.id, selectedSessionId, workingDir);
            log(`Resumed session ${selectedSessionId} in new thread ${newThread.id} by ${interaction.user.tag}`);
        }
    } catch (error) {
        log.error(`resume: failed for ${interaction.user.tag}: ${error}`);
        await interaction.editReply({ content: 'Failed to list sessions.', components: [] });
    }
}

export async function handleCron(interaction: ChatInputCommandInteraction) {
    log(`/disclaw cron invoked by ${interaction.user.tag} in channel ${interaction.channelId}`);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const jobs = listCronJobs();
    if (jobs.length === 0) {
        log.debug('cron: no scheduled tasks found');
        await interaction.editReply('No scheduled tasks.');
        return;
    }
    log.debug(`cron: listing ${jobs.length} scheduled tasks`);
    const lines = jobs.map(job => {
        const status = job.enabled ? '\u{1F7E2}' : '\u{23F8}\u{FE0F}';
        return `${status} \`${job.schedule}\` — **${cronJobDisplayName(job)}** → <#${job.thread_id}>`;
    });
    await interaction.editReply({
        embeds: [{
            color: 0x5865f2,
            title: 'Scheduled Tasks',
            description: lines.join('\n'),
        }],
    });
}

/** Permission mode definitions with labels and descriptions */
const PERMISSION_MODES = [
    { value: 'default', label: 'Default', description: 'No auto-approvals; tools trigger approval UI' },
    { value: 'dontAsk', label: 'Don\'t Ask', description: 'Deny instead of prompting (no canUseTool calls)' },
    { value: 'acceptEdits', label: 'Accept Edits', description: 'Auto-accept file edits and filesystem operations' },
    { value: 'bypassPermissions', label: 'Bypass', description: 'All tools run without permission prompts' },
    { value: 'plan', label: 'Plan', description: 'No tool execution; Claude plans without making changes' },
] as const;

/** Display mode definitions */
const DISPLAY_MODES = [
    { value: 'verbose', label: 'Verbose', description: 'Show all tool messages as they arrive' },
    { value: 'simple', label: 'Simple', description: 'Hide tool and thinking messages, show only final reply' },
    { value: 'pager', label: 'Pager', description: 'Tool calls in a single navigable embed with page buttons' },
] as const;
