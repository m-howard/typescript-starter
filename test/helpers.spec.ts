/**
 * Tests for utility helper functions
 */

import {
    delay,
    randomInt,
    isDefined,
    capitalize,
    camelToKebab,
    kebabToCamel,
    deepClone,
    removeDuplicates,
    groupBy,
} from '../src/utils/helpers';

describe('Utility Helpers', () => {
    describe('delay', () => {
        it('should delay execution', async () => {
            const start = Date.now();
            await delay(100);
            const end = Date.now();
            expect(end - start).toBeGreaterThanOrEqual(90); // Allow some margin
        });
    });

    describe('randomInt', () => {
        it('should generate random number within range', () => {
            const result = randomInt(1, 10);
            expect(result).toBeGreaterThanOrEqual(1);
            expect(result).toBeLessThanOrEqual(10);
            expect(Number.isInteger(result)).toBe(true);
        });

        it('should handle single value range', () => {
            const result = randomInt(5, 5);
            expect(result).toBe(5);
        });
    });

    describe('isDefined', () => {
        it('should return true for defined values', () => {
            expect(isDefined(0)).toBe(true);
            expect(isDefined('')).toBe(true);
            expect(isDefined(false)).toBe(true);
            expect(isDefined([])).toBe(true);
            expect(isDefined({})).toBe(true);
        });

        it('should return false for null or undefined', () => {
            expect(isDefined(null)).toBe(false);
            expect(isDefined(undefined)).toBe(false);
        });
    });

    describe('capitalize', () => {
        it('should capitalize first letter', () => {
            expect(capitalize('hello')).toBe('Hello');
            expect(capitalize('WORLD')).toBe('World');
        });

        it('should handle empty string', () => {
            expect(capitalize('')).toBe('');
        });

        it('should handle single character', () => {
            expect(capitalize('a')).toBe('A');
        });
    });

    describe('camelToKebab', () => {
        it('should convert camelCase to kebab-case', () => {
            expect(camelToKebab('camelCase')).toBe('camel-case');
            expect(camelToKebab('thisIsATest')).toBe('this-is-a-test');
        });

        it('should handle single word', () => {
            expect(camelToKebab('word')).toBe('word');
        });
    });

    describe('kebabToCamel', () => {
        it('should convert kebab-case to camelCase', () => {
            expect(kebabToCamel('kebab-case')).toBe('kebabCase');
            expect(kebabToCamel('this-is-a-test')).toBe('thisIsATest');
        });

        it('should handle single word', () => {
            expect(kebabToCamel('word')).toBe('word');
        });
    });

    describe('deepClone', () => {
        it('should clone primitive values', () => {
            expect(deepClone(5)).toBe(5);
            expect(deepClone('test')).toBe('test');
            expect(deepClone(true)).toBe(true);
            expect(deepClone(null)).toBe(null);
        });

        it('should clone arrays', () => {
            const original = [1, 2, 3];
            const cloned = deepClone(original);
            expect(cloned).toEqual(original);
            expect(cloned).not.toBe(original);
        });

        it('should clone objects', () => {
            const original = { a: 1, b: { c: 2 } };
            const cloned = deepClone(original);
            expect(cloned).toEqual(original);
            expect(cloned).not.toBe(original);
            expect(cloned.b).not.toBe(original.b);
        });

        it('should clone dates', () => {
            const original = new Date('2023-01-01');
            const cloned = deepClone(original);
            expect(cloned).toEqual(original);
            expect(cloned).not.toBe(original);
        });
    });

    describe('removeDuplicates', () => {
        it('should remove duplicate values', () => {
            expect(removeDuplicates([1, 2, 2, 3, 3, 3])).toEqual([1, 2, 3]);
            expect(removeDuplicates(['a', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
        });

        it('should handle empty array', () => {
            expect(removeDuplicates([])).toEqual([]);
        });
    });

    describe('groupBy', () => {
        it('should group array elements by key', () => {
            const users = [
                { name: 'John', age: 25 },
                { name: 'Jane', age: 25 },
                { name: 'Bob', age: 30 },
            ];

            const grouped = groupBy(users, (user) => user.age);
            expect(grouped[25]).toHaveLength(2);
            expect(grouped[30]).toHaveLength(1);
        });

        it('should handle empty array', () => {
            expect(groupBy([], (x) => x)).toEqual({});
        });
    });
});
