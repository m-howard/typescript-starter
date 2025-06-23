/**
 * End-to-end tests for the main application
 */

import { main } from '../src/index';

describe('Main Application (E2E)', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should run the main application without errors', async () => {
    await expect(main()).resolves.toBeUndefined();
  });

  it('should log startup and completion messages', async () => {
    await main();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/🚀 Starting TypeScript Starter Application/)
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/✅ Application completed successfully/)
    );
  });

  it('should demonstrate calculator functionality', async () => {
    await main();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Calculator example: 5 \+ 3 = 8/)
    );
  });

  it('should demonstrate user model functionality', async () => {
    await main();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/User example:.*John Doe.*john\.doe@example\.com/)
    );
  });
});
