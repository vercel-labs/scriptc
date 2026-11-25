// console.dir with showHidden: Node's dir is inspect with customInspect
// off, and the hidden own entries — an array's [length], non-enumerable and
// symbol keys, a typed array's extras — render through the value's
// checked-dynamic view. The layout options (depth, sorted, breakLength)
// still apply, and dir without the option keeps its plain rendering.
const sym = Symbol("s");
const arr: any = [1, 2];
arr.extra = 3;
Object.defineProperty(arr, "hidden", { value: 4, enumerable: false });
console.dir(arr, { showHidden: true });

const obj: any = { x: 1 };
Object.defineProperty(obj, "h", { value: 2, enumerable: false });
console.dir(obj, { showHidden: true });

console.dir({ outer: { inner: { deep: 1 } }, list: arr }, { showHidden: true, depth: 1 });
console.dir({ a: { b: [1, [2]] } }, { showHidden: true, depth: null });

const u8: any = new Uint8Array([1, 2]);
u8.tag = "t";
console.dir(u8, { showHidden: true });

console.dir(arr);
console.dir(obj, { showHidden: false });
console.dir({ a: 1, [sym]: 2 }, { showHidden: true });
console.dir({ a: 1, [sym]: 2 });

const map = new Map<number, number>([[1, 2]]);
console.dir(map, { showHidden: true });
console.dir(map);

const set = new Set<number>([1]);
console.dir(set, { showHidden: true });

class Meter {
  v = 1;
}
const meter: any = new Meter();
Object.defineProperty(meter, "hid", { value: 9, enumerable: false });
console.dir(meter, { showHidden: true });
console.dir(meter);

console.dir(arr, { showHidden: true, sorted: true });
console.dir({ s: "x".repeat(40) }, { showHidden: true, breakLength: 30 });
