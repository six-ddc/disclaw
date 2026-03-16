/**
 * Cron Buttons - Control panel embed and button interaction handler
 *
 * Provides persistent buttons for Pause/Resume, Run Now, and Delete.
 * Buttons use customId format: cron:{jobId}:{action}
 */

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    type ButtonInteraction,
} from 'discord.js';
import { getCronJob, cronJobDisplayName, type CronJob } from './db.js';
import { sendRichMessage, editRichMessage, truncateCodePoints, type EmbedData } from './discord.js';
import { getCronScheduler } from './cron.js';
import { createLogger } from './logger.js';

const log = createLogger('cron-buttons');

const TIMEZONE = process.env.TZ;

/** Build the control panel embed for a cron job */
export function buildControlEmbed(job: CronJob, nextRun?: Date | null): EmbedData {
    log.debug(`Building control embed for job ${job.job_id} (enabled=${job.enabled})`);
    const status = job.enabled ? 'Active' : 'Paused';
    const statusIcon = job.enabled ? '\u{1F7E2}' : '\u{23F8}\u{FE0F}';

    const fields = [
        { name: 'Schedule', value: `\`${job.schedule}\``, inline: true },
        { name: 'Status', value: `${statusIcon} ${status}`, inline: true },
    ];

    if (nextRun) {
        const timeStr = nextRun.toLocaleString('en-US', {
            month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', hour12: true,
            ...(TIMEZONE ? { timeZone: TIMEZONE } : {}),
        });
        fields.push({ name: 'Next Run', value: timeStr, inline: true });
    }

    fields.push({
        name: 'Prompt',
        value: truncateCodePoints(job.prompt, 500),
        inline: false,
    });

    return {
        color: job.enabled ? 0x5865f2 : 0x888888,
        title: cronJobDisplayName(job),
        fields,
        footer: { text: `Job ID: ${job.job_id}` },
    };
}

/** Build action row with buttons */
export function buildButtons(job: CronJob): ActionRowBuilder<ButtonBuilder> {
    log.debug(`Building buttons for job ${job.job_id} (enabled=${job.enabled})`);
    const row = new ActionRowBuilder<ButtonBuilder>();

    if (job.enabled) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`cron:${job.job_id}:pause`)
                .setLabel('Pause')
                .setEmoji('\u{23F8}\u{FE0F}')
                .setStyle(ButtonStyle.Secondary),
        );
    } else {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`cron:${job.job_id}:resume`)
                .setLabel('Resume')
                .setEmoji('\u{25B6}\u{FE0F}')
                .setStyle(ButtonStyle.Success),
        );
    }

    row.addComponents(
        new ButtonBuilder()
            .setCustomId(`cron:${job.job_id}:runnow`)
            .setLabel('Run Now')
            .setEmoji('\u{25B6}')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`cron:${job.job_id}:delete`)
            .setLabel('Delete')
            .setEmoji('\u{1F5D1}\u{FE0F}')
            .setStyle(ButtonStyle.Danger),
    );

    return row;
}

/** Send a cron control panel embed with buttons to a thread */
export async function sendCronControlPanel(
    threadId: string,
    job: CronJob,
    nextRun?: Date | null,
): Promise<void> {
    const embed = buildControlEmbed(job, nextRun);
    const row = buildButtons(job);

    await sendRichMessage(threadId, {
        embeds: [embed],
        components: [row],
    });
    log(`Sent control panel for job ${job.job_id} to thread ${threadId}`);
}

/** Update the cron control panel (starter message) for a job */
export async function updateCronControlPanel(jobId: string): Promise<void> {
    const job = getCronJob(jobId);
    if (!job) {
        log.warn(`Cannot update panel for job ${jobId}: not found`);
        return;
    }
    const nextRun = getCronScheduler().getNextRun(jobId);
    const embed = buildControlEmbed(job, nextRun);
    const row = buildButtons(job);
    // Thread starter message ID === thread ID in Discord
    await editRichMessage(job.thread_id, job.thread_id, { embeds: [embed], components: [row] });
    log(`Updated control panel for job ${jobId}`);
}

/** Mark the control panel as deleted (grey embed, no buttons) */
export async function markPanelDeleted(job: CronJob): Promise<void> {
    await editRichMessage(job.thread_id, job.thread_id, {
        embeds: [{
            color: 0x888888,
            title: 'Scheduled Task (Deleted)',
            description: `~~${truncateCodePoints(job.prompt, 200)}~~`,
            footer: { text: `Job ID: ${job.job_id}` },
        }],
        components: [],
    });
    log(`Marked panel deleted for job ${job.job_id}`);
}

/** Handle cron button interactions. Returns true if handled. */
export async function handleCronInteraction(interaction: ButtonInteraction): Promise<boolean> {
    const customId = interaction.customId;
    if (!customId.startsWith('cron:')) return false;

    const parts = customId.split(':');
    if (parts.length !== 3) return false;

    const jobId = parts[1]!;
    const action = parts[2]!;

    log.debug(`Handling cron button: action=${action}, jobId=${jobId}, user=${interaction.user.tag}`);

    const job = getCronJob(jobId);
    if (!job) {
        log.warn(`Button interaction for nonexistent job ${jobId} by ${interaction.user.tag}`);
        await interaction.reply({
            content: 'This scheduled task no longer exists.',
            flags: MessageFlags.Ephemeral,
        });
        return true;
    }

    // Permission check: only creator can manage
    if (interaction.user.id !== job.creator_id) {
        log.warn(`Permission denied: user ${interaction.user.tag} tried to ${action} job ${jobId} (creator=${job.creator_id})`);
        await interaction.reply({
            content: 'Only the creator of this task can manage it.',
            flags: MessageFlags.Ephemeral,
        });
        return true;
    }

    const scheduler = getCronScheduler();

    if (action === 'pause') {
        scheduler.pause(jobId);
        const updated = getCronJob(jobId)!;
        const embed = buildControlEmbed(updated);
        const row = buildButtons(updated);
        await interaction.update({ embeds: [embed], components: [row] });
        log(`Job ${jobId} paused by ${interaction.user.tag}`);
    } else if (action === 'resume') {
        scheduler.resume(jobId);
        const updated = getCronJob(jobId)!;
        const nextRun = scheduler.getNextRun(jobId);
        const embed = buildControlEmbed(updated, nextRun);
        const row = buildButtons(updated);
        await interaction.update({ embeds: [embed], components: [row] });
        log(`Job ${jobId} resumed by ${interaction.user.tag}`);
    } else if (action === 'runnow') {
        scheduler.runNow(jobId);
        await interaction.reply({
            content: 'Running now...',
            flags: MessageFlags.Ephemeral,
        });
        log(`Job ${jobId} manual run by ${interaction.user.tag}`);
    } else if (action === 'delete') {
        scheduler.delete(jobId);
        await interaction.update({
            embeds: [{
                color: 0x888888,
                title: 'Scheduled Task (Deleted)',
                description: `~~${truncateCodePoints(job.prompt, 200)}~~`,
                footer: { text: `Job ID: ${jobId} · Deleted by ${interaction.user.tag}` },
            }],
            components: [],
        });
        log(`Job ${jobId} deleted by ${interaction.user.tag}`);
    } else {
        log.warn(`Unknown cron button action "${action}" for job ${jobId}`);
        await interaction.reply({
            content: 'Unknown action.',
            flags: MessageFlags.Ephemeral,
        });
    }

    return true;
}
