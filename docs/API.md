# API Documentation

## Classes

### User

Represents a user in the system with validation and utility methods.

#### Constructor

```typescript
constructor(name: string, email: string, age: number)
```

**Parameters:**

- `name` - User's full name (required, non-empty)
- `email` - User's email address (required, valid email format)
- `age` - User's age (required, 0-150)

**Throws:**

- `Error` - If name is empty
- `Error` - If email is invalid
- `Error` - If age is outside valid range

#### Methods

##### `getId(): string`

Returns the user's unique identifier.

##### `getCreatedAt(): Date`

Returns the date when the user was created.

##### `isAdult(): boolean`

Returns `true` if the user is 18 or older.

##### `getDisplayName(): string`

Returns formatted display name (e.g., "John Doe (25)").

##### `toString(): string`

Returns string representation of the user.

##### `toJSON(): Record<string, any>`

Returns JSON-serializable object representation.

#### Example

```typescript
import { User } from './models/user';

const user = new User('John Doe', 'john@example.com', 25);
console.log(user.getDisplayName()); // "John Doe (25)"
console.log(user.isAdult()); // true
```

### Calculator

Provides mathematical operations with error handling.

#### Methods

##### `add(a: number, b: number): number`

Adds two numbers.

##### `subtract(a: number, b: number): number`

Subtracts second number from first.

##### `multiply(a: number, b: number): number`

Multiplies two numbers.

##### `divide(a: number, b: number): number`

Divides first number by second.
**Throws:** `Error` if dividing by zero.

##### `power(base: number, exponent: number): number`

Calculates base raised to exponent.

##### `sqrt(value: number): number`

Calculates square root.
**Throws:** `Error` if value is negative.

##### `percentage(value: number, percentage: number): number`

Calculates percentage of a value.

##### `isEven(value: number): boolean`

Returns `true` if number is even.

##### `isOdd(value: number): boolean`

Returns `true` if number is odd.

##### `abs(value: number): number`

Returns absolute value.

#### Example

```typescript
import { Calculator } from './services/calculator';

const calc = new Calculator();
console.log(calc.add(5, 3)); // 8
console.log(calc.divide(10, 2)); // 5
console.log(calc.isEven(4)); // true
```

### Logger

Provides leveled logging functionality.

#### Constructor

```typescript
constructor(logLevel: LogLevel = LogLevel.INFO)
```

#### Log Levels

```typescript
enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}
```

#### Methods

##### `setLogLevel(level: LogLevel): void`

Sets the minimum log level.

##### `debug(message: string, ...args: any[]): void`

Logs debug message (only if log level allows).

##### `info(message: string, ...args: any[]): void`

Logs info message (only if log level allows).

##### `warn(message: string, ...args: any[]): void`

Logs warning message (only if log level allows).

##### `error(message: string, error?: Error, ...args: any[]): void`

Logs error message with optional Error object.

#### Example

```typescript
import { Logger, LogLevel } from './utils/logger';

const logger = new Logger(LogLevel.DEBUG);
logger.info('Application started');
logger.warn('This is a warning');
logger.error('Something went wrong', new Error('Details'));
```

## Utility Functions

### Helper Functions

#### `delay(ms: number): Promise<void>`

Creates a delay for the specified number of milliseconds.

#### `randomInt(min: number, max: number): number`

Generates random integer between min and max (inclusive).

#### `isDefined<T>(value: T | null | undefined): value is T`

Type guard to check if value is not null or undefined.

#### `capitalize(str: string): string`

Capitalizes the first letter of a string.

#### `camelToKebab(str: string): string`

Converts camelCase to kebab-case.

#### `kebabToCamel(str: string): string`

Converts kebab-case to camelCase.

#### `deepClone<T>(obj: T): T`

Creates a deep clone of an object.

#### `removeDuplicates<T>(array: T[]): T[]`

Removes duplicate values from an array.

#### `groupBy<T, K>(array: T[], keyFn: (item: T) => K): Record<K, T[]>`

Groups array elements by a key function.

#### Examples

```typescript
import { delay, randomInt, capitalize, deepClone } from './utils/helpers';

// Delay execution
await delay(1000);

// Generate random number
const num = randomInt(1, 10);

// Capitalize string
const name = capitalize('john'); // "John"

// Deep clone object
const original = { a: 1, b: { c: 2 } };
const cloned = deepClone(original);
```
