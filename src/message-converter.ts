/**
 * Message Converter - Transforms SDK messages into normalized ClaudeMessage format
 *
 * Each SDKMessage is converted into one or more ClaudeMessage objects
 * that can be rendered as Discord embeds.
 *
 * ClaudeMessage is a discriminated union on `type` — switching on `msg.type`
 * narrows to the correct variant with typed fields (no Record<string, unknown>).
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from './logger.js';

const log = createLogger('msg-converter');

// =========================================================================
// ClaudeMessage discriminated union
// =========================================================================

interface TextMessage { type: 'text'; content: string }
interface ThinkingMessage { type: 'thinking'; content: string }
interface OtherMessage { type: 'other'; content: string }

interface ToolUseMessage {
    type: 'tool_use';
    content: string;
    name: string;
    toolUseId?: string;
    input: Record<string, unknown>;
}

interface ToolResultMessage {
    type: 'tool_result';
    content: string;
    toolUseId?: string;
}

/**
 * System messages are polymorphic by `subtype` (new_session, completion, init, etc.).
 * The `metadata` bag holds subtype-specific fields that vary too much to enumerate.
 */
interface SystemMessage {
    type: 'system';
    content: string;
    subtype: string;
    metadata: Record<string, unknown>;
}

interface PermissionDeniedMessage {
    type: 'permission_denied';
    content: string;
    toolName: string;
    toolUseId?: string;
    toolInput: Record<string, unknown>;
}

export interface TaskUsage {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
}

interface TaskStartedMessage {
    type: 'task_started';
    content: string;
    taskId: string;
    /** tool_use_id of the Agent tool call that spawned this task */
    toolUseId?: string;
    taskType?: string;
    prompt?: string;
}

interface TaskNotificationMessage {
    type: 'task_notification';
    content: string;
    taskId: string;
    toolUseId?: string;
    status: string;
    summary?: string;
    outputFile?: string;
    usage?: TaskUsage;
}

interface TaskProgressMessage {
    type: 'task_progress';
    content: string;
    taskId: string;
    toolUseId?: string;
    lastToolName?: string;
    summary?: string;
    usage?: TaskUsage;
}

interface ToolProgressMessage {
    type: 'tool_progress';
    content: string;
    toolUseId?: string;
    toolName: string;
    elapsedSeconds: number;
}

interface ToolSummaryMessage {
    type: 'tool_summary';
    content: string;
    toolUseIds?: string[];
}

export type ClaudeMessage =
    | TextMessage
    | ThinkingMessage
    | OtherMessage
    | ToolUseMessage
    | ToolResultMessage
    | SystemMessage
    | PermissionDeniedMessage
    | TaskStartedMessage
    | TaskNotificationMessage
    | TaskProgressMessage
    | ToolProgressMessage
    | ToolSummaryMessage;

/** Extract the variant for a given type literal */
export type ClaudeMessageOf<T extends ClaudeMessage['type']> = Extract<ClaudeMessage, { type: T }>;

// =========================================================================
// Converter
// =========================================================================

interface ContentBlock {
    type: string;
    text?: string;
    thinking?: string;
    content?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    [key: string]: unknown;
}

export function convertToClaudeMessages(jsonData: SDKMessage): ClaudeMessage[] {
    const messages: ClaudeMessage[] = [];

    if (jsonData.type === 'assistant') {
        const content = jsonData.message?.content as ContentBlock[] | undefined;
        if (content) {
            log.debug(`Assistant message: ${content.length} content blocks (types: ${content.map(c => c.type).join(', ')})`);
            const textContent = content
                .filter(c => c.type === 'text')
                .map(c => c.text ?? '')
                .join('');

            if (textContent) {
                log.debug(`Assistant text: ${textContent.length} chars`);
                messages.push({ type: 'text', content: textContent });
            }

            for (const tool of content.filter(c => c.type === 'tool_use')) {
                log.debug(`Tool use: ${tool.name} (id=${tool.id})`);
                messages.push({
                    type: 'tool_use',
                    content: '',
                    name: tool.name || 'Unknown',
                    toolUseId: tool.id,
                    input: (tool.input ?? {}) as Record<string, unknown>,
                });
            }

            for (const thinking of content.filter(c => c.type === 'thinking')) {
                if (thinking.thinking) {
                    log.debug(`Thinking block: ${thinking.thinking.length} chars`);
                    messages.push({ type: 'thinking', content: thinking.thinking });
                }
            }

            for (const other of content.filter(c => c.type !== 'text' && c.type !== 'tool_use' && c.type !== 'thinking')) {
                log.debug(`Other assistant content block: type=${other.type}`);
                messages.push({ type: 'other', content: JSON.stringify(other, null, 2) });
            }
        } else {
            log.debug('Assistant message with no content blocks');
        }
    } else if (jsonData.type === 'user') {
        const content = jsonData.message?.content;
        if (Array.isArray(content)) {
            const blocks = content as ContentBlock[];
            log.debug(`User message: ${blocks.length} content blocks (types: ${blocks.map(c => c.type).join(', ')})`);

            for (const result of blocks.filter(c => c.type === 'tool_result')) {
                // content may be a string or MCP-style array [{type:'text', text:'...'}]
                let resultContent: string;
                if (typeof result.content === 'string') {
                    resultContent = result.content;
                } else if (Array.isArray(result.content)) {
                    resultContent = (result.content as Array<{ type?: string; text?: string }>)
                        .map(c => c.text ?? JSON.stringify(c))
                        .join('\n');
                } else {
                    resultContent = JSON.stringify(result, null, 2);
                }
                const toolUseId = (result as Record<string, unknown>).tool_use_id as string | undefined;
                log.debug(`Tool result for toolUseId=${toolUseId}: ${resultContent.length} chars`);
                messages.push({ type: 'tool_result', content: resultContent, toolUseId });
            }

            for (const other of blocks.filter(c => c.type !== 'tool_result')) {
                log.debug(`Other user content block: type=${other.type}`);
                messages.push({ type: 'other', content: JSON.stringify(other, null, 2) });
            }
        }
    } else if (jsonData.type === 'result') {
        // Surface permission denials
        if (jsonData.permission_denials && jsonData.permission_denials.length > 0) {
            log.warn(`Result has ${jsonData.permission_denials.length} permission denials`);
            const seenTools = new Set<string>();
            for (const denial of jsonData.permission_denials) {
                if (seenTools.has(denial.tool_name)) continue;
                seenTools.add(denial.tool_name);
                log.warn(`Permission denied for tool "${denial.tool_name}" (toolUseId=${denial.tool_use_id})`);
                messages.push({
                    type: 'permission_denied',
                    content: `Tool "${denial.tool_name}" was denied by permission mode`,
                    toolName: denial.tool_name,
                    toolUseId: denial.tool_use_id,
                    toolInput: denial.tool_input as Record<string, unknown>,
                });
            }
        }
        // Result metadata (cost, duration, etc.)
        log(`Result message: subtype=${jsonData.subtype}`);
        messages.push({
            type: 'system',
            content: '',
            subtype: jsonData.subtype === 'success' ? 'completion' : 'error',
            metadata: {
                ...jsonData as unknown as Record<string, unknown>,
                sdkSubtype: jsonData.subtype,
            },
        });
    } else if (jsonData.type === 'system') {
        log.debug(`System message: subtype=${jsonData.subtype}`);
        if (jsonData.subtype === 'task_notification') {
            const msg = jsonData as SDKMessage & {
                task_id?: string; tool_use_id?: string; status?: string;
                output_file?: string; summary?: string; usage?: TaskUsage;
            };
            log(`Task notification: taskId=${msg.task_id}, toolUseId=${msg.tool_use_id}, status=${msg.status}`);
            messages.push({
                type: 'task_notification',
                content: msg.summary || '',
                taskId: msg.task_id || '',
                toolUseId: msg.tool_use_id,
                status: msg.status || 'unknown',
                summary: msg.summary,
                outputFile: msg.output_file,
                usage: msg.usage,
            });
        } else if (jsonData.subtype === 'task_started') {
            const msg = jsonData as SDKMessage & {
                task_id?: string; tool_use_id?: string; description?: string;
                task_type?: string; prompt?: string;
            };
            log(`Task started: taskId=${msg.task_id}, toolUseId=${msg.tool_use_id}, type=${msg.task_type}`);
            messages.push({
                type: 'task_started',
                content: msg.description || '',
                taskId: msg.task_id || '',
                toolUseId: msg.tool_use_id,
                taskType: msg.task_type,
                prompt: msg.prompt,
            });
        } else if (jsonData.subtype === 'task_progress') {
            const msg = jsonData as SDKMessage & {
                task_id?: string; tool_use_id?: string; description?: string;
                last_tool_name?: string; summary?: string; usage?: TaskUsage;
            };
            log(`Task progress: taskId=${msg.task_id}, toolUseId=${msg.tool_use_id}, lastTool=${msg.last_tool_name}`);
            messages.push({
                type: 'task_progress',
                content: msg.summary || msg.description || '',
                taskId: msg.task_id || '',
                toolUseId: msg.tool_use_id,
                lastToolName: msg.last_tool_name,
                summary: msg.summary,
                usage: msg.usage,
            });
        }
        // Generic system messages
        else {
            messages.push({
                type: 'system',
                content: '',
                subtype: jsonData.subtype || '',
                metadata: jsonData as unknown as Record<string, unknown>,
            });
        }
    } else if (jsonData.type === 'tool_progress') {
        log.debug(`Tool progress: ${jsonData.tool_name} (${jsonData.elapsed_time_seconds}s, toolUseId=${jsonData.tool_use_id})`);
        messages.push({
            type: 'tool_progress',
            content: `${jsonData.tool_name}: ${jsonData.elapsed_time_seconds}s`,
            toolUseId: jsonData.tool_use_id,
            toolName: jsonData.tool_name,
            elapsedSeconds: jsonData.elapsed_time_seconds,
        });
    } else if (jsonData.type === 'tool_use_summary') {
        log.debug(`Tool summary: ${(jsonData.summary || '').slice(0, 100)}... (${jsonData.preceding_tool_use_ids?.length ?? 0} tool uses)`);
        messages.push({
            type: 'tool_summary',
            content: jsonData.summary || '',
            toolUseIds: jsonData.preceding_tool_use_ids,
        });
    } else {
        log.warn(`Unknown SDK message type: ${jsonData.type}`);
    }

    if (messages.length > 0) {
        log.debug(`Converted SDK ${jsonData.type} → ${messages.length} ClaudeMessage(s) (types: ${messages.map(m => m.type).join(', ')})`);
    }

    return messages;
}
