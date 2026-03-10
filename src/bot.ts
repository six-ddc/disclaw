/**
 * Discord Bot - Catches @mentions, creates threads, runs Claude jobs
 *
 * This is the entry point for the Discord → Claude bridge.
 * Event routing only — command handlers live in interactions.ts.
 */

import {
    Client,
    GatewayIntentBits,
    Events,
    Message,
    MessageFlags,
    TextChannel,
    ThreadAutoArchiveDuration,
    SlashCommandBuilder,
    type Interaction,
} from 'discord.js';
import { homedir } from 'os';
import { resolve } from 'path';
import { runner } from './runner.js';
import { db, getChannelConfigCached, getThreadMapping } from './db.js';
import { truncateCodePoints, initDiscord } from './discord.js';
import {
    handleConfig,
    handleClear,
    handleInterrupt,
    handleModel,
    handleFork,
    handleResume,
    handleCron,
    handlePermission,
    validateWorkingDir,
} from './interactions.js';
import { handleDirPickInteraction } from './dir-picker.js';
import { handleHistoryInteraction } from './history.js';
import { initCronScheduler, createCronMcpServer, getCronScheduler } from './cron.js';
import { handleCronInteraction } from './cron-buttons.js';
import { handleUserInputInteraction } from './user-input.js';
import { extractMessageContent } from './attachment-handler.js';

// Force unbuffered logging
const log = (msg: string) => process.stdout.write(`[bot] ${msg}\n`);

// Helper function to resolve working directory from message or channel config
function resolveWorkingDir(message: string, channelId: string): { workingDir: string; cleanedMessage: string; error?: string } {
    // Check for [/path] prefix override
    const pathMatch = message.match(/^\[([^\]]+)\]\s*/);
    if (pathMatch && pathMatch[1]) {
        let dir = pathMatch[1];
        if (dir.startsWith('~')) {
            dir = dir.replace('~', homedir());
        }
        const validationError = validateWorkingDir(dir);
        if (validationError) {
            return {
                workingDir: '',
                cleanedMessage: message.slice(pathMatch[0].length),
                error: validationError
            };
        }
        return {
            workingDir: resolve(dir),
            cleanedMessage: message.slice(pathMatch[0].length)
        };
    }

    // Check channel config (cached)
    const channelConfig = getChannelConfigCached(channelId);
    if (channelConfig?.working_dir) {
        return { workingDir: channelConfig.working_dir, cleanedMessage: message };
    }

    // Fall back to env or cwd
    return {
        workingDir: process.env.CLAUDE_WORKING_DIR || process.cwd(),
        cleanedMessage: message
    };
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
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
            sub.setName('config')
               .setDescription('Configure working directory (channel default or thread override)')
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
            sub.setName('model')
               .setDescription('Switch Claude model for this thread')
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
        .addSubcommand(sub =>
            sub.setName('permission')
               .setDescription('Set permission mode for this thread')
        );

    await c.application?.commands.create(command);
    log('Slash commands registered');

});

// Handle slash command and button interactions
client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    // Handle /disclaw slash commands
    if (interaction.isChatInputCommand() && interaction.commandName === 'disclaw') {
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'config') {
            await handleConfig(interaction);
        } else if (subcommand === 'clear') {
            await handleClear(interaction);
        } else if (subcommand === 'interrupt') {
            await handleInterrupt(interaction);
        } else if (subcommand === 'model') {
            await handleModel(interaction);
        } else if (subcommand === 'fork') {
            await handleFork(interaction, client);
        } else if (subcommand === 'resume') {
            await handleResume(interaction);
        } else if (subcommand === 'cron') {
            await handleCron(interaction);
        } else if (subcommand === 'permission') {
            await handlePermission(interaction);
        }
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

        // Unknown button
        await interaction.reply({ content: 'This button has expired.', flags: MessageFlags.Ephemeral });
    }
});

client.on(Events.MessageCreate, async (message: Message) => {
    // Ignore bots
    if (message.author.bot) return;

    const isMentioned = client.user && message.mentions.has(client.user);
    const isInThread = message.channel.isThread();

    // =========================================================================
    // THREAD MESSAGES: Continue existing conversations
    // =========================================================================
    if (isInThread) {
        const thread = message.channel;

        // Look up session ID, working dir, and model for this thread
        const mapping = getThreadMapping(thread.id);

        if (!mapping) {
            // Not a thread we created, ignore
            return;
        }

        log(`Thread message from ${message.author.tag}`);

        // Show typing indicator
        await thread.sendTyping();

        // Extract multimodal content (images, files, replies)
        const multimodalPrompt = await extractMessageContent(message);
        const prompt = multimodalPrompt.type === 'text' ? multimodalPrompt.text : multimodalPrompt;

        // Use stored working dir or fall back to channel config / env / cwd
        const workingDir = resolve(mapping.working_dir ||
            getChannelConfigCached(thread.parentId || '')?.working_dir ||
            process.env.CLAUDE_WORKING_DIR ||
            process.cwd());

        const parentId = thread.parentId || '';
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
            createMcpServers: parentId
                ? () => ({ 'disclaw': createCronMcpServer(parentId, message.author.id, workingDir, mapping.model || undefined, thread.id) })
                : undefined,
        });

        return;
    }

    // =========================================================================
    // NEW MENTIONS: Start new conversations
    // =========================================================================
    if (!isMentioned) return;

    log(`New mention from ${message.author.tag}`);

    // Extract message content and resolve working directory
    const rawText = message.content.replace(/<@!?\d+>/g, '').trim();
    const { workingDir, cleanedMessage, error: workingDirError } = resolveWorkingDir(rawText, message.channelId);

    // If path override validation failed, reply with error
    if (workingDirError) {
        await message.reply(workingDirError);
        return;
    }

    log(`Working directory: ${workingDir}`);

    // Extract multimodal content (images, files, replies) using the cleaned text
    const multimodalPrompt = await extractMessageContent(message, cleanedMessage);
    const prompt = multimodalPrompt.type === 'text' ? multimodalPrompt.text : multimodalPrompt;
    const displayText = multimodalPrompt.type === 'text' ? multimodalPrompt.text : multimodalPrompt.textSummary;

    // Post status message in channel, then create thread from it
    let statusMessage;
    let thread;
    try {
        statusMessage = await (message.channel as TextChannel).send('Processing...');

        const threadName = truncateCodePoints(displayText || 'New conversation', 50);

        thread = await statusMessage.startThread({
            name: threadName,
            autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        });

        const originalMessages = await message.channel.messages.fetch({ limit: 10 });
        const userMessage = originalMessages.find(m => m.id === message.id);
        if (userMessage) {
            await thread.send(`**${message.author.tag}:** ${cleanedMessage}`);
        }
    } catch (error) {
        log(`Failed to create thread: ${error}`);
        await message.reply('Failed to start thread. Try again?');
        return;
    }

    db.run(
        'INSERT INTO threads (thread_id, session_id, working_dir) VALUES (?, ?, ?)',
        [thread.id, '', workingDir]
    );

    log(`Created thread ${thread.id}`);

    await thread.sendTyping();

    runner.submit({
        prompt,
        threadId: thread.id,
        resume: false,
        userId: message.author.id,
        username: message.author.tag,
        workingDir,
        parentChannelId: message.channelId,
        statusMessageId: statusMessage.id,
        createMcpServers: () => ({ 'disclaw': createCronMcpServer(message.channelId, message.author.id, workingDir, undefined, thread.id) }),
    });
});

// Start the bot
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
    console.error('DISCORD_BOT_TOKEN required');
    process.exit(1);
}

client.login(token);

// Graceful shutdown
process.on('SIGINT', async () => {
    log('Shutting down...');
    try { getCronScheduler().stopAll(); } catch {}
    await runner.drain();
    client.destroy();
    process.exit(0);
});

export { client };
