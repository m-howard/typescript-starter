/**
 * Calculator service demonstrating basic math operations
 */

export class Calculator {
    /**
     * Add two numbers
     */
    public add(a: number, b: number): number {
        return a + b;
    }

    /**
     * Subtract two numbers
     */
    public subtract(a: number, b: number): number {
        return a - b;
    }

    /**
     * Multiply two numbers
     */
    public multiply(a: number, b: number): number {
        return a * b;
    }

    /**
     * Divide two numbers
     */
    public divide(a: number, b: number): number {
        if (b === 0) {
            throw new Error('Division by zero is not allowed');
        }
        return a / b;
    }

    /**
     * Calculate power of a number
     */
    public power(base: number, exponent: number): number {
        return Math.pow(base, exponent);
    }

    /**
     * Calculate square root of a number
     */
    public sqrt(value: number): number {
        if (value < 0) {
            throw new Error('Cannot calculate square root of negative number');
        }
        return Math.sqrt(value);
    }

    /**
     * Calculate percentage
     */
    public percentage(value: number, percentage: number): number {
        return (value * percentage) / 100;
    }

    /**
     * Check if a number is even
     */
    public isEven(value: number): boolean {
        return value % 2 === 0;
    }

    /**
     * Check if a number is odd
     */
    public isOdd(value: number): boolean {
        return !this.isEven(value);
    }

    /**
     * Get the absolute value of a number
     */
    public abs(value: number): number {
        return Math.abs(value);
    }
}
