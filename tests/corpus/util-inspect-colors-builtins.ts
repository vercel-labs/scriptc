// util.inspect with colors, over the values whose colored rendering the
// runtime produces natively: an ArrayBuffer's [Uint8Contents] takes the
// 'special' style and its [byteLength] the 'string' and 'number' styles, a
// DataView's extra properties the same, a WeakMap's and WeakSet's
// "<items unknown>" the 'special' style, URL and URLSearchParams their
// strings, a class declared `extends Date` the whole "Name ISO" head until
// it has a property, and the built-in iterators their entries. The same
// renderings reach formatWithOptions' %o and %O.
import * as util from "node:util";

const colors = { colors: true };
const show = (label: string, value: unknown, options: object = colors): void => {
  console.log(`${label}: ${util.inspect(value, options)}`);
};

show("array buffer", new ArrayBuffer(3));
show("array buffer empty", new ArrayBuffer(0));
show("array buffer truncated", new ArrayBuffer(6), { colors: true, maxArrayLength: 2 });
show("shared array buffer", new SharedArrayBuffer(2));
show("data view", new DataView(new ArrayBuffer(4)));
show("data view offset", new DataView(new ArrayBuffer(8), 2, 4));
show("weak map", new WeakMap());
show("weak set", new WeakSet());
show("url", new URL("https://user:pw@example.com:8080/a?b=1#h"));
show("search params", new URLSearchParams("a=1&b=2"));
show("search params empty", new URLSearchParams());
show(
  "search params long",
  new URLSearchParams(
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=1&b=2",
  ),
);
show("typed array hidden", new Uint8Array([1, 2]), { colors: true, showHidden: true });

function* numbers(): Generator<number> {
  yield 1;
}
show("generator", numbers());
show("generator nested", [numbers()]);

class Day extends Date {}
show("date subclass", new Day(0));
show("date subclass nested", { day: new Day(0) });
const withField = new Day(0);
(withField as unknown as { extra: number }).extra = 1;
show("date subclass with field", withField);

show("map", new Map<string, number[]>([["k", [1, 2]]]));
show("map iterator", new Map([["k", 1]]).keys());
show("map entries", new Map([["k", 1]]).entries());
show("set iterator", new Set(["a"]).values());

class Box {
  value: number;
  constructor(value: number) {
    this.value = value;
  }
  [util.inspect.custom](): object {
    return { boxed: this.value };
  }
}
show("custom", new Box(2));
show("blob", new Blob(["x"], { type: "text/plain" }));
show("text encoder", new TextEncoder());
show("text decoder", new TextDecoder());

console.log(`format o data view: ${util.formatWithOptions({ colors: true }, "%o", new DataView(new ArrayBuffer(2)))}`);
console.log(`format O url: ${util.formatWithOptions({ colors: true }, "%O", new URL("https://x.test/"))}`);
console.log(`format joined: ${util.formatWithOptions({ colors: true }, "x", new URLSearchParams("a=1"), 2)}`);
