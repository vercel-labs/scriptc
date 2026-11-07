// Immutable aliases of overloaded DECLARATIONS project back onto the one
// implementation and resolve each call per site. An overloaded TYPE LITERAL
// value whose overloads join is one stored function (tests/corpus/
// 8937-overload-set-values); one whose overloads do not join (a void result
// beside a value result) has no single compiled signature and stays fenced.

function pick(x: "a"): string;
function pick(x: "b"): number;
function pick(x: string): string | number {
  return x === "a" ? "A" : 1;
}
const stored = pick;
console.log(stored("a"));

// The value arrives through a cast, not an ambient declare (a declare-rooted
// chain would compile to Node's ReferenceError at the root instead).
function attach(on: { (event: "exit", code: number): void; (event: "data"): string }): void {
  on("exit", 0);
}
attach(((() => "") as unknown) as { (event: "exit", code: number): void; (event: "data"): string });
