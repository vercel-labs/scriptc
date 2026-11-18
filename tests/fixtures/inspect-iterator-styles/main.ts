// util.inspect renders a Map or Set iterator's entries through the value
// renderer, which reads inspect.styles for every leaf it prints. A style
// accessor is program code: here it drains the very iterator being
// inspected, whose Set is owned by the iterator alone. The render must not
// keep reading the collection's memory after that reference is gone.
import { inspect } from "node:util";

const styles: any = (inspect as any).styles;
let iterator: any;

Object.defineProperty(styles, "number", {
  configurable: true,
  get(): string {
    for (;;) {
      if (iterator.next().done) break;
    }
    return "yellow";
  },
});

iterator = new Set([1, 2, 3]).values();
const text = inspect(iterator, { colors: true });
console.log("iterator", typeof text, text.length > 0);
