/**
 * Tests for the Logger utility
 */

import { Logger, LogLevel } from '../src/utils/logger';

describe('Logger', () => {
    let consoleSpy: jest.SpyInstance;

    beforeEach(() => {
        consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    });

    afterEach(() => {
        consoleSpy.mockRestore();
    });

    describe('constructor', () => {
        it('should create logger with default INFO level', () => {
            const logger = new Logger();
            logger.debug('debug message');
            logger.info('info message');

            expect(consoleSpy).toHaveBeenCalledTimes(1);
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringMatching(/\[.*\] ℹ️ {2}INFO: info message/),
            );
        });

        it('should create logger with custom log level', () => {
            const logger = new Logger(LogLevel.DEBUG);
            logger.debug('debug message');
            logger.info('info message');

            expect(consoleSpy).toHaveBeenCalledTimes(2);
        });
    });

    describe('setLogLevel', () => {
        it('should change log level', () => {
            const logger = new Logger(LogLevel.WARN);
            logger.info('info message');
            expect(consoleSpy).not.toHaveBeenCalled();

            logger.setLogLevel(LogLevel.INFO);
            logger.info('info message');
            expect(consoleSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('debug', () => {
        it('should log debug messages when level allows', () => {
            const logger = new Logger(LogLevel.DEBUG);
            logger.debug('debug message');

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringMatching(/\[.*\] 🐛 DEBUG: debug message/),
            );
        });

        it('should not log debug messages when level is higher', () => {
            const logger = new Logger(LogLevel.INFO);
            logger.debug('debug message');

            expect(consoleSpy).not.toHaveBeenCalled();
        });
    });

    describe('info', () => {
        it('should log info messages when level allows', () => {
            const logger = new Logger(LogLevel.INFO);
            logger.info('info message');

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringMatching(/\[.*\] ℹ️ {2}INFO: info message/),
            );
        });
    });

    describe('warn', () => {
        it('should log warning messages when level allows', () => {
            const logger = new Logger(LogLevel.WARN);
            logger.warn('warning message');

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringMatching(/\[.*\] ⚠️ {2}WARN: warning message/),
            );
        });
    });

    describe('error', () => {
        it('should log error messages', () => {
            const logger = new Logger(LogLevel.ERROR);
            logger.error('error message');

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringMatching(/\[.*\] ❌ ERROR: error message/),
                undefined,
            );
        });

        it('should log error with stack trace', () => {
            const logger = new Logger(LogLevel.ERROR);
            const error = new Error('test error');
            logger.error('error message', error);

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringMatching(/\[.*\] ❌ ERROR: error message/),
                expect.stringContaining('Error: test error'),
            );
        });
    });
});
