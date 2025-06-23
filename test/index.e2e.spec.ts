/**
 * End-to-end tests for the main application
 */

import { main } from '../src/index';
import { Logger } from '../src/utils/logger';

describe('Main Application (E2E)', () => {
    let logMessages: string[] = [];
    let infoSpy: jest.SpyInstance;

    beforeEach(() => {
        logMessages = [];
        // Mock the Logger.info method to capture messages
        infoSpy = jest.spyOn(Logger.prototype, 'info').mockImplementation((message: string) => {
            logMessages.push(message);
        });
    });

    afterEach(() => {
        infoSpy.mockRestore();
    });

    it('should run the main application without errors', async () => {
        await expect(main()).resolves.toBeUndefined();
    });

    it('should log startup and completion messages', async () => {
        await main();
        const output = logMessages.join(' ');
        expect(output).toMatch(/🚀 Starting TypeScript Starter Application/);
        expect(output).toMatch(/✅ Application completed successfully/);
    });

    it('should demonstrate calculator functionality', async () => {
        await main();
        const output = logMessages.join(' ');
        expect(output).toMatch(/Calculator example: 5 \+ 3 = 8/);
    });

    it('should demonstrate user model functionality', async () => {
        await main();
        const output = logMessages.join(' ');
        expect(output).toMatch(/User example:.*John Doe.*john\.doe@example\.com/);
    });
});
