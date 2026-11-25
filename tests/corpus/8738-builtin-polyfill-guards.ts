// Polyfills of built-in members Node 24 already has: every guard below is
// false there, so the polyfill never runs and the built-in answers. A
// compiled executable decides the guard the same way (existing members of
// built-in objects cannot change), and the write it guards is not refused.
let ran = 0;

if (!Array.prototype.at) {
  Array.prototype.at = function <T>(this: T[], _index: number): T | undefined {
    ran++;
    return undefined;
  };
}
if (typeof Object.hasOwn !== "function") {
  Object.hasOwn = ((_object: object, _key: PropertyKey): boolean => {
    ran++;
    return false;
  }) as typeof Object.hasOwn;
}
if (!("flat" in Array.prototype)) {
  (Array.prototype as { flat: unknown }).flat = function (): unknown[] {
    ran++;
    return [];
  };
}
if (Array.prototype.findLast === undefined) {
  Array.prototype.findLast = function (): undefined {
    ran++;
    return undefined;
  } as typeof Array.prototype.findLast;
}
if (typeof String.prototype.padStart === "undefined") {
  String.prototype.padStart = function (this: string): string {
    ran++;
    return "polyfill";
  };
}
if (typeof Promise.allSettled !== "function" || !Array.prototype.includes) {
  Math.trunc = (): number => {
    ran++;
    return 0;
  };
} else {
  console.log("else arm runs");
}
// A guard with an operand that runs for its effects: the operand runs, and
// the polyfill behind the guard still never does.
const effects: string[] = [];
function effect(label: string, answer: boolean): boolean {
  effects.push(label);
  return answer;
}
if (effect("and", true) && !Array.prototype.at) {
  Array.prototype.at = function <T>(this: T[], _index: number): T | undefined {
    ran++;
    return undefined;
  };
}
if (!Array.prototype.includes && effect("never", true)) {
  Array.prototype.at = function <T>(this: T[], _index: number): T | undefined {
    ran++;
    return undefined;
  };
}
console.log(effects.join(","));
// The spelling without a guard statement: a logical assignment that never
// assigns. (`X.m = X.m || f` does assign, the member's own value; in strict
// code, which this module is, it lowers as the assignment it is:
// builtin-polyfill-keep-value-assignment.mjs.)
(Array.prototype as { includes: unknown }).includes ??= function (): boolean {
  ran++;
  return false;
};
(Number as { isFinite: unknown }).isFinite ||= function (): boolean {
  ran++;
  return false;
};

const xs: number[] = [1, 2, 3];
console.log(xs.at(-1), Object.hasOwn({ a: 1 }, "a"), [[1], [2]].flat().length);
console.log(
  xs.findLast((x) => x < 3),
  "a".padStart(3, "-"),
  Math.trunc(1.9),
);
console.log("  a".trimStart(), xs.includes(2), Number.isFinite(1), ran);

// State the runtime models stays assignable.
const limit = Error.stackTraceLimit;
Error.stackTraceLimit = 3;
console.log(Error.stackTraceLimit);
Error.stackTraceLimit = limit;
