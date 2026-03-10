/**
 * User Input - Handles approvals and AskUserQuestion via Discord UI
 *
 * Manages pending approval/question requests and Discord interactive components
 * (buttons, select menus, modals) for the canUseTool callback.
 */

import {
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    type ButtonInteraction,
    type StringSelectMenuInteraction,
    type ModalSubmitInteraction,
    type Interaction,
} from 'discord.js';
import { sendRichMessage, editRichMessage, truncateCodePoints, type EmbedData } from './discord.js';
import type { PermissionResult, CanUseTool, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

const log = (msg: string) => process.stdout.write(`[user-input] ${msg}\n`);

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// =========================================================================
// TYPES
// =========================================================================

interface AskUserQuestionOption {
    label: string;
    description?: string;
}

interface AskUserQuestionItem {
    question: string;
    header?: string;
    options: AskUserQuestionOption[];
    multiSelect?: boolean;
}

interface PendingRequest {
    type: 'approval' | 'ask_user';
    threadId: string;
    requestId: string;
    resolve: (result: PermissionResult) => void;
    timeout: Timer;
    // Tool approval specific:
    toolName?: string;
    toolInput?: Record<string, unknown>;
    /** SDK permission suggestions — return as updatedPermissions for "Always Allow" */
    suggestions?: PermissionUpdate[];
    // AskUserQuestion specific:
    questions?: AskUserQuestionItem[];
    /** Currently displayed question index (for navigation) */
    currentIndex?: number;
    answers?: Record<string, string>;
    currentMsgId?: string;
}

// =========================================================================
// STATE
// =========================================================================

const pendingRequests = new Map<string, PendingRequest>();

// =========================================================================
// canUseTool FACTORY
// =========================================================================

/**
 * Create a canUseTool callback bound to a specific thread.
 * Handles both AskUserQuestion and tool approval requests.
 *
 * Note: The SDK evaluates permissions in order: hooks → deny rules → permission mode → allow rules → canUseTool.
 * In bypassPermissions mode, Step 3 auto-approves all tools so this callback is never called
 * (except possibly for AskUserQuestion which the SDK routes here regardless of mode).
 *
 * @param threadId - Discord thread ID
 */
export function createCanUseTool(threadId: string): CanUseTool {
    return async (
        toolName: string,
        input: Record<string, unknown>,
        options?: { suggestions?: PermissionUpdate[]; [key: string]: unknown },
    ): Promise<PermissionResult> => {
        // AskUserQuestion — always handle interactively
        if (toolName === 'AskUserQuestion') {
            return handleAskUserQuestion(threadId, input);
        }

        // Show approval UI in Discord, pass suggestions for "Always Allow"
        return requestToolApproval(threadId, toolName, input, options?.suggestions);
    };
}

// =========================================================================
// ASK USER QUESTION
// =========================================================================

async function handleAskUserQuestion(
    threadId: string,
    input: Record<string, unknown>,
): Promise<PermissionResult> {
    const questions = (input.questions || []) as AskUserQuestionItem[];
    if (questions.length === 0) {
        return { behavior: 'allow', updatedInput: input };
    }

    const requestId = crypto.randomUUID().slice(0, 8);

    return new Promise<PermissionResult>((resolve) => {
        const timeout = setTimeout(() => {
            const req = pendingRequests.get(requestId);
            if (req) {
                pendingRequests.delete(requestId);
                expireRequest(req);
                resolve({ behavior: 'deny', message: 'Timed out waiting for user response.' });
            }
        }, REQUEST_TIMEOUT_MS);

        const request: PendingRequest = {
            type: 'ask_user',
            threadId,
            requestId,
            resolve,
            timeout,
            questions,
            currentIndex: 0,
            answers: {},
        };

        pendingRequests.set(requestId, request);
        sendQuestionUI(request);
    });
}

/**
 * Render the current question in a single message with ◀/▶ navigation and Submit All.
 * Creates a new message on first call, then edits in place for subsequent updates.
 */
async function sendQuestionUI(request: PendingRequest): Promise<void> {
    const { questions, currentIndex, threadId, requestId, answers } = request;
    if (!questions || currentIndex === undefined) return;

    const q = questions[currentIndex];
    if (!q) return;

    const total = questions.length;

    // Progress indicator: ✅ answered, 🔵 current, ⚪ unanswered
    const progress = questions.map((qi, i) => {
        const answered = answers?.[qi.question] !== undefined;
        if (i === currentIndex) return answered ? '🟢' : '🔵';
        return answered ? '✅' : '⚪';
    }).join(' ');

    let description = total > 1 ? `${progress}\n\n` : '';
    if (q.header) description += `**${q.header}**\n`;

    // Show current answer if already answered
    const currentAnswer = answers?.[q.question];
    if (currentAnswer) {
        description += `\n✅ **${truncateCodePoints(currentAnswer, 200)}**`;
    }

    const embed: EmbedData = {
        color: 0x9b59b6, // purple
        title: `❓ ${q.question}`,
        description: description || undefined,
        ...(total > 1 ? { footer: { text: `Question ${currentIndex + 1} of ${total}` } } : {}),
    };

    const components: ActionRowBuilder<any>[] = [];

    if (q.multiSelect) {
        // Multi-select: StringSelectMenu
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`ask:${requestId}:q${currentIndex}:select`)
            .setPlaceholder('Select one or more...')
            .setMinValues(1)
            .setMaxValues(q.options.length)
            .addOptions(
                q.options.map((opt, i) => ({
                    label: truncateCodePoints(opt.label, 100),
                    value: String(i),
                    description: opt.description ? truncateCodePoints(opt.description, 100) : undefined,
                }))
            );
        components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));
    } else {
        // Single-select: one button per option, highlight selected
        const buttonRow = new ActionRowBuilder<ButtonBuilder>();
        for (let i = 0; i < q.options.length && i < 4; i++) {
            const opt = q.options[i]!;
            const label = opt.description
                ? `${opt.label} - ${opt.description}`
                : opt.label;
            const isSelected = currentAnswer === opt.label;
            buttonRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`ask:${requestId}:q${currentIndex}:${i}`)
                    .setLabel(truncateCodePoints(label, 80))
                    .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Primary),
            );
        }
        components.push(buttonRow);
    }

    // Other button
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`ask:${requestId}:q${currentIndex}:other`)
            .setLabel('Other...')
            .setStyle(ButtonStyle.Secondary),
    ));

    // Navigation + Submit row
    const allAnswered = questions.every(qi => answers?.[qi.question] !== undefined);
    const navRow = new ActionRowBuilder<ButtonBuilder>();

    if (total > 1) {
        navRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`ask:${requestId}:nav:prev`)
                .setLabel('◀')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentIndex === 0),
            new ButtonBuilder()
                .setCustomId(`ask:${requestId}:nav:next`)
                .setLabel('▶')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentIndex === total - 1),
        );
    }

    navRow.addComponents(
        new ButtonBuilder()
            .setCustomId(`ask:${requestId}:submit`)
            .setLabel(total > 1 ? 'Submit All' : 'Submit')
            .setStyle(ButtonStyle.Success)
            .setDisabled(!allAnswered),
    );
    components.push(navRow);

    try {
        if (request.currentMsgId) {
            await editRichMessage(threadId, request.currentMsgId, { embeds: [embed], components });
        } else {
            const msgId = await sendRichMessage(threadId, { embeds: [embed], components });
            request.currentMsgId = msgId;
        }
    } catch (err) {
        log(`Failed to send/update question UI: ${err}`);
    }
}

// =========================================================================
// TOOL APPROVAL
// =========================================================================

async function requestToolApproval(
    threadId: string,
    toolName: string,
    input: Record<string, unknown>,
    suggestions?: PermissionUpdate[],
): Promise<PermissionResult> {
    const requestId = crypto.randomUUID().slice(0, 8);

    return new Promise<PermissionResult>((resolve) => {
        const timeout = setTimeout(() => {
            const req = pendingRequests.get(requestId);
            if (req) {
                pendingRequests.delete(requestId);
                expireRequest(req);
                resolve({ behavior: 'deny', message: 'Timed out waiting for approval.' });
            }
        }, REQUEST_TIMEOUT_MS);

        const request: PendingRequest = {
            type: 'approval',
            threadId,
            requestId,
            resolve,
            timeout,
            toolName,
            toolInput: input,
            suggestions,
        };

        pendingRequests.set(requestId, request);
        sendApprovalUI(request);
    });
}

async function sendApprovalUI(request: PendingRequest): Promise<void> {
    const { threadId, requestId, toolName, toolInput } = request;

    // Build input preview
    let preview = '';
    if (toolName === 'Bash') {
        preview = String(toolInput?.command || '');
    } else if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Read') {
        preview = String(toolInput?.file_path || '');
    } else {
        preview = truncateCodePoints(JSON.stringify(toolInput, null, 2), 500);
    }

    const embed: EmbedData = {
        color: 0xffaa00, // orange
        title: `🔐 Approve \`${toolName}\`?`,
        description: preview ? `\`\`\`\n${truncateCodePoints(preview, 1000)}\n\`\`\`` : undefined,
    };

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`approve:${requestId}:allow`)
            .setLabel('Allow')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`approve:${requestId}:deny`)
            .setLabel('Deny')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`approve:${requestId}:always`)
            .setLabel('Always Allow')
            .setStyle(ButtonStyle.Primary),
    );

    try {
        const msgId = await sendRichMessage(threadId, { embeds: [embed], components: [row] });
        request.currentMsgId = msgId;
    } catch (err) {
        log(`Failed to send approval UI: ${err}`);
    }
}

// =========================================================================
// INTERACTION HANDLER
// =========================================================================

/**
 * Handle button/select/modal interactions for user input.
 * Returns true if the interaction was handled, false otherwise.
 */
export async function handleUserInputInteraction(interaction: Interaction): Promise<boolean> {
    // Button interactions
    if (interaction.isButton()) {
        const customId = interaction.customId;

        if (customId.startsWith('ask:')) {
            return handleAskButton(interaction as ButtonInteraction);
        }
        if (customId.startsWith('approve:')) {
            return handleApproveButton(interaction as ButtonInteraction);
        }
    }

    // String select menu interactions
    if (interaction.isStringSelectMenu()) {
        const customId = interaction.customId;
        if (customId.startsWith('ask:')) {
            return handleAskSelect(interaction as StringSelectMenuInteraction);
        }
    }

    // Modal submissions
    if (interaction.isModalSubmit()) {
        const customId = interaction.customId;
        if (customId.startsWith('ask:') || customId.startsWith('approve:')) {
            return handleModalSubmit(interaction as ModalSubmitInteraction);
        }
    }

    return false;
}

// ---- Ask: Button ----

async function handleAskButton(interaction: ButtonInteraction): Promise<boolean> {
    const parts = interaction.customId.split(':');
    if (parts.length < 3) return false;

    const requestId = parts[1]!;
    const request = pendingRequests.get(requestId);

    if (!request || request.type !== 'ask_user') {
        await interaction.reply({ content: 'This question has expired.', ephemeral: true });
        return true;
    }

    const segment = parts[2]!;

    // ---- Navigation: ask:{requestId}:nav:{prev|next} ----
    if (segment === 'nav') {
        const dir = parts[3];
        if (dir === 'prev' && request.currentIndex! > 0) {
            request.currentIndex!--;
        } else if (dir === 'next' && request.currentIndex! < request.questions!.length - 1) {
            request.currentIndex!++;
        }
        await interaction.deferUpdate();
        await sendQuestionUI(request);
        return true;
    }

    // ---- Submit All: ask:{requestId}:submit ----
    if (segment === 'submit') {
        const allAnswered = request.questions!.every(q => request.answers![q.question] !== undefined);
        if (!allAnswered) {
            await interaction.reply({ content: 'Please answer all questions first.', ephemeral: true });
            return true;
        }
        pendingRequests.delete(requestId);
        clearTimeout(request.timeout);
        await interaction.deferUpdate();
        await disableComponents(request, `Answered ${request.questions!.length} question(s)`);
        request.resolve({
            behavior: 'allow',
            updatedInput: {
                questions: request.questions,
                answers: request.answers,
            },
        });
        return true;
    }

    // ---- Question-specific: ask:{requestId}:q{idx}:{action} ----
    if (!segment.startsWith('q') || parts.length < 4) return false;
    const action = parts[3]!;
    const q = request.questions?.[request.currentIndex!];
    if (!q) return false;

    if (action === 'other') {
        // Show modal for free text input
        const modal = new ModalBuilder()
            .setCustomId(`ask:${requestId}:q${request.currentIndex}:modal`)
            .setTitle(truncateCodePoints(q.question, 45));

        const textInput = new TextInputBuilder()
            .setCustomId('answer')
            .setLabel(truncateCodePoints(q.header || 'Your answer', 45))
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(textInput));
        await interaction.showModal(modal);
        return true;
    }

    // Single-select: store answer and re-render
    const optIndex = parseInt(action, 10);
    if (isNaN(optIndex) || !q.options[optIndex]) return false;

    request.answers![q.question] = q.options[optIndex]!.label;
    await interaction.deferUpdate();
    await sendQuestionUI(request);
    return true;
}

// ---- Ask: Select Menu ----

async function handleAskSelect(interaction: StringSelectMenuInteraction): Promise<boolean> {
    const parts = interaction.customId.split(':');
    if (parts.length < 4) return false;

    const requestId = parts[1]!;
    const request = pendingRequests.get(requestId);

    if (!request || request.type !== 'ask_user') {
        await interaction.reply({ content: 'This question has expired.', ephemeral: true });
        return true;
    }

    const q = request.questions?.[request.currentIndex!];
    if (!q) return false;

    // Store selected labels as answer directly
    const selectedLabels = interaction.values
        .map(v => q.options[parseInt(v, 10)]?.label)
        .filter(Boolean) as string[];

    request.answers![q.question] = selectedLabels.join(', ');

    await interaction.deferUpdate();
    await sendQuestionUI(request);
    return true;
}

// ---- Approve: Button ----

async function handleApproveButton(interaction: ButtonInteraction): Promise<boolean> {
    const parts = interaction.customId.split(':');
    // approve:{requestId}:{action}
    if (parts.length < 3) return false;

    const requestId = parts[1]!;
    const action = parts[2]!;
    const request = pendingRequests.get(requestId);

    if (!request || request.type !== 'approval') {
        await interaction.reply({ content: 'This approval has expired.', ephemeral: true });
        return true;
    }

    if (action === 'allow') {
        pendingRequests.delete(requestId);
        clearTimeout(request.timeout);
        await interaction.deferUpdate();
        await disableComponents(request, `Allowed by ${interaction.user.tag}`);
        request.resolve({ behavior: 'allow', updatedInput: request.toolInput });
        return true;
    }

    if (action === 'always') {
        pendingRequests.delete(requestId);
        clearTimeout(request.timeout);

        await interaction.deferUpdate();
        await disableComponents(request, `Always allowed \`${request.toolName}\` by ${interaction.user.tag}`);
        // Return SDK suggestions as updatedPermissions so SDK stops prompting
        request.resolve({
            behavior: 'allow',
            updatedInput: request.toolInput,
            ...(request.suggestions?.length ? { updatedPermissions: request.suggestions } : {}),
        });
        return true;
    }

    if (action === 'deny') {
        // Show modal for deny reason
        const modal = new ModalBuilder()
            .setCustomId(`approve:${requestId}:deny:modal`)
            .setTitle('Deny reason');

        const textInput = new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Why deny this tool? (optional)')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false);

        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(textInput));
        await interaction.showModal(modal);
        return true;
    }

    return false;
}

// ---- Modal Submit ----

async function handleModalSubmit(interaction: ModalSubmitInteraction): Promise<boolean> {
    const customId = interaction.customId;

    // AskUserQuestion "Other..." modal
    if (customId.startsWith('ask:')) {
        const parts = customId.split(':');
        const requestId = parts[1]!;
        const request = pendingRequests.get(requestId);

        if (!request || request.type !== 'ask_user') {
            await interaction.reply({ content: 'This question has expired.', ephemeral: true });
            return true;
        }

        const q = request.questions?.[request.currentIndex!];
        if (!q) return false;

        const answer = interaction.fields.getTextInputValue('answer');
        request.answers![q.question] = answer;
        await interaction.deferUpdate();
        await sendQuestionUI(request);
        return true;
    }

    // Tool approval deny modal
    if (customId.startsWith('approve:')) {
        const parts = customId.split(':');
        const requestId = parts[1]!;
        const request = pendingRequests.get(requestId);

        if (!request || request.type !== 'approval') {
            await interaction.reply({ content: 'This approval has expired.', ephemeral: true });
            return true;
        }

        pendingRequests.delete(requestId);
        clearTimeout(request.timeout);

        const reason = interaction.fields.getTextInputValue('reason') || 'User denied this action';
        await interaction.deferUpdate();
        await disableComponents(request, `Denied by ${interaction.user.tag}: ${reason}`);
        request.resolve({ behavior: 'deny', message: reason });
        return true;
    }

    return false;
}

// =========================================================================
// HELPERS
// =========================================================================

async function disableComponents(request: PendingRequest, footerText: string): Promise<void> {
    if (!request.currentMsgId) return;
    try {
        await editRichMessage(request.threadId, request.currentMsgId, {
            components: [],
            embeds: [{
                color: 0x888888,
                description: footerText,
            }],
        });
    } catch (err) {
        log(`Failed to disable components: ${err}`);
    }
}

async function expireRequest(request: PendingRequest): Promise<void> {
    if (request.currentMsgId) {
        try {
            await editRichMessage(request.threadId, request.currentMsgId, {
                components: [],
                embeds: [{
                    color: 0x888888,
                    description: '(timed out)',
                }],
            });
        } catch (err) {
            log(`Failed to expire request UI: ${err}`);
        }
    }
}

/**
 * Cleanup all pending requests for a thread (on interrupt/session end).
 */
export function cleanupThread(threadId: string): void {
    for (const [requestId, request] of pendingRequests) {
        if (request.threadId === threadId) {
            clearTimeout(request.timeout);
            pendingRequests.delete(requestId);
            request.resolve({ behavior: 'deny', message: 'Session ended.' });
        }
    }
}

