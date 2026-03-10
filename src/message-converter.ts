/**
 * Message Converter - Transforms SDK messages into normalized ClaudeMessage format
 *
 * Each SDKMessage is converted into one or more ClaudeMessage objects
 * that can be rendered as Discord embeds.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';


export interface ClaudeMessage {
    type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'system' | 'other'
        | 'permission_denied' | 'task_notification' | 'task_started' | 'tool_progress' | 'tool_summary';
    content: string;
    metadata?: Record<string, unknown>;
}

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
            const textContent = content
                .filter(c => c.type === 'text')
                .map(c => c.text ?? '')
                .join('');

            if (textContent) {
                messages.push({ type: 'text', content: textContent });
            }

            // Process tool_use individually
            const toolUseContent = content
                .filter(c => c.type === 'tool_use');

            for (const tool of toolUseContent) {
                messages.push({
                    type: 'tool_use',
                    content: '',
                    metadata: { ...tool as Record<string, unknown>, toolUseId: tool.id }
                });
            }

            // Process thinking content
            const thinkingContent = content
                .filter(c => c.type === 'thinking');

            for (const thinking of thinkingContent) {
                if (thinking.thinking) {
                    messages.push({
                        type: 'thinking',
                        content: thinking.thinking
                    });
                }
            }

            // Process other content
            const otherContent = content
                .filter(c => c.type !== 'text' && c.type !== 'tool_use' && c.type !== 'thinking');

            for (const other of otherContent) {
                messages.push({
                    type: 'other',
                    content: JSON.stringify(other, null, 2),
                    metadata: other as Record<string, unknown>
                });
            }
        }
    } else if (jsonData.type === 'user') {
        const content = jsonData.message?.content;
        if (Array.isArray(content)) {
            const blocks = content as ContentBlock[];

            const toolResults = blocks
                .filter(c => c.type === 'tool_result');

            for (const result of toolResults) {
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
                messages.push({
                    type: 'tool_result',
                    content: resultContent,
                    metadata: { toolUseId: (result as Record<string, unknown>).tool_use_id },
                });
            }

            const otherContent = blocks
                .filter(c => c.type !== 'tool_result');

            for (const other of otherContent) {
                messages.push({
                    type: 'other',
                    content: JSON.stringify(other, null, 2),
                    metadata: other as Record<string, unknown>
                });
            }
        }
    } else if (jsonData.type === 'result') {
        // Surface permission denials
        if (jsonData.permission_denials && jsonData.permission_denials.length > 0) {
            const seenTools = new Set<string>();
            for (const denial of jsonData.permission_denials) {
                if (seenTools.has(denial.tool_name)) continue;
                seenTools.add(denial.tool_name);
                messages.push({
                    type: 'permission_denied',
                    content: `Tool "${denial.tool_name}" was denied by permission mode`,
                    metadata: {
                        toolName: denial.tool_name,
                        toolUseId: denial.tool_use_id,
                        toolInput: denial.tool_input,
                    }
                });
            }
        }
        // Result metadata (cost, duration, etc.)
        messages.push({
            type: 'system',
            content: '',
            metadata: {
                ...jsonData,
                subtype: jsonData.subtype === 'success' ? 'completion' : 'error',
                sdkSubtype: jsonData.subtype,
            }
        });
    } else if (jsonData.type === 'system') {
        if (jsonData.subtype === 'task_notification') {
            const msg = jsonData as SDKMessage & { task_id?: string; status?: string; output_file?: string; summary?: string };
            messages.push({
                type: 'task_notification',
                content: msg.summary || '',
                metadata: {
                    taskId: msg.task_id || '',
                    status: msg.status,
                    outputFile: msg.output_file,
                    summary: msg.summary,
                }
            });
        } else if (jsonData.subtype === 'task_started') {
            const msg = jsonData as SDKMessage & { task_id?: string; description?: string; task_type?: string };
            messages.push({
                type: 'task_started',
                content: msg.description || '',
                metadata: {
                    taskId: msg.task_id || '',
                    description: msg.description,
                    taskType: msg.task_type,
                }
            });
        }
        // Generic system messages
        else {
            messages.push({
                type: 'system',
                content: '',
                metadata: jsonData as unknown as Record<string, unknown>
            });
        }
    } else if (jsonData.type === 'tool_progress') {
        messages.push({
            type: 'tool_progress',
            content: `${jsonData.tool_name}: ${jsonData.elapsed_time_seconds}s`,
            metadata: {
                toolUseId: jsonData.tool_use_id,
                toolName: jsonData.tool_name,
                elapsedSeconds: jsonData.elapsed_time_seconds,
            }
        });
    } else if (jsonData.type === 'tool_use_summary') {
        messages.push({
            type: 'tool_summary',
            content: jsonData.summary || '',
            metadata: {
                summary: jsonData.summary,
                toolUseIds: jsonData.preceding_tool_use_ids,
            }
        });
    }

    return messages;
}
