// A function as the descriptor map: its own enumerable properties are the
// entries, and each value is read with the function as `this`, not with the
// table the properties live in.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }

const log: string[] = [];
function named(a: number, b: number): number { return a + b; }
const map: any = named;
Object.defineProperty(map, "first", {
  enumerable: true,
  configurable: true,
  get() {
    const self: any = this;
    log.push("first:" + String(self === map));
    return { value: 1, enumerable: true, writable: true };
  },
});
Object.defineProperty(map, "hidden", { value: { value: 9 }, enumerable: false });
const target: any = {};
try {
  const same = Object.defineProperties(target, map);
  console.log(same === target, target.first, log.join("|"), Object.keys(target).join(","), Object.keys(map).join(","));
} catch (e) { console.log("failed:", msg(e)); }

const arrow: any = (x: number) => x + 1;
Object.defineProperty(arrow, "second", {
  enumerable: true,
  get() {
    const self: any = this;
    log.push("second:" + String(self === arrow));
    return { value: 2, enumerable: true };
  },
});
const other: any = {};
try {
  Object.defineProperties(other, arrow);
  console.log(other.second, log.join("|"));
} catch (e) { console.log("failed:", msg(e)); }

export {};
