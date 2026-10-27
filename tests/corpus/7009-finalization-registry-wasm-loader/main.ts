// A package loaded the way wasm-bindgen's web target loads: FinalizationRegistry
// guards and registrations run at load and in constructors, and free()
// unregisters. Registrations keep their bookkeeping; cleanup
// callbacks run at times only the garbage collector decides, so this program
// prints nothing from them, as under Node.
import { Counter, initSync, released_total } from "counter-wasm";

// (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
const bytes = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01,
  0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09,
  0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);
initSync(bytes);

const a = new Counter(10);
a.increment(5);
const b = new Counter(2);
b.increment(1);
console.log(a.value, b.value);
b.free();
a.free();
console.log(a.value, released_total());

const registry = new FinalizationRegistry<string>((held) => console.log("cleanup", held));
const token = {};
registry.register({}, "first", token);
registry.register({ id: 2 }, "second", token);
registry.register({ id: 3 }, "third");
console.log(registry.unregister(token), registry.unregister(token), registry.unregister({}));
try {
  new FinalizationRegistry<object>(() => {}).register(token, token);
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}
console.log(typeof FinalizationRegistry, registry instanceof FinalizationRegistry);
// A name the registry does not have reads as undefined.
console.log((registry as any).label);
console.log(Object.prototype.toString.call(registry), registry);
