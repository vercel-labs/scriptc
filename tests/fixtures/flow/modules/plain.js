// No pragma: with `"flow": true` this module stays JavaScript, so
// `x < y > (z)` is two comparisons, not a Flow call with a type argument.
export function greet(name) {
  return "hello " + name;
}

export function between(x, y, z) {
  return x < y > (z);
}
