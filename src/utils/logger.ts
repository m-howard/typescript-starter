/**
 * Simple logger utility class
 */

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

export class Logger {
    private logLevel: LogLevel;

    constructor(logLevel: LogLevel = LogLevel.INFO) {
        this.logLevel = logLevel;
    }

    /**
     * Set the minimum log level
     */
    public setLogLevel(level: LogLevel): void {
        this.logLevel = level;
    }

    /**
     * Log debug message
     */
    public debug(message: string, ...args: unknown[]): void {
        if (this.logLevel <= LogLevel.DEBUG) {
            this.log('🐛 DEBUG', message, ...args);
        }
    }

    /**
     * Log info message
     */
    public info(message: string, ...args: unknown[]): void {
        if (this.logLevel <= LogLevel.INFO) {
            this.log('ℹ️  INFO', message, ...args);
        }
    }

    /**
     * Log warning message
     */
    public warn(message: string, ...args: unknown[]): void {
        if (this.logLevel <= LogLevel.WARN) {
            this.log('⚠️  WARN', message, ...args);
        }
    }

    /**
     * Log error message
     */
    public error(message: string, error?: Error, ...args: unknown[]): void {
        if (this.logLevel <= LogLevel.ERROR) {
            this.log('❌ ERROR', message, error?.stack || error, ...args);
        }
    }

    /**
     * Internal log method
     */
    private log(level: string, message: string, ...args: unknown[]): void {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] ${level}: ${message}`, ...args);
    }
}
