/**
 * mathUtils.js — Math utility library for e2e-real-task.
 */

export function add(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') {
    throw new TypeError('Arguments must be numbers');
  }
  return a + b;
}

export function multiply(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') {
    throw new TypeError('Arguments must be numbers');
  }
  return a * b;
}

export function factorial(n) {
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new TypeError('Factorial argument must be an integer');
  }
  if (n < 0) {
    throw new RangeError('Factorial is not defined for negative numbers');
  }
  if (n === 0 || n === 1) {
    return 1;
  }
  let result = 1;
  for (let i = 2; i <= n; i++) {
    result *= i;
  }
  return result;
}

export function power(base, exponent) {
  if (typeof base !== 'number' || typeof exponent !== 'number' || Number.isNaN(base) || Number.isNaN(exponent)) {
    throw new TypeError('Base and exponent must be valid numbers');
  }
  if (base === 0 && exponent < 0) {
    throw new RangeError('Cannot raise 0 to a negative power');
  }
  return base ** exponent;
}

export function fibonacci(n) {
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new TypeError('Fibonacci argument must be an integer');
  }
  if (n < 0) {
    throw new RangeError('Fibonacci is not defined for negative numbers');
  }
  if (n === 0) return 0;
  if (n === 1) return 1;
  let prev = 0;
  let curr = 1;
  for (let i = 2; i <= n; i++) {
    const next = prev + curr;
    prev = curr;
    curr = next;
  }
  return curr;
}
