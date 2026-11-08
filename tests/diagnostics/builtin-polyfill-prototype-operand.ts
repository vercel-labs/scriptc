// A polyfill statement whose feature test reads a built-in member through the
// prototype of a value made for it is not a statement that does nothing:
// making the value runs. It lowers as any other statement, where the write
// it holds is refused when the program also uses the member natively. An
// object literal that names its prototype is not an `Object.prototype` object
// either, so its guard is not decided.
let calls = 0;
function note(label: string): number {
  calls++;
  console.log("note", label);
  return calls;
}

Object.getPrototypeOf([note("or")]).at ||
  (Array.prototype.at = function () {
    return undefined;
  });

Object.getPrototypeOf([note("nullish")]).includes ??
  (Array.prototype.includes = function () {
    return false;
  });

if (!Object.getPrototypeOf({ __proto__: null }).toString) {
  Object.prototype.toString = function () {
    return "replaced";
  };
}

console.log(calls, [1, 2, 3].at(-1), [1].includes(1), String({}));
