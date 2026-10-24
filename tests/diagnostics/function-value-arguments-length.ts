// `arguments.length` has no single value when the calls pass varying
// counts: a function expression or declaration passed where the expected
// function type has optional or rest parameters. Methods and nested
// functions used as values, and arrows inside a function used as a value,
// keep the fence.
const replaced = "a-b".replace(/-/, function (match) {
  return String(arguments.length) + match;
});
function call(f: (a: number, b?: number) => number): number {
  return f(1, 2);
}
const counted = call(function (a) {
  return arguments.length + a;
});
function offset(value: number): number {
  return value + arguments.length;
}
const offsets = call(offset);
class Scale {
  static by(value: number): number {
    return value * arguments.length;
  }
}
const scaled = [2].map(Scale.by);
function outer(): number[] {
  function inner(value: number): number {
    return value + arguments.length;
  }
  return [1].map(inner);
}
function deferred(value: number): number {
  const read = (): number => arguments.length;
  return value + read();
}
const late = [1].map(deferred);
export { replaced, counted, offsets, scaled, outer, late };
