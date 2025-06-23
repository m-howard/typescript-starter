# Copilot Instructions for TypeScript Starter Repository

> **Note:** When updating this file, ensure that `AGENTS.md` is updated to reflect the same changes. Other than the title, the files should be the same.

## Project Overview

This is a comprehensive TypeScript starter template designed for building robust, production-ready applications. It includes modern tooling, best practices, and a well-structured architecture suitable for both libraries and applications.

### Key Technologies

- **TypeScript 5.7.3** - Main programming language with strict type checking
- **Jest 29.7.0** - Testing framework for unit, integration, and e2e tests
- **ESLint 9.18.0** - Code linting and quality enforcement
- **Prettier 3.4.2** - Code formatting
- **ts-node** - TypeScript execution and development
- **Lodash** - Utility functions
- **Class-validator & Class-transformer** - Data validation and transformation

## Project Structure

```
src/
├── index.ts           # Main application entry point
├── main.ts           # Alternative entry point
├── models/           # Data models and entities
│   └── user.ts       # User model with validation
├── services/         # Business logic and services
│   └── calculator.ts # Example calculator service
└── utils/            # Utility functions and helpers
    ├── helpers.ts    # General helper functions
    └── logger.ts     # Logging utilities

test/                 # Test files mirroring src structure
├── *.spec.ts        # Unit tests
├── *.e2e.spec.ts    # End-to-end tests
└── jest-e2e.json    # E2E test configuration

bin/                 # Compiled JavaScript output
docs/                # Documentation
examples/            # Usage examples
scripts/             # Build and utility scripts
```

## Coding Standards & Best Practices

### TypeScript Guidelines

- **Strict Mode**: Always use strict TypeScript settings (enabled in tsconfig.json)
- **Type Safety**: Prefer explicit types over `any`, use proper generics
- **Null Safety**: Use strict null checks, prefer optional chaining (`?.`)
- **Interfaces vs Types**: Use interfaces for object shapes, types for unions/primitives
- **Naming Conventions**:
    - Classes: PascalCase (`User`, `Calculator`)
    - Functions/Variables: camelCase (`getUserById`, `isValid`)
    - Constants: UPPER_SNAKE_CASE (`MAX_RETRY_ATTEMPTS`)
    - Files: kebab-case (`user-service.ts`) or camelCase (`userService.ts`)

### Code Organization

- **Single Responsibility**: Each class/function should have one clear purpose
- **Dependency Injection**: Use constructor injection for dependencies
- **Error Handling**: Use proper error types, avoid silent failures
- **Immutability**: Prefer readonly properties and immutable patterns
- **Documentation**: Use JSDoc comments for public APIs

### File Structure Patterns

```typescript
// Standard file structure
/**
 * File description
 */

// Imports (external libraries first, then internal)
import { external } from 'library';
import { Internal } from '../internal';

// Types and interfaces
interface UserConfig {
    // ...
}

// Main class/function implementation
export class ServiceName {
    // ...
}

// Default export (if applicable)
export default ServiceName;
```

## Development Workflow

### Available Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Compile TypeScript to JavaScript
- `npm run test` - Run unit tests
- `npm run test:watch` - Run tests in watch mode
- `npm run test:cov` - Run tests with coverage
- `npm run test:e2e` - Run end-to-end tests
- `npm run lint` - Run ESLint with auto-fix
- `npm run format` - Format code with Prettier

### Testing Strategy

- **Unit Tests**: Test individual functions/classes in isolation
- **Integration Tests**: Test component interactions
- **E2E Tests**: Test complete user workflows
- **Coverage Target**: Aim for >80% code coverage
- **Test Naming**: Describe behavior, not implementation

```typescript
// Good test naming
describe('Calculator', () => {
    it('should return sum when adding two positive numbers', () => {
        // ...
    });

    it('should throw error when dividing by zero', () => {
        // ...
    });
});
```

## Code Generation Guidelines

### When Creating New Features

1. **Models**: Create in `src/models/` with proper validation
2. **Services**: Create in `src/services/` with business logic
3. **Utils**: Create in `src/utils/` for reusable functions
4. **Tests**: Mirror src structure in test/ directory

### Class Structure Template

```typescript
/**
 * Description of the class purpose
 */
export class ClassName {
    private readonly property: Type;

    constructor(
        public readonly param: Type,
        private dependency: Dependency,
    ) {
        this.property = this.initializeProperty();
    }

    /**
     * Public method description
     */
    public methodName(): ReturnType {
        // Implementation
    }

    private helperMethod(): void {
        // Private implementation
    }
}
```

### Error Handling Patterns

```typescript
// Use custom error classes
export class ValidationError extends Error {
    constructor(field: string, value: unknown) {
        super(`Invalid ${field}: ${value}`);
        this.name = 'ValidationError';
    }
}

// Handle errors appropriately
try {
    const result = await riskyOperation();
    return result;
} catch (error) {
    logger.error('Operation failed', error);
    throw new ProcessingError('Failed to process request');
}
```

### Async/Await Best Practices

- Always use `async/await` over Promise chains
- Handle errors with try/catch blocks
- Use proper return types (`Promise<T>`)
- Don't forget to await async calls

## Dependencies & Libraries

### Core Dependencies

- **lodash**: Use for utility functions (debounce, deep clone, etc.)
- **class-validator**: For model validation decorators
- **class-transformer**: For object transformation

### Development Dependencies

- **@types/\***: Always install type definitions for libraries
- **jest**: Primary testing framework
- **eslint**: Code quality and style enforcement
- **prettier**: Code formatting

### Adding New Dependencies

1. Install with proper scope: `npm install package-name`
2. Add types if needed: `npm install --save-dev @types/package-name`
3. Update imports to follow project patterns
4. Add to appropriate tsconfig paths if needed

## Performance Considerations

- Use lazy loading for large imports
- Implement proper caching strategies
- Avoid memory leaks with proper cleanup
- Use efficient algorithms and data structures
- Profile and optimize critical paths

## Security Guidelines

- Validate all inputs using class-validator
- Sanitize data before processing
- Use proper error messages (don't leak sensitive info)
- Follow principle of least privilege
- Keep dependencies updated

## Documentation Standards

- Use JSDoc comments
- Include examples in documentation
- Keep README.md updated with new features
- Document breaking changes in commit messages
- Maintain API documentation in docs/ directory

## Git Workflow

- Use conventional commit messages
- Create feature branches for new work
- **Run `npm test` and ensure all tests pass before committing or merging**
- Use meaningful commit messages
- Squash commits when appropriate

## Environment Setup

This project is designed to work in dev containers and includes:

- Pre-configured TypeScript environment
- Git, Docker CLI, and common tools
- Debian-based container with modern tooling
- All necessary VS Code extensions recommendations

## Additional Guidelines

- **JSDoc Comments**: All interfaces, classes, and methods must include clear and descriptive JSDoc comments.
- **Validation Scripts**: Any validation scripts created that are not tests should be removed after use to keep the repository clean.
- **Unit Tests**: Always add unit tests for new features, bug fixes, and where appropriate to ensure code reliability.
- **Environment Variables**: Use the `dotenv` package for managing environment variables during local development. Document required variables in a `.env.example` file.
- **Code Comments**: Provide detailed code comments wherever logic is complex or not immediately clear, to aid maintainability and onboarding.

When generating code, always consider the existing patterns and maintain consistency with the established architecture.
