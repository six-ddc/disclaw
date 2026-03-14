/**
 * Centralized type definitions for permission modes and display modes.
 *
 * Single source of truth for mode values, labels, and type guards.
 * All other modules should import from here instead of defining their own.
 */

/** Valid permission mode values (matches SDK's permissionMode options) */
export type PermissionMode = 'default' | 'dontAsk' | 'acceptEdits' | 'bypassPermissions' | 'plan';

/** Valid display mode values */
export type DisplayMode = 'verbose' | 'simple' | 'pager';

/** Permission mode definitions with labels and descriptions for UI */
export const PERMISSION_MODES = [
    { value: 'default' as const, label: 'Default', description: 'No auto-approvals; tools trigger approval UI' },
    { value: 'dontAsk' as const, label: 'Don\'t Ask', description: 'Deny instead of prompting (no canUseTool calls)' },
    { value: 'acceptEdits' as const, label: 'Accept Edits', description: 'Auto-accept file edits and filesystem operations' },
    { value: 'bypassPermissions' as const, label: 'Bypass', description: 'All tools run without permission prompts' },
    { value: 'plan' as const, label: 'Plan', description: 'No tool execution; Claude plans without making changes' },
] as const;

/** Display mode definitions with labels and descriptions for UI */
export const DISPLAY_MODES = [
    { value: 'verbose' as const, label: 'Verbose', description: 'Show all tool messages as they arrive' },
    { value: 'simple' as const, label: 'Simple', description: 'Hide tool and thinking messages, show only final reply' },
    { value: 'pager' as const, label: 'Pager', description: 'Tool calls in a single navigable embed with page buttons' },
] as const;

/** Set of valid permission mode values for fast lookup */
const PERMISSION_MODE_VALUES = new Set<string>(PERMISSION_MODES.map(m => m.value));

/** Set of valid display mode values for fast lookup */
const DISPLAY_MODE_VALUES = new Set<string>(DISPLAY_MODES.map(m => m.value));

/** Type guard: checks if a string is a valid PermissionMode */
export function isValidPermissionMode(value: string): value is PermissionMode {
    return PERMISSION_MODE_VALUES.has(value);
}

/** Type guard: checks if a string is a valid DisplayMode */
export function isValidDisplayMode(value: string): value is DisplayMode {
    return DISPLAY_MODE_VALUES.has(value);
}
