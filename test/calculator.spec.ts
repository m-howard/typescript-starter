/**
 * Tests for the Calculator service
 */

import { Calculator } from '../src/services/calculator';

describe('Calculator', () => {
  let calculator: Calculator;

  beforeEach(() => {
    calculator = new Calculator();
  });

  describe('add', () => {
    it('should add two positive numbers', () => {
      expect(calculator.add(2, 3)).toBe(5);
    });

    it('should add negative numbers', () => {
      expect(calculator.add(-2, -3)).toBe(-5);
    });

    it('should add zero', () => {
      expect(calculator.add(5, 0)).toBe(5);
    });
  });

  describe('subtract', () => {
    it('should subtract two numbers', () => {
      expect(calculator.subtract(5, 3)).toBe(2);
    });

    it('should handle negative results', () => {
      expect(calculator.subtract(3, 5)).toBe(-2);
    });
  });

  describe('multiply', () => {
    it('should multiply two numbers', () => {
      expect(calculator.multiply(4, 5)).toBe(20);
    });

    it('should handle zero multiplication', () => {
      expect(calculator.multiply(5, 0)).toBe(0);
    });

    it('should handle negative multiplication', () => {
      expect(calculator.multiply(-3, 4)).toBe(-12);
    });
  });

  describe('divide', () => {
    it('should divide two numbers', () => {
      expect(calculator.divide(10, 2)).toBe(5);
    });

    it('should handle decimal results', () => {
      expect(calculator.divide(7, 2)).toBe(3.5);
    });

    it('should throw error for division by zero', () => {
      expect(() => calculator.divide(5, 0)).toThrow('Division by zero is not allowed');
    });
  });

  describe('power', () => {
    it('should calculate power correctly', () => {
      expect(calculator.power(2, 3)).toBe(8);
    });

    it('should handle power of zero', () => {
      expect(calculator.power(5, 0)).toBe(1);
    });

    it('should handle negative exponents', () => {
      expect(calculator.power(2, -2)).toBe(0.25);
    });
  });

  describe('sqrt', () => {
    it('should calculate square root', () => {
      expect(calculator.sqrt(9)).toBe(3);
    });

    it('should handle zero', () => {
      expect(calculator.sqrt(0)).toBe(0);
    });

    it('should throw error for negative numbers', () => {
      expect(() => calculator.sqrt(-1)).toThrow('Cannot calculate square root of negative number');
    });
  });

  describe('percentage', () => {
    it('should calculate percentage correctly', () => {
      expect(calculator.percentage(100, 50)).toBe(50);
    });

    it('should handle zero percentage', () => {
      expect(calculator.percentage(100, 0)).toBe(0);
    });
  });

  describe('isEven', () => {
    it('should return true for even numbers', () => {
      expect(calculator.isEven(4)).toBe(true);
      expect(calculator.isEven(0)).toBe(true);
    });

    it('should return false for odd numbers', () => {
      expect(calculator.isEven(3)).toBe(false);
      expect(calculator.isEven(1)).toBe(false);
    });
  });

  describe('isOdd', () => {
    it('should return true for odd numbers', () => {
      expect(calculator.isOdd(3)).toBe(true);
      expect(calculator.isOdd(1)).toBe(true);
    });

    it('should return false for even numbers', () => {
      expect(calculator.isOdd(4)).toBe(false);
      expect(calculator.isOdd(0)).toBe(false);
    });
  });

  describe('abs', () => {
    it('should return absolute value of positive number', () => {
      expect(calculator.abs(5)).toBe(5);
    });

    it('should return absolute value of negative number', () => {
      expect(calculator.abs(-5)).toBe(5);
    });

    it('should return zero for zero', () => {
      expect(calculator.abs(0)).toBe(0);
    });
  });
});
