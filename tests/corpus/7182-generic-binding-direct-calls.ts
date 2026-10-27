// Generic arrow bindings whose uses all run after the declaration: later
// statements, closures created after it, later declarators, recursion and
// function declarations that only later code calls. These calls go
// straight to the compiled instances.
const pair = <T>(x: T): [T, T] => [x, x];
const doubled = pair(2), labels = pair("a");
console.log(doubled.join(","), labels.join(","));

function useLater(): string {
  return pair(true).join(",");
}
console.log(useLater());

export function exported(n: number): number {
  return pair(n)[0] + 1;
}
console.log(exported(4));

function local(): string {
  var twice = <T extends number>(x: T): number => x * 2;
  const call = (): number => twice(4);
  const depth = <T>(xs: T[], n: number): number => (n <= 0 ? xs.length : depth(xs, n - 1) + 1);
  return `${twice(1)} ${call()} ${depth([1, 2], 3)} ${helper()}`;

  function helper(): string {
    return pair("h").join("");
  }
}
console.log(local());

function loop(): string[] {
  const out: string[] = [];
  const later: (() => string)[] = [];
  for (let i = 0; i < 3; i++) {
    const tag = <T>(x: T): string => `#${String(x)}`;
    later.push(() => tag("late"));
    out.push(tag(i * 10));
  }
  for (const f of later) out.push(f());
  return out;
}
console.log(loop().join(" "));
