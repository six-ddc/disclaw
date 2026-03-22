/**
 * Paths - XDG Base Directory compliant default paths
 */

import { homedir } from 'os';
import { resolve } from 'path';

const home = homedir();
const xdgData = process.env.XDG_DATA_HOME || resolve(home, '.local/share');
const xdgState = process.env.XDG_STATE_HOME || resolve(home, '.local/state');

export const DEFAULT_DB_PATH = resolve(xdgData, 'disclaw', 'threads.db');
export const DEFAULT_WORKING_DIR = resolve(home, '.disclaw');
export const DEFAULT_LOG_DIR = resolve(xdgState, 'disclaw', 'logs');
