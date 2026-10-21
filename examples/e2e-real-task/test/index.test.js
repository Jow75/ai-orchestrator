import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { add, multiply, factorial } from '../src/mathUtils.js';

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
});
