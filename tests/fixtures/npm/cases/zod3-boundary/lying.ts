// A declaration that lies about a value: the boundary check throws a
// TypeError naming the path (native only; Node does not check). Run by
// tests/harness/decl-boundary.test.ts.
import { z } from "zod";

const Liar = z.custom<{ name: string; n: number }>(() => true);
try {
  const v = Liar.parse({ name: "x", n: "not a number" });
  console.log("liar", v.n + 1);
} catch (e) {
  console.log("liar threw", e instanceof TypeError, (e as Error).message);
}
const Frozen = z.custom<{ tags: string[] }>();
try {
  const f = Frozen.parse(Object.freeze(JSON.parse('{"tags":["a"]}')));
  console.log("frozen", f.tags.length);
} catch (e) {
  console.log("frozen threw", (e as Error).message);
}
// A non-enumerable key crosses and stays non-enumerable; a read-only key
// and an accessor have no native form yet and are refused by name.
const Tagged = z.custom<{ id: string; n: number }>();
function tagged(descriptor: PropertyDescriptor): unknown {
  const o = JSON.parse('{"n":1}');
  Object.defineProperty(o, "id", descriptor);
  return o;
}
try {
  const h = Tagged.parse(tagged({ value: "a", enumerable: false, writable: true, configurable: true }));
  console.log("hidden", h.id, Object.keys(h).join(","), JSON.stringify(h));
} catch (e) {
  console.log("hidden threw", (e as Error).message);
}
try {
  const r = Tagged.parse(tagged({ value: "a", enumerable: true, writable: false, configurable: true }));
  console.log("read-only", r.id);
} catch (e) {
  console.log("read-only threw", (e as Error).message);
}
try {
  const g = Tagged.parse(tagged({ get: () => "a", enumerable: true, configurable: true }));
  console.log("accessor", g.id);
} catch (e) {
  console.log("accessor threw", (e as Error).message);
}
// An index-signature record keeps the keys its type does not declare in a
// map, which holds no attributes: a non-enumerable key has no place there
// and the boundary refuses it rather than list it as an ordinary one.
const Bag = z.custom<{ [key: string]: number }>();
try {
  const b = Bag.parse(tagged({ value: 2, enumerable: false, writable: true, configurable: true }));
  console.log("index", JSON.stringify(b), Object.keys(b).join(","));
} catch (e) {
  console.log("index threw", (e as Error).message);
}
