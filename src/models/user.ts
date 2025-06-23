/**
 * User model class demonstrating TypeScript features
 */

export class User {
    private readonly id: string;
    private readonly createdAt: Date;

    constructor(
        public readonly name: string,
        public readonly email: string,
        public readonly age: number,
    ) {
        this.id = this.generateId();
        this.createdAt = new Date();
        this.validateInput();
    }

    /**
     * Get the user's ID
     */
    public getId(): string {
        return this.id;
    }

    /**
     * Get when the user was created
     */
    public getCreatedAt(): Date {
        return this.createdAt;
    }

    /**
     * Check if the user is an adult
     */
    public isAdult(): boolean {
        return this.age >= 18;
    }

    /**
     * Get user display name
     */
    public getDisplayName(): string {
        return `${this.name} (${this.age})`;
    }

    /**
     * Convert user to string representation
     */
    public toString(): string {
        return `User(id=${this.id}, name=${this.name}, email=${this.email}, age=${this.age}, isAdult=${this.isAdult()})`;
    }

    /**
     * Convert user to JSON object
     */
    public toJSON(): Record<string, unknown> {
        return {
            id: this.id,
            name: this.name,
            email: this.email,
            age: this.age,
            isAdult: this.isAdult(),
            createdAt: this.createdAt.toISOString(),
        };
    }

    /**
     * Validate user input
     */
    private validateInput(): void {
        if (!this.name || this.name.trim().length === 0) {
            throw new Error('Name cannot be empty');
        }

        if (!this.email || !this.isValidEmail(this.email)) {
            throw new Error('Invalid email address');
        }

        if (this.age < 0 || this.age > 150) {
            throw new Error('Age must be between 0 and 150');
        }
    }

    /**
     * Simple email validation
     */
    private isValidEmail(email: string): boolean {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    /**
     * Generate a simple ID (in real apps, use UUID or similar)
     */
    private generateId(): string {
        return Math.random().toString(36).substr(2, 9);
    }
}
