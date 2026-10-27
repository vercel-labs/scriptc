// A DataView reached through `unknown` keeps its own behavior: Node's
// `DataView { [byteLength], [byteOffset], [buffer] }` inspection, the
// "[object DataView]" string and tag, no length or indexed elements, and
// no typed array methods.
import { inspect } from "node:util";

function show(label: string, value: unknown): void {
  console.log(label, value);
}

const buf = new ArrayBuffer(8);
const whole = new DataView(buf);
whole.setUint16(0, 0x1234);
show("whole", whole);
show("offset", new DataView(buf, 2, 4));
show("empty", new DataView(new ArrayBuffer(0)));
show("big", new DataView(new ArrayBuffer(120)));
show("nested", { view: new DataView(buf, 6) });
show("shared", new DataView(new SharedArrayBuffer(2)));

const u: unknown = whole;
console.log(inspect({ a: { u } }, { depth: 1 }), inspect([u], { depth: 0 }));
console.log(String(u), Object.prototype.toString.call(u), `${u}`);

const view: unknown = new DataView(buf, 1);
const o = view as { [k: string]: unknown };
console.log(o.length, o[0], o.byteLength, o.byteOffset);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loose = view as any;
console.log(loose.toString(), loose.valueOf() === view);
for (const method of ["at", "join", "fill", "slice"]) {
  try {
    loose[method](0);
  } catch (e) {
    console.log(method, (e as Error).name);
  }
}
console.log(view instanceof DataView, ArrayBuffer.isView(view));
// A typed array through `unknown` is unaffected.
const bytes: unknown = new Uint8Array([1, 2]);
console.log(bytes, String(bytes), `${bytes}`, (bytes as Uint8Array).length);
