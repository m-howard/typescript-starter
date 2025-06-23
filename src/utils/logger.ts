import winston, { format, transports, Logger as WinstonLogger } from 'winston';
import morgan, { StreamOptions } from 'morgan';

/**
 * Log levels for the application
 */
export enum LogLevel {
    DEBUG = 'debug',
    INFO = 'info',
    WARN = 'warn',
    ERROR = 'error',
}

/**
 * Production-grade logger using winston
 */
export class Logger {
    private readonly logger: WinstonLogger;

    constructor(logLevel: LogLevel = LogLevel.INFO) {
        this.logger = winston.createLogger({
            level: logLevel,
            format: format.combine(
                format.timestamp(),
                format.errors({ stack: true }),
                format.splat(),
                format.json(),
            ),
            transports: [
                new transports.Console({
                    format: format.combine(
                        format.colorize(),
                        format.printf(({ timestamp, level, message, ...meta }) => {
                            return `[${timestamp}] ${level}: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
                        }),
                    ),
                }),
            ],
        });
    }

    /**
     * Set the minimum log level
     */
    public setLogLevel(level: LogLevel): void {
        this.logger.level = level;
    }

    /**
     * Log debug message
     */
    public debug(message: string, ...args: unknown[]): void {
        this.logger.debug(message, ...args);
    }

    /**
     * Log info message
     */
    public info(message: string, ...args: unknown[]): void {
        this.logger.info(message, ...args);
    }

    /**
     * Log warning message
     */
    public warn(message: string, ...args: unknown[]): void {
        this.logger.warn(message, ...args);
    }

    /**
     * Log error message
     */
    public error(message: string, error?: Error, ...args: unknown[]): void {
        if (error) {
            this.logger.error(`${message} - ${error.message}`, { stack: error.stack, ...args });
        } else {
            this.logger.error(message, ...args);
        }
    }

    /**
     * Get a morgan middleware stream for HTTP request logging
     */
    public getMorganStream(): StreamOptions {
        return {
            write: (message: string) => {
                // Use type-safe access to http method, fallback to info
                const loggerAny = this.logger as WinstonLogger & {
                    http?: (msg: string) => WinstonLogger;
                };
                if (typeof loggerAny.http === 'function') {
                    loggerAny.http(message.trim());
                } else {
                    this.logger.info(message.trim());
                }
            },
        };
    }
}

/**
 * Create a morgan middleware for express
 * @param logger Logger instance
 * @param formatStr Morgan format string (default: 'combined')
 */
export function createMorganMiddleware(logger: Logger, formatStr: string = 'combined') {
    return morgan(formatStr, { stream: logger.getMorganStream() });
}
