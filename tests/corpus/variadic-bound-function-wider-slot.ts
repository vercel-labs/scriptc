// A bound function stored where a narrower function type is expected and
// handed to callers that pass more arguments: the bound callable receives
// them, and a variadic function behind it observes every one.
function resolve(a: string, b: number): void {
  console.log("resolve", a, b);
}
const bound: () => void = resolve.bind(null, "x", 1);
function take(cb: (value: string) => void): void {
  cb("ignored");
}
take(bound);
[1, 2].forEach(bound);

function logAll(label: string, ...rest: unknown[]): void {
  console.log("logAll", label, rest.length, rest.map(String).join(","));
}
const boundVariadic: () => void = logAll.bind(null, "L");
[3, 4].forEach(boundVariadic);
boundVariadic();

interface Props {
  onDone: (value: string) => void;
}
function run(p: Props): void {
  p.onDone("late");
}
const props: Props = { onDone: resolve.bind(null, "y", 2) };
run(props);

function maker(prefix: string, n: number): number {
  return prefix.length + n;
}
const boundNumber: () => number = maker.bind(null, "ab", 1);
console.log("map", [1, 2].map(boundNumber).join(","));
