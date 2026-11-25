// inspect with showHidden prints a RegExp's own `[lastIndex]` entry before
// its other properties, and the number styling that reads
// inspect.styles.number runs program code while the render still holds a
// borrowed property. The RegExp sits in a Set so the inspect reaches its
// renderer through the collection; the accessor deletes the RegExp's own
// property while the render is midway through it, and the render must have
// copied what it prints.
import { inspect } from "node:util";

const styles = inspect.styles;
const pattern = /a/;
/** @type {any} */
const dynamic = pattern;
pattern.extra = { id: 1 };
const set = new Set([pattern]);

Object.defineProperty(styles, "number", {
  configurable: true,
  get() {
    dynamic.extra = { id: 2 };
    return "yellow";
  },
});

const text = inspect(set, { colors: true, showHidden: true });
console.log("regexp", typeof text, text.length > 0);
