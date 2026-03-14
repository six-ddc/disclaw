/**
 * Discord Bot - Catches @mentions, creates threads, runs Claude jobs
 *
 * This is the entry point for the Discord → Claude bridge.
 * Event routing only — command handlers live in interactions.ts.
 */

import {
    ChannelType,
    Client,
    GatewayIntentBits,
    Events,
    Message,
    MessageFlags,
    Partials,
    TextChannel,
    ThreadAutoArchiveDuration,
    SlashCommandBuilder,
    type Interaction,
} from 'discord.js';
import { runner } from './runner.js';
import { db, getThreadMapping } from './db.js';
import { truncateCodePoints, initDiscord, addReaction } from './discord.js';
import {
    handleCd,
    handleCdAutocomplete,
    handleClear,
    handleInterrupt,
    handleConfig,
    handleConfigSubmit,
    handleFork,
    handleResume,
    handleCron,
} from './interactions.js';
import { handleDirPickInteraction } from './dir-picker.js';
import { handleHistoryInteraction } from './history.js';
import { handlePagerInteraction, hidePagerButtons, restorePagerButtons } from './tool-pager.js';
import { initCronScheduler, getCronScheduler } from './cron.js';
import { createDisclawMcpServer } from './mcp-server.js';
import { handleCronInteraction } from './cron-buttons.js';
import { handleUserInputInteraction } from './user-input.js';
import { extractMessageContent } from './attachment-handler.js';
import { buildPrompt } from './context-builder.js';
import { createLogger } from './logger.js';
import { parseWorkingDirFromMessage, resolveWorkingDirWithMapping } from './working-dir.js';

const log = createLogger('bot');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Reaction, Partials.Message],
});

client.once(Events.ClientReady, async (c) => {
    log(`Logged in as ${c.user.tag}`);
    initDiscord(client);
    initCronScheduler(client);

    // Register slash commands (upsert — Discord API is idempotent)
    const command = new SlashCommandBuilder()
        .setName('disclaw')
        .setDescription('Disclaw bot commands')
        .addSubcommand(sub =>
            sub.setName('cd')
               .setDescription('Change working directory (channel default or thread override)')
               .addStringOption(opt =>
                   opt.setName('path')
                      .setDescription('Directory path (leave empty for interactive picker)')
                      .setAutocomplete(true)
               )
        )
        .addSubcommand(sub =>
            sub.setName('clear')
               .setDescription('Clear conversation context (start fresh in this thread)')
        )
        .addSubcommand(sub =>
            sub.setName('interrupt')
               .setDescription('Interrupt the current Claude processing')
        )
        .addSubcommand(sub =>
            sub.setName('config')
               .setDescription('Configure model, permission, and display mode for this thread')
        )
        .addSubcommand(sub =>
            sub.setName('fork')
               .setDescription('Fork this conversation into a new thread')
        )
        .addSubcommand(sub =>
            sub.setName('resume')
               .setDescription('Resume a previous session')
        )
        .addSubcommand(sub =>
            sub.setName('cron')
               .setDescription('List scheduled tasks')
        )
;

    await c.application?.commands.create(command);
    log('Slash commands registered');
    log(`Bot ready: guilds=${c.guilds.cache.size}`);

});

// Handle slash command and button interactions
client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    // Handle autocomplete
    if (interaction.isAutocomplete() && interaction.commandName === 'disclaw') {
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'cd') {
            await handleCdAutocomplete(interaction);
        }
        return;
    }

    // Handle /disclaw slash commands
    if (interaction.isChatInputCommand() && interaction.commandName === 'disclaw') {
        const subcommand = interaction.options.getSubcommand();
        log(`Slash command: /disclaw ${subcommand} user=${interaction.user.tag} channel=${interaction.channelId}`);
        if (subcommand === 'cd') {
            await handleCd(interaction);
        } else if (subcommand === 'clear') {
            await handleClear(interaction);
        } else if (subcommand === 'interrupt') {
            await handleInterrupt(interaction);
        } else if (subcommand === 'config') {
            await handleConfig(interaction);
        } else if (subcommand === 'fork') {
            await handleFork(interaction, client);
        } else if (subcommand === 'resume') {
            await handleResume(interaction);
        } else if (subcommand === 'cron') {
            await handleCron(interaction);
        }
        return;
    }

    // Handle config modal submit
    if (interaction.isModalSubmit() && interaction.customId === 'disclaw_config_modal') {
        await handleConfigSubmit(interaction);
        return;
    }

    // Handle user input interactions (ask/approve: buttons, selects, modals)
    if (await handleUserInputInteraction(interaction)) return;

    // Handle button interactions
    if (interaction.isButton()) {
        // Cron control panel buttons
        if (await handleCronInteraction(interaction)) return;
        // Directory picker buttons
        if (await handleDirPickInteraction(interaction)) return;
        // History pagination buttons
        if (await handleHistoryInteraction(interaction)) return;
        // Tool pager navigation buttons
        if (await handlePagerInteraction(interaction)) return;

        // Unknown button
        log.warn(`Unknown button interaction: customId=${interaction.customId} user=${interaction.user.tag} channel=${interaction.channelId}`);
        await interaction.reply({ content: 'This button has expired.', flags: MessageFlags.Ephemeral });
    }
});

// Handle reactions on pager messages — restore navigation buttons
client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
        // Ignore bot's own reactions (e.g. 👀 eyes indicator)
        if (user.id === client.user?.id) return;
        log.debug(`Reaction received: emoji=${reaction.emoji.name} user=${user.tag} message=${reaction.message.id}`);

        // Partial messages (uncached) won't have author — fetch full message
        const message = reaction.message.partial
            ? await reaction.message.fetch()
            : reaction.message;

        // Only handle reactions on bot's own messages
        if (message.author?.id !== client.user?.id) return;

        const restored = await restorePagerButtons(message.id);
        if (restored) {
            log(`Pager buttons restored via reaction on message=${message.id}`);
        }
    } catch (e) {
        log.error(`Failed to restore pager on reaction: ${e}`);
    }
});

// Handle reaction removal — hide pager buttons when all user reactions are removed
client.on(Events.MessageReactionRemove, async (reaction, user) => {
    try {
        if (user.id === client.user?.id) return;

        const message = reaction.message.partial
            ? await reaction.message.fetch()
            : reaction.message;

        if (message.author?.id !== client.user?.id) return;

        // Check if any non-bot reactions remain
        const hasUserReactions = message.reactions.cache.some(r =>
            r.count > (r.me ? 1 : 0)
        );
        if (hasUserReactions) return;

        const hidden = await hidePagerButtons(message.id);
        if (hidden) {
            log(`Pager buttons hidden via reaction removal on message=${message.id}`);
        }
    } catch (e) {
        log.error(`Failed to hide pager on reaction removal: ${e}`);
    }
});

client.on(Events.MessageCreate, async (message: Message) => {
    // Ignore bots
    if (message.author.bot) return;

    const isMentioned = client.user && message.mentions.has(client.user);
    const isInThread = message.channel.isThread();

    // =========================================================================
    // TRACKED THREAD: Continue existing conversation
    // =========================================================================
    if (isInThread) {
        const thread = message.channel;
        const mapping = getThreadMapping(thread.id);

        if (mapping) {
            log(`Thread message: user=${message.author.tag} thread=${thread.id} messageId=${message.id} sessionId=${mapping.session_id || '(empty)'}`);

            // React with eyes to acknowledge receipt
            addReaction(thread.id, message.id, '👀').catch(() => {});

            // Show typing indicator
            log.debug(`Sending typing indicator: thread=${thread.id}`);
            await thread.sendTyping();

            // For forum threads with empty session (after clear or fresh adoption),
            // include forum post title/body so the agent knows the topic
            const isForumThread = thread.parent?.type === ChannelType.GuildForum || thread.parent?.type === ChannelType.GuildMedia;
            const needsForumContext = isForumThread && !mapping.session_id;

            log.debug(`Building prompt: thread=${thread.id} attachments=${message.attachments.size} forumContext=${needsForumContext}`);
            const multimodalPrompt = await buildPrompt({ message, includeContext: needsForumContext ? 'forum' : false });
            const prompt = multimodalPrompt.type === 'text' ? multimodalPrompt.text : multimodalPrompt;

            // Use stored working dir or fall back to channel config / env / cwd
            const workingDir = resolveWorkingDirWithMapping(mapping.working_dir, thread.parentId || '');

            log.debug(`Thread working dir resolved: ${workingDir} thread=${thread.id}`);

            const parentId = thread.parentId || '';
            log(`Job submitted: thread=${thread.id} user=${message.author.tag} workingDir=${workingDir} model=${mapping.model || 'default'} permissionMode=${mapping.permission_mode || 'default'}`);
            runner.submit({
                prompt,
                threadId: thread.id,
                // resume: undefined — session state resolved lazily at execution time
                // so per-thread queued jobs always get the latest DB state
                userId: message.author.id,
                username: message.author.tag,
                workingDir,
                model: mapping.model || undefined,
                permissionMode: mapping.permission_mode || undefined,
                parentChannelId: parentId || undefined,
                statusMessageId: thread.id,
                sourceMessageId: message.id,
                eyesReaction: { channelId: thread.id, messageId: message.id },
                createMcpServers: parentId
                    ? () => ({ 'disclaw': createDisclawMcpServer(parentId, message.author.id, workingDir, mapping.model || undefined, thread.id) })
                    : undefined,
            });

            return;
        }

        // Untracked thread — only respond if @mentioned (e.g. forum posts)
        if (!isMentioned) {
            log.debug(`Ignoring message in untracked thread: thread=${thread.id} user=${message.author.tag} messageId=${message.id}`);
            return;
        }

        // Fall through to new conversation flow — thread already exists
    }

    // =========================================================================
    // NEW CONVERSATION: @mention required (in channel or untracked thread)
    // =========================================================================
    if (!isMentioned) return;

    // Determine if we're adopting an existing thread or need to create one
    const existingThread = isInThread ? message.channel : null;
    const channelId = existingThread?.parentId || message.channelId;

    log(`New mention: user=${message.author.tag} ${existingThread ? `thread=${existingThread.id}` : `channel=${channelId}`} messageId=${message.id}`);

    // React with eyes to acknowledge receipt
    addReaction(message.channelId, message.id, '👀').catch(() => {});

    // Extract message content and resolve working directory
    const rawText = message.content.replace(/<@!?\d+>/g, '').trim();
    const { workingDir, cleanedMessage, error: workingDirError } = parseWorkingDirFromMessage(rawText, channelId);

    if (workingDirError) {
        log.warn(`Working dir validation failed: user=${message.author.tag} channel=${channelId} error="${workingDirError}"`);
        await message.reply(workingDirError);
        return;
    }

    log(`Working directory resolved: ${workingDir} channel=${channelId}`);

    // Build XML-formatted prompt (include context when adopting existing thread)
    log.debug(`Building prompt: channel=${channelId} attachments=${message.attachments.size} includeContext=${!!existingThread}`);
    const multimodalPrompt = await buildPrompt({
        message,
        overrideText: cleanedMessage,
        includeContext: !!existingThread,
    });
    const prompt = multimodalPrompt.type === 'text' ? multimodalPrompt.text : multimodalPrompt;

    let thread;
    let statusMessageId: string;

    if (existingThread) {
        // Adopt the existing thread (forum post, manually created thread, etc.)
        thread = existingThread;
        statusMessageId = message.id;
    } else {
        // For thread naming, get a plain text summary (not XML)
        const namingPrompt = await extractMessageContent(message, cleanedMessage);
        const displayText = namingPrompt.type === 'text' ? namingPrompt.text : namingPrompt.textSummary;
        try {
            const statusMessage = await (message.channel as TextChannel).send('Processing...');
            const threadName = truncateCodePoints(displayText || 'New conversation', 50);
            thread = await statusMessage.startThread({
                name: threadName,
                autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
            });
            statusMessageId = statusMessage.id;
        } catch (error) {
            log.error(`Failed to create thread: channel=${channelId} user=${message.author.tag} error=${error}`);
            await message.reply('Failed to start thread. Try again?');
            return;
        }
    }

    // For adopted threads, preserve the existing title to prevent auto-title generation
    const preservedTitle = existingThread ? existingThread.name : null;

    db.run(
        'INSERT INTO threads (thread_id, session_id, working_dir, title) VALUES (?, ?, ?, ?)',
        [thread.id, '', workingDir, preservedTitle]
    );

    log(`Thread ${existingThread ? 'adopted' : 'created'}: thread=${thread.id} channel=${channelId} user=${message.author.tag} workingDir=${workingDir}${preservedTitle ? ` title="${preservedTitle}"` : ''}`);

    log.debug(`Sending typing indicator: thread=${thread.id}`);
    await thread.sendTyping();

    log(`Job submitted: thread=${thread.id} user=${message.author.tag} workingDir=${workingDir} resume=false`);
    runner.submit({
        prompt,
        threadId: thread.id,
        resume: false,
        userId: message.author.id,
        username: message.author.tag,
        workingDir,
        parentChannelId: channelId,
        statusMessageId,
        eyesReaction: { channelId: message.channelId, messageId: message.id },
        createMcpServers: () => ({ 'disclaw': createDisclawMcpServer(channelId, message.author.id, workingDir, undefined, thread.id) }),
    });
});

// Start the bot
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
    log.error('DISCORD_BOT_TOKEN required — exiting');
    process.exit(1);
}

log('Bot starting — logging in to Discord...');
client.login(token);

// Graceful shutdown
process.on('SIGINT', async () => {
    log('Shutting down (SIGINT received)...');
    try { getCronScheduler().stopAll(); } catch (e) { log.warn(`Error stopping cron scheduler: ${e}`); }
    log('Draining runner...');
    await runner.drain();
    log('Runner drained, destroying client');
    client.destroy();
    process.exit(0);
});

export { client };
