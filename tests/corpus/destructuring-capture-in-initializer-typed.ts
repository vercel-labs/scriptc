// Typed closures inside a destructuring declaration's own initializer read
// the names it binds: tuple, rest, default, nested and object-rest patterns
// (the untyped forms and the early read are in
// destructuring-capture-in-initializer.cjs). A builtin alias read before its
// destructuring (`const { EOL } = os`) keeps its own resolution.
import * as os from "node:os";

function later<T>(f: () => void, value: T): T {
  setTimeout(f, 2);
  return value;
}

function patterns(): void {
  const [count, label] = later(() => console.log("tuple", count, label), [2, "two"] as [number, string]);
  const [head, ...rest] = later(() => console.log("rest", head, rest), [1, 2, 3]);
  const { size = 5 } = later(() => console.log("default", size), {} as { size?: number });
  const {
    outer: { inner },
  } = later(() => console.log("nested", inner), { outer: { inner: "deep" } });
  const { ...all } = later(() => console.log("object rest", JSON.stringify(all)), { p: 1, q: 2 });
}

function lineEnd(): string {
  const read = () => EOL;
  const { EOL } = os;
  return read();
}

patterns();
console.log(JSON.stringify(lineEnd()));
