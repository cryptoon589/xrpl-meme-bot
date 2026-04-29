/**
 * Logger utility using winston
 */

import winston from 'winston';
import path from 'path';

const { combine, timestamp, printf, colorize } = winston.format;

// Custom format for console and file
const logFormat = printf(({ level, message, timestamp }) => {
  return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
});

let logger: winston.Logger | null = null;

export function getLogger(logLevel: string = 'info'): winston.Logger {
  if (logger) return logger;

  const transports: winston.transport[] = [
    // Console transport
    new winston.transports.Console({
      format: combine(colorize(), timestamp(), logFormat),
      level: logLevel,
    }),
    // File transport for errors
    new winston.transports.File({
      filename: path.join(process.cwd(), 'logs', 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // File transport for all logs
    new winston.transports.File({
      filename: path.join(process.cwd(), 'logs', 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 10,
    }),
  ];

  logger = winston.createLogger({
    level: logLevel,
    format: combine(timestamp(), logFormat),
    transports,
    exitOnError: false,
  });

  return logger;
}

// Convenience exports
export const info = (msg: string, meta?: any) => {
  const l = getLogger();
  if (meta) l.info(`${msg} ${JSON.stringify(meta)}`);
  else l.info(msg);
};

export const warn = (msg: string, meta?: any) => {
  const l = getLogger();
  if (meta) l.warn(`${msg} ${JSON.stringify(meta)}`);
  else l.warn(msg);
};

export const error = (msg: string, meta?: any) => {
  const l = getLogger();
  if (meta) l.error(`${msg} ${JSON.stringify(meta)}`);
  else l.error(msg);
};

export const debug = (msg: string, meta?: any) => {
  const l = getLogger();
  if (meta) l.debug(`${msg} ${JSON.stringify(meta)}`);
  else l.debug(msg);
};
