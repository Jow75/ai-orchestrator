import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { add, multiply, factorial, power, fibonacci } from '../src/mathUtils.js';

describe('Math Utilities — E2E Real Task', () => {
  describe('add()', () => {
    it('adds two positive numbers', () => {
      assert.equal(add(2, 3), 5);
    });

    it('adds negative and positive numbers', () => {
      assert.equal(add(-5, 10), 5);
    });

    it('adds zeroes correctly', () => {
      assert.equal(add(0, 0), 0);
    });

    it('throws TypeError if argument is not a number', () => {
      assert.throws(() => add('2', 3), TypeError);
      assert.throws(() => add(2, null), TypeError);
    });
  });

  describe('multiply()', () => {
    it('multiplies two numbers', () => {
      assert.equal(multiply(4, 5), 20);
    });

    it('handles negative numbers', () => {
      assert.equal(multiply(-3, 7), -21);
      assert.equal(multiply(-4, -5), 20);
    });

    it('multiplies by zero', () => {
      assert.equal(multiply(100, 0), 0);
    });

    it('throws TypeError if argument is not a number', () => {
      assert.throws(() => multiply('x', 5), TypeError);
    });
  });

  describe('factorial()', () => {
    it('computes 0! = 1 and 1! = 1', () => {
      assert.equal(factorial(0), 1);
      assert.equal(factorial(1), 1);
    });

    it('computes standard factorials', () => {
      assert.equal(factorial(5), 120);
      assert.equal(factorial(6), 720);
      assert.equal(factorial(10), 3628800);
    });

    it('throws RangeError on negative inputs', () => {
      assert.throws(() => factorial(-1), RangeError);
      assert.throws(() => factorial(-10), RangeError);
    });

    it('throws TypeError on non-integers or non-numbers', () => {
      assert.throws(() => factorial(3.5), TypeError);
      assert.throws(() => factorial('5'), TypeError);
      assert.throws(() => factorial(null), TypeError);
    });
  });

  describe('power()', () => {
    it('computes positive integer powers', () => {
      assert.equal(power(2, 3), 8);
      assert.equal(power(10, 4), 10000);
    });

    it('computes power with 0 exponent', () => {
      assert.equal(power(5, 0), 1);
      assert.equal(power(-3, 0), 1);
    });

    it('computes negative exponents', () => {
      assert.equal(power(2, -1), 0.5);
      assert.equal(power(4, -2), 0.0625);
    });

    it('computes fractional exponents', () => {
      assert.equal(power(9, 0.5), 3);
      assert.equal(power(27, 1 / 3), 3);
    });

    it('throws RangeError when raising 0 to negative power', () => {
      assert.throws(() => power(0, -2), RangeError);
    });

    it('throws TypeError on invalid inputs', () => {
      assert.throws(() => power('2', 3), TypeError);
      assert.throws(() => power(2, NaN), TypeError);
      assert.throws(() => power(NaN, 2), TypeError);
    });
  });

  describe('fibonacci()', () => {
    it('computes base cases F(0)=0 and F(1)=1', () => {
      assert.equal(fibonacci(0), 0);
      assert.equal(fibonacci(1), 1);
    });

    it('computes standard Fibonacci numbers', () => {
      assert.equal(fibonacci(2), 1);
      assert.equal(fibonacci(3), 2);
      assert.equal(fibonacci(4), 3);
      assert.equal(fibonacci(5), 5);
      assert.equal(fibonacci(6), 8);
      assert.equal(fibonacci(10), 55);
      assert.equal(fibonacci(20), 6765);
    });

    it('throws RangeError on negative numbers', () => {
      assert.throws(() => fibonacci(-1), RangeError);
      assert.throws(() => fibonacci(-5), RangeError);
    });

    it('throws TypeError on non-integers or non-numbers', () => {
      assert.throws(() => fibonacci(2.5), TypeError);
      assert.throws(() => fibonacci('10'), TypeError);
      assert.throws(() => fibonacci(null), TypeError);
    });
  });
});
