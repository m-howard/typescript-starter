# TypeScript Starter Documentation

## Overview

This TypeScript Starter provides a complete foundation for building TypeScript applications with modern development practices and tools.

## Project Structure

```
typescript-starter/
├── src/                    # Source code
│   ├── index.ts           # Main entry point
│   ├── main.ts            # Export barrel file
│   ├── models/            # Data models
│   │   └── user.ts        # User model example
│   ├── services/          # Business logic services
│   │   └── calculator.ts  # Calculator service example
│   └── utils/             # Utility functions
│       ├── helpers.ts     # General helper functions
│       └── logger.ts      # Logging utility
├── test/                  # Test files
├── scripts/               # Build and development scripts
├── docs/                  # Documentation
├── bin/                   # Compiled output (generated)
└── coverage/              # Test coverage reports (generated)
```

## Features

### Core Components

- **Models**: Example `User` class demonstrating TypeScript features
- **Services**: `Calculator` service showing business logic implementation
- **Utilities**: Helper functions and logging functionality

### Development Tools

- **TypeScript**: Strict type checking with modern ES features
- **Jest**: Complete testing framework with coverage reporting
- **ESLint**: Code linting with TypeScript support
- **Prettier**: Code formatting
- **Scripts**: Automated development workflows

## Getting Started

### Prerequisites

- Node.js (version 16 or higher)
- npm or yarn

### Installation

1. Clone the repository
2. Install dependencies:

    ```bash
    npm install
    ```

3. Run the setup script:
    ```bash
    ./scripts/setup-dev.sh
    ```

### Development

Start the development server with watch mode:

```bash
npm run start:dev
```

Run tests:

```bash
npm test
```

Run tests with coverage:

```bash
npm run test:cov
```

### Building

Build the project:

```bash
npm run build
```

Run the compiled application:

```bash
npm run start:prod
```

## Available Scripts

- `npm run build` - Compile TypeScript to JavaScript
- `npm run start` - Run the application
- `npm run start:dev` - Run in development mode with watch
- `npm run start:prod` - Run the compiled application
- `npm run test` - Run unit tests
- `npm run test:watch` - Run tests in watch mode
- `npm run test:cov` - Run tests with coverage
- `npm run test:e2e` - Run end-to-end tests
- `npm run lint` - Run ESLint
- `npm run format` - Format code with Prettier

## Testing

The project includes comprehensive testing:

- **Unit Tests**: Individual component testing
- **Integration Tests**: Service interaction testing
- **End-to-End Tests**: Full application flow testing

Test files are located in the `test/` directory and follow the naming convention `*.spec.ts` for unit tests and `*.e2e.spec.ts` for end-to-end tests.

## Code Style

The project enforces consistent code style using:

- **ESLint**: For code quality and consistency
- **Prettier**: For code formatting
- **TypeScript**: For type safety

Configuration files:

- `.eslintrc.js` - ESLint configuration
- `.prettierrc` - Prettier configuration
- `tsconfig.json` - TypeScript configuration

## Contributing

1. Follow the existing code style
2. Write tests for new functionality
3. Ensure all tests pass before submitting
4. Run `npm run lint` to check code quality

## License

This project is licensed under the UNLICENSED license.
