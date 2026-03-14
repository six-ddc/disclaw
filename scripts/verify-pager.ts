/**
 * Verify pager logic against real session data.
 *
 * Usage: bun scripts/verify-pager.ts [sessionId] [workingDir]
 *
 * Tests:
 * 1. Phase 1 vs Phase 2 consistency (offset/limit slicing)
 * 2. Navigation simulation (button clicks)
 * 3. Auto-upgrade fallback (Phase 1 state lost → Phase 2 with offset=0, limit=0)
 * 4. Session growth resilience (new messages added after finalization)
 */

import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { cleanContent } from '../src/tool-embeds.js';

// =========================================================================
// Copy of pager helper functions (to test in isolation)
// =========================================================================

type PageKind = 'tool' | 'thinking' | 'text';
interface PagerPage {
    kind: PageKind;
    label: string;
    content: string;
    result?: string;
    status: 'running' | 'done';
}

function formatToolName(name: string): string {
    if (name.startsWith('mcp__')) {
        return name.slice(5).split('__').join('/');
    }
    return name;
}

function truncatePreview(content: string, maxLines = 10, maxChars = 800): string {
    const lines = content.split('\n');
    const truncated = lines.slice(0, maxLines).join('\n');
    const result = [...truncated].length > maxChars
        ? truncated.slice(0, maxChars) + '…'
        : truncated;
    const remaining = lines.length - maxLines;
    return remaining > 0 ? `${result}\n(+${remaining} more lines)` : result;
}

function parseSessionPages(rawMessages: Array<{ type: string; message: unknown }>): PagerPage[] {
    const pages: PagerPage[] = [];
    const toolUseIdToPage = new Map<string, number>();

    for (const raw of rawMessages) {
        const msg = raw.message as Record<string, unknown>;
        const content = msg.content;

        if (typeof content === 'string') continue;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
            if (!block || typeof block !== 'object') continue;

            if (block.type === 'thinking' && block.thinking) {
                pages.push({
                    kind: 'thinking',
                    label: 'Thinking',
                    content: truncatePreview(String(block.thinking), 20, 3500),
                    status: 'done',
                });
            } else if (block.type === 'text' && block.text && raw.type === 'assistant') {
                const text = String(block.text).trim();
                if (text) {
                    pages.push({
                        kind: 'text',
                        label: 'Assistant',
                        content: truncatePreview(text, 20, 3500),
                        status: 'done',
                    });
                }
            } else if (block.type === 'tool_use') {
                const inputStr = block.input ? JSON.stringify(block.input, null, 2) : '';
                const pageIdx = pages.length;
                pages.push({
                    kind: 'tool',
                    label: formatToolName(block.name || 'Unknown'),
                    content: truncatePreview(inputStr, 8, 600),
                    status: 'done',
                });
                if (block.id) {
                    toolUseIdToPage.set(block.id, pageIdx);
                }
            } else if (block.type === 'tool_result') {
                const pageIdx = block.tool_use_id ? toolUseIdToPage.get(block.tool_use_id) : undefined;
                if (pageIdx !== undefined) {
                    let resultText = '';
                    if (typeof block.content === 'string') {
                        resultText = block.content;
                    } else if (Array.isArray(block.content)) {
                        resultText = block.content
                            .filter((b: Record<string, unknown>) => b.type === 'text')
                            .map((b: Record<string, unknown>) => b.text)
                            .join('\n');
                    }
                    resultText = cleanContent(resultText);
                    if (resultText) {
                        pages[pageIdx]!.result = truncatePreview(resultText);
                    }
                }
            }
        }
    }

    return pages;
}

// =========================================================================
// Main verification
// =========================================================================

const sessionId = process.argv[2] || '5da8f4f0-f426-489c-827b-a984ab702f97';
const workingDir = process.argv[3] || '/data/code/cord';

let totalTests = 0;
let passedTests = 0;

function test(name: string, pass: boolean, detail?: string) {
    totalTests++;
    if (pass) {
        passedTests++;
        console.log(`  ✅ ${name}`);
    } else {
        console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

console.log(`\n=== Pager Verification ===`);
console.log(`Session: ${sessionId}`);
console.log(`Working Dir: ${workingDir}\n`);

// Step 1: Fetch all messages
const allMessages = await getSessionMessages(sessionId, { dir: workingDir });
const typedMessages = allMessages as Array<{ type: string; uuid: string; message: unknown }>;

console.log(`Total messages: ${typedMessages.length}`);
console.log(`Types: ${JSON.stringify(typedMessages.reduce((acc, m) => {
    acc[m.type] = (acc[m.type] || 0) + 1;
    return acc;
}, {} as Record<string, number>))}\n`);

// Step 2: Detect rounds (user text messages that start new turns)
const roundStarts: number[] = [];
for (let i = 0; i < typedMessages.length; i++) {
    const m = typedMessages[i]!;
    if (m.type === 'user') {
        const msg = m.message as Record<string, unknown>;
        const content = msg.content;
        if (typeof content === 'string') {
            roundStarts.push(i);
        } else if (Array.isArray(content)) {
            const hasOnlyToolResult = (content as Array<Record<string, unknown>>).every(b => b.type === 'tool_result');
            if (!hasOnlyToolResult) {
                roundStarts.push(i);
            }
        }
    }
}

console.log(`Detected ${roundStarts.length} rounds\n`);

// =========================================================================
// Test 1: Phase 1 vs Phase 2 consistency for each round
// =========================================================================
console.log(`--- Test 1: Phase 1 vs Phase 2 consistency ---`);

for (let r = Math.max(0, roundStarts.length - 3); r < roundStarts.length; r++) {
    const roundStart = roundStarts[r]!;

    // Find first assistant UUID in this round (what trackRawMessage captures)
    let firstAssistantUuid: string | null = null;
    const roundEnd = r + 1 < roundStarts.length ? roundStarts[r + 1]! : typedMessages.length;
    for (let i = roundStart; i < roundEnd; i++) {
        if (typedMessages[i]!.type === 'assistant' && typedMessages[i]!.uuid) {
            firstAssistantUuid = typedMessages[i]!.uuid;
            break;
        }
    }

    if (!firstAssistantUuid) continue;

    // Compute offset/limit (same as destroy())
    const idx = typedMessages.findIndex(m => m.uuid === firstAssistantUuid);
    let msgOffset = 0;
    if (idx >= 0) {
        msgOffset = idx > 0 && typedMessages[idx - 1]!.type === 'user' ? idx - 1 : idx;
    }
    const msgLimit = typedMessages.length - msgOffset;

    // Phase 1: in-memory slice
    const phase1Pages = parseSessionPages(typedMessages.slice(msgOffset));

    // Phase 2: SDK offset/limit fetch
    const phase2Messages = await getSessionMessages(sessionId, {
        dir: workingDir,
        ...(msgOffset > 0 ? { offset: msgOffset } : {}),
        ...(msgLimit > 0 ? { limit: msgLimit } : {}),
    });
    const phase2Pages = parseSessionPages(phase2Messages as Array<{ type: string; message: unknown }>);

    const match = phase1Pages.length === phase2Pages.length
        && phase1Pages.every((p, i) => p.kind === phase2Pages[i]!.kind && p.label === phase2Pages[i]!.label);

    test(`Round ${r + 1} (offset=${msgOffset}, limit=${msgLimit}): ${phase1Pages.length} pages`,
        match,
        match ? undefined : `Phase1=${phase1Pages.length} vs Phase2=${phase2Pages.length}`);
}

// =========================================================================
// Test 2: Navigation simulation (Phase 2 button clicks)
// =========================================================================
console.log(`\n--- Test 2: Navigation simulation ---`);

// Use the last round for nav testing
const lastRoundStart = roundStarts[roundStarts.length - 1]!;
let lastFirstAssistantUuid: string | null = null;
for (let i = lastRoundStart; i < typedMessages.length; i++) {
    if (typedMessages[i]!.type === 'assistant' && typedMessages[i]!.uuid) {
        lastFirstAssistantUuid = typedMessages[i]!.uuid;
        break;
    }
}

if (lastFirstAssistantUuid) {
    const idx = typedMessages.findIndex(m => m.uuid === lastFirstAssistantUuid);
    const msgOffset = idx > 0 && typedMessages[idx - 1]!.type === 'user' ? idx - 1 : idx;
    const msgLimit = typedMessages.length - msgOffset;

    const baseMessages = await getSessionMessages(sessionId, {
        dir: workingDir,
        ...(msgOffset > 0 ? { offset: msgOffset } : {}),
        ...(msgLimit > 0 ? { limit: msgLimit } : {}),
    });
    const basePages = parseSessionPages(baseMessages as Array<{ type: string; message: unknown }>);

    for (let pageIdx = 0; pageIdx < basePages.length; pageIdx++) {
        const navMessages = await getSessionMessages(sessionId, {
            dir: workingDir,
            ...(msgOffset > 0 ? { offset: msgOffset } : {}),
            ...(msgLimit > 0 ? { limit: msgLimit } : {}),
        });
        const navPages = parseSessionPages(navMessages as Array<{ type: string; message: unknown }>);
        const clamped = Math.max(0, Math.min(pageIdx, navPages.length - 1));
        test(`Nav to page ${pageIdx}/${basePages.length}`, clamped === pageIdx && navPages.length === basePages.length);
    }
}

// =========================================================================
// Test 3: Auto-upgrade fallback (offset=0, limit=0 = all pages)
// =========================================================================
console.log(`\n--- Test 3: Auto-upgrade fallback (Phase 1→2, all pages) ---`);

// This simulates what happens when Phase 1 state is lost (bot restart):
// We fetch ALL messages (offset=0, limit=0) and parse all pages.
const fallbackMessages = await getSessionMessages(sessionId, { dir: workingDir });
const fallbackPages = parseSessionPages(fallbackMessages as Array<{ type: string; message: unknown }>);
test(`Fallback produces pages`, fallbackPages.length > 0, `got ${fallbackPages.length} pages`);

// Navigate through fallback pages
if (fallbackPages.length > 1) {
    // Test first, middle, and last page
    for (const targetPage of [0, Math.floor(fallbackPages.length / 2), fallbackPages.length - 1]) {
        const navMessages = await getSessionMessages(sessionId, { dir: workingDir });
        const navPages = parseSessionPages(navMessages as Array<{ type: string; message: unknown }>);
        test(`Fallback nav to page ${targetPage}/${fallbackPages.length}`,
            navPages.length === fallbackPages.length && targetPage < navPages.length);
    }
}

// =========================================================================
// Test 4: Session growth resilience
// =========================================================================
console.log(`\n--- Test 4: Session growth resilience ---`);

// Simulate: buttons were finalized with offset/limit, then MORE messages were added.
// The offset/limit should still fetch the same original messages.
if (roundStarts.length >= 2) {
    // Pretend finalization happened at a previous round, and session grew since
    const prevRoundIdx = roundStarts.length - 2;
    const prevRoundStart = roundStarts[prevRoundIdx]!;
    let prevFirstAssistant: string | null = null;
    const prevRoundEnd = roundStarts[prevRoundIdx + 1]!;
    for (let i = prevRoundStart; i < prevRoundEnd; i++) {
        if (typedMessages[i]!.type === 'assistant' && typedMessages[i]!.uuid) {
            prevFirstAssistant = typedMessages[i]!.uuid;
            break;
        }
    }

    if (prevFirstAssistant) {
        const idx = typedMessages.findIndex(m => m.uuid === prevFirstAssistant);
        const prevOffset = idx > 0 && typedMessages[idx - 1]!.type === 'user' ? idx - 1 : idx;
        // Original limit was computed when session had fewer messages
        const prevTotal = prevRoundEnd; // pretend session ended here
        const prevLimit = prevTotal - prevOffset;

        // But NOW the session has MORE messages (typedMessages.length > prevTotal)
        // The persistent buttons still use the old offset/limit
        const grownMessages = await getSessionMessages(sessionId, {
            dir: workingDir,
            ...(prevOffset > 0 ? { offset: prevOffset } : {}),
            ...(prevLimit > 0 ? { limit: prevLimit } : {}),
        });
        const grownPages = parseSessionPages(grownMessages as Array<{ type: string; message: unknown }>);

        // Also compute what pages SHOULD be (just the original round's messages)
        const originalSlice = typedMessages.slice(prevOffset, prevOffset + prevLimit);
        const originalPages = parseSessionPages(originalSlice);

        test(`Growth resilience: offset=${prevOffset}, limit=${prevLimit}`,
            grownPages.length === originalPages.length,
            `expected ${originalPages.length} pages, got ${grownPages.length}`);
    }
}

// =========================================================================
// Test 5: Edge cases
// =========================================================================
console.log(`\n--- Test 5: Edge cases ---`);

// Empty offset/limit
const emptyResult = await getSessionMessages(sessionId, { dir: workingDir, offset: typedMessages.length + 100 });
const emptyPages = parseSessionPages(emptyResult as Array<{ type: string; message: unknown }>);
test(`Out-of-bounds offset returns 0 messages`, emptyResult.length === 0 && emptyPages.length === 0,
    `got ${emptyResult.length} messages, ${emptyPages.length} pages`);

// Limit of 0
const zeroLimitResult = await getSessionMessages(sessionId, { dir: workingDir, limit: 0 });
const zeroLimitPages = parseSessionPages(zeroLimitResult as Array<{ type: string; message: unknown }>);
test(`Limit=0 returns all messages`, zeroLimitResult.length === typedMessages.length,
    `expected ${typedMessages.length}, got ${zeroLimitResult.length}`);

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passedTests}/${totalTests} passed${passedTests === totalTests ? ' ✅' : ' ❌'}`);
console.log(`${'='.repeat(40)}\n`);

process.exit(passedTests === totalTests ? 0 : 1);
