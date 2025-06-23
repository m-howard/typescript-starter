/**
 * Tests for the User model
 */

import { User } from '../src/models/user';

describe('User', () => {
    describe('constructor', () => {
        it('should create a user with valid data', () => {
            const user = new User('John Doe', 'john@example.com', 25);

            expect(user.name).toBe('John Doe');
            expect(user.email).toBe('john@example.com');
            expect(user.age).toBe(25);
            expect(user.getId()).toBeDefined();
            expect(user.getCreatedAt()).toBeInstanceOf(Date);
        });

        it('should throw error for empty name', () => {
            expect(() => {
                new User('', 'john@example.com', 25);
            }).toThrow('Name cannot be empty');
        });

        it('should throw error for invalid email', () => {
            expect(() => {
                new User('John Doe', 'invalid-email', 25);
            }).toThrow('Invalid email address');
        });

        it('should throw error for negative age', () => {
            expect(() => {
                new User('John Doe', 'john@example.com', -1);
            }).toThrow('Age must be between 0 and 150');
        });

        it('should throw error for age over 150', () => {
            expect(() => {
                new User('John Doe', 'john@example.com', 151);
            }).toThrow('Age must be between 0 and 150');
        });
    });

    describe('isAdult', () => {
        it('should return true for adult', () => {
            const user = new User('John Doe', 'john@example.com', 25);
            expect(user.isAdult()).toBe(true);
        });

        it('should return false for minor', () => {
            const user = new User('Jane Doe', 'jane@example.com', 16);
            expect(user.isAdult()).toBe(false);
        });

        it('should return true for exactly 18 years old', () => {
            const user = new User('Sam Doe', 'sam@example.com', 18);
            expect(user.isAdult()).toBe(true);
        });
    });

    describe('getDisplayName', () => {
        it('should return formatted display name', () => {
            const user = new User('John Doe', 'john@example.com', 25);
            expect(user.getDisplayName()).toBe('John Doe (25)');
        });
    });

    describe('toString', () => {
        it('should return string representation', () => {
            const user = new User('John Doe', 'john@example.com', 25);
            const result = user.toString();

            expect(result).toContain('User(');
            expect(result).toContain('name=John Doe');
            expect(result).toContain('email=john@example.com');
            expect(result).toContain('age=25');
            expect(result).toContain('isAdult=true');
        });
    });

    describe('toJSON', () => {
        it('should return JSON representation', () => {
            const user = new User('John Doe', 'john@example.com', 25);
            const json = user.toJSON();

            expect(json).toHaveProperty('id');
            expect(json).toHaveProperty('name', 'John Doe');
            expect(json).toHaveProperty('email', 'john@example.com');
            expect(json).toHaveProperty('age', 25);
            expect(json).toHaveProperty('isAdult', true);
            expect(json).toHaveProperty('createdAt');
            expect(typeof json.createdAt).toBe('string');
        });
    });
});
