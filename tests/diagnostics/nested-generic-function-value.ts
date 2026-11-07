// A generic `function` declared inside another function compiles through the
// function-scoped generic machinery, so CALLS work. Taking it as a VALUE is
// refused: each call of the enclosing function makes a new function object in
// JavaScript, while the compiled instances are shared module functions.
function host(): (x: number) => number {
  function identity<T>(value: T): T {
    return value;
  }
  const call = identity(1);
  console.log(call);
  return identity;
}
console.log(host()(2));
