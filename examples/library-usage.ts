/**
 * Example usage of the TypeScript Starter library
 * This demonstrates how to use the project as a library
 */

import { User, Calculator, Logger, LogLevel, capitalize, delay } from '../src/main';

async function libraryExample() {
    const logger = new Logger(LogLevel.INFO);
    logger.info('🚀 Library Example Started');

    // User model example
    const user = new User('Jane Smith', 'jane.smith@example.com', 28);
    logger.info(`Created user: ${user.getDisplayName()}`);
    logger.info(`User is adult: ${user.isAdult()}`);
    logger.info(`User JSON: ${JSON.stringify(user.toJSON())}`);

    // Calculator service example
    const calc = new Calculator();
    logger.info(`Calculator examples:`);
    logger.info(`  10 + 5 = ${calc.add(10, 5)}`);
    logger.info(`  10 * 3 = ${calc.multiply(10, 3)}`);
    logger.info(`  √16 = ${calc.sqrt(16)}`);
    logger.info(`  2^3 = ${calc.power(2, 3)}`);
    logger.info(`  25% of 200 = ${calc.percentage(200, 25)}`);

    // Utility functions example
    logger.info(`Utility examples:`);
    logger.info(`  Capitalize "hello world": ${capitalize('hello world')}`);

    // Async utility example
    logger.info('Waiting 1 second...');
    await delay(1000);
    logger.info('Wait completed!');

    logger.info('✅ Library Example Completed');
}

// Run the example
if (require.main === module) {
    libraryExample().catch(console.error);
}

export { libraryExample };
