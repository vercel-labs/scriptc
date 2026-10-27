// Generic arrow and function-expression bindings declared inside functions
// and methods that use nothing from the enclosing frame compile like
// module-scope bindings: each call instantiates them, they may call
// themselves and read module-scope bindings, and two functions may declare
// bindings of the same name.
function append(): void {
  const put = <T>(xs: T[], x: T): T[] => [...xs, x];
  console.log(put([1, 2], 3).join(","), put(["a"], "b").join(","));
}
append();

const LIMIT = 3;
function prepend(): void {
  const put = <T>(xs: T[], x: T): T[] => [x, ...xs];
  console.log(put([1], 0).join(","));
  const twice = function <T>(x: T): T[] {
    return [x, x];
  };
  console.log(twice("z").join(","), twice(7).length);
  const count = <T>(xs: T[], n: number): number => (n <= 0 ? xs.length : 1 + count(xs, n - 1));
  console.log(count([1], 3));
  const firstFew = <T>(xs: T[]): T[] => xs.slice(0, LIMIT);
  console.log(firstFew([1, 2, 3, 4]).join(","), firstFew(["p", "q"]).join(","));
}
prepend();

class Box {
  run(): string {
    const wrap = <T>(x: T): { v: T } => ({ v: x });
    return JSON.stringify([wrap(1), wrap("s"), wrap([true])]);
  }
}
console.log(new Box().run());
