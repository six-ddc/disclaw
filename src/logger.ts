/**
 * Logger - Centralized logging with pino
 *
 * Outputs to both console (pretty-printed) and daily log files.
 * Usage: import { createLogger } from './logger.js';
 *        const log = createLogger('bot');
 *        log('Server started');           // info level
 *        log.info('Server started');      // same
 *        log.error('Something broke');    // error level
 */

import pino from 'pino';
import { mkdirSync } from 'fs';
import { resolve } from 'path';

const LOG_DIR = resolve(process.cwd(), 'logs');
mkdirSync(LOG_DIR, { recursive: true });

function getLogFile(): string {
    const date = new Date().toISOString().slice(0, 10);
    return resolve(LOG_DIR, `${date}.log`);
}

const rootLogger = pino({
    level: 'debug',
}, pino.transport({
    targets: [
        {
            target: 'pino-pretty',
            options: {
                destination: 1, // stdout
                colorize: true,
                translateTime: 'SYS:HH:MM:ss.l',
                ignore: 'pid,hostname,module',
                messageFormat: '[{module}] {msg}',
            },
            level: 'debug',
        },
        {
            target: 'pino-pretty',
            options: {
                destination: getLogFile(),
                mkdir: true,
                colorize: false,
                translateTime: 'SYS:HH:MM:ss.l',
                ignore: 'pid,hostname,module',
                messageFormat: '[{module}] {msg}',
            },
            level: 'debug',
        },
    ],
}));

export interface LogFn {
    (msg: string): void;
    info: (msg: string) => void;
    error: (msg: string) => void;
    warn: (msg: string) => void;
    debug: (msg: string) => void;
}

/** Create a logger for a module. Callable directly as log('msg') or log.info('msg'). */
export function createLogger(module: string): LogFn {
    const child = rootLogger.child({ module });

    const log = ((msg: string) => child.info(msg)) as LogFn;
    log.info = (msg: string) => child.info(msg);
    log.error = (msg: string) => child.error(msg);
    log.warn = (msg: string) => child.warn(msg);
    log.debug = (msg: string) => child.debug(msg);

    return log;
}

export default rootLogger;
