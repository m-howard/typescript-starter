/**
 * Main entry point for the TypeScript Starter application
 */

import { Logger } from './utils/logger';
import { Calculator } from './services/calculator';
import { User } from './models/user';

const logger = new Logger();

async function main(): Promise<void> {
    logger.info('🚀 Starting TypeScript Starter Application...');

    // Example usage of the Calculator service
    const calculator = new Calculator();
    const result = calculator.add(5, 3);
    logger.info(`Calculator example: 5 + 3 = ${result}`);

    // Example usage of the User model
    const user = new User('John Doe', 'john.doe@example.com', 25);
    logger.info(`User example: ${user.toString()}`);

    logger.info('✅ Application completed successfully!');
}

// Run the application
if (require.main === module) {
    main().catch((error) => {
        console.error('❌ Application failed:', error);
        process.exit(1);
    });
}

export { main };
