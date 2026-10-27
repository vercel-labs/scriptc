// Methods of JavaScript subclasses that call super, read from instances
// through computed keys, literal keys and as values, and called directly.
import { createRequire } from "node:module";

interface Lib {
  make(i: number): unknown;
  computed(value: unknown, name: string, arg: number): unknown;
  viaCall(value: unknown, name: string, arg: number): unknown;
  literal(value: unknown, arg: number): string;
  direct(value: unknown, arg: number): string;
}
const require = createRequire(import.meta.url);
const lib: Lib = require("./lib.cjs");

for (let i = 0; i < 8; i++) {
  const value = lib.make(i);
  console.log(
    i,
    lib.computed(value, "scale", 3),
    lib.computed(value, "plain", 3),
    lib.computed(value, "label", 0),
    lib.viaCall(value, "scale", 2),
    lib.viaCall(value, "label", 0),
  );
  console.log(i, lib.literal(value, 5), "|", lib.direct(value, 5));
}
