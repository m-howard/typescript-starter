/**
 * Tests for the Logger utility
 */

import { Logger, LogLevel, createMorganMiddleware } from '../src/utils/logger';
import type { Logger as WinstonLogger } from 'winston';

describe('Logger', () => {
    let logger: Logger;
    let debugSpy: jest.SpyInstance;
    let infoSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
        logger = new Logger(LogLevel.DEBUG);

        // Mock the Winston logger methods directly
        debugSpy = jest
            .spyOn((logger as unknown as { logger: WinstonLogger }).logger, 'debug')
            .mockImplementation(() => logger as unknown as WinstonLogger);
        infoSpy = jest
            .spyOn((logger as unknown as { logger: WinstonLogger }).logger, 'info')
            .mockImplementation(() => logger as unknown as WinstonLogger);
        warnSpy = jest
            .spyOn((logger as unknown as { logger: WinstonLogger }).logger, 'warn')
            .mockImplementation(() => logger as unknown as WinstonLogger);
        errorSpy = jest
            .spyOn((logger as unknown as { logger: WinstonLogger }).logger, 'error')
            .mockImplementation(() => logger as unknown as WinstonLogger);
    });

    afterEach(() => {
        debugSpy.mockRestore();
        infoSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('should log at all levels', () => {
        logger.debug('debug');
        logger.info('info');
        logger.warn('warn');
        logger.error('error');

        expect(debugSpy).toHaveBeenCalledWith('debug');
        expect(infoSpy).toHaveBeenCalledWith('info');
        expect(warnSpy).toHaveBeenCalledWith('warn');
        expect(errorSpy).toHaveBeenCalledWith('error');
    });

    it('should set log level', () => {
        logger.setLogLevel(LogLevel.ERROR);

        // Verify the logger level was set
        expect((logger as unknown as { logger: WinstonLogger }).logger.level).toBe(LogLevel.ERROR);
    });

    it('should log error with stack', () => {
        const err = new Error('fail');
        logger.error('error', err);

        expect(errorSpy).toHaveBeenCalledWith('error - fail', {
            stack: err.stack,
        });
    });

    it('should provide a morgan stream', () => {
        const stream = logger.getMorganStream();
        expect(typeof stream.write).toBe('function');
    });

    it('should create morgan middleware', () => {
        const mw = createMorganMiddleware(logger, 'tiny');
        expect(typeof mw).toBe('function');
    });
});
