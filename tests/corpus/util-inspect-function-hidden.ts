// util.inspect of function values with showHidden: Node lists every own
// key — the built-in length, name and prototype first, then the properties
// the program added, enumerable ones bare and hidden ones bracketed, and
// the own symbols last. A function in ESM (as this program is) carries no
// own arguments or caller. The prototype's constructor points back at the
// function, so the dump opens with Node's `<ref *1>`, and the tag itself
// takes color only when nothing follows it.
import * as util from "node:util";

const show = (label: string, value: any, options?: any): void => {
  console.log(`${label}: ${util.inspect(value, options)}`);
};

function named(a: number, b: string): void {}
const namedAny: any = named;
namedAny.extra = 1;
Object.defineProperty(namedAny, "hidden", { value: 2, enumerable: false });
namedAny[Symbol("s")] = 3;
show("named", named, { showHidden: true });
show("named plain", named);
show("named nested", { f: named }, { showHidden: true });
show("named depth0", named, { showHidden: true, depth: 0 });
show("named nested depth1", { f: named }, { showHidden: true, depth: 1 });

const arrow: any = (x: number) => x;
arrow.tag = "t";
show("arrow", arrow, { showHidden: true });
show("arrow plain", arrow);

const method: any = { m() { return 1; } }.m;
show("method", method, { showHidden: true });

const bound: any = named.bind(null, 1);
show("bound", bound, { showHidden: true });

function selfFn(): void {}
const selfAny: any = selfFn;
selfAny.me = selfFn;
show("self", selfFn, { showHidden: true });

const ctor: any = function P() {};
show("constructor", ctor, { showHidden: true });

const broken: any = function g() {};
Object.defineProperty(broken, "bad", {
  get() { throw new Error("nope"); },
  enumerable: true,
  configurable: true,
});
show("throwing getter", broken, { showHidden: true });

show("colors plain", () => 1, { colors: true });
show("colors with entries", arrow, { colors: true });
show("colors hidden", arrow, { colors: true, showHidden: true });

console.log(`format o: ${util.format("%o", named)}`);
console.log(`format O: ${util.format("%O", named)}`);
console.log(`format plain: ${util.format("%o", arrow)}`);
console.log(`formatWithOptions: ${util.formatWithOptions({ showHidden: true }, "%o", named)}`);
console.log(`formatWithOptions colors: ${util.formatWithOptions({ colors: true }, "%o", arrow)}`);
