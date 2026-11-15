// util.isDeepStrictEqual over the built-in object families: a Date compares
// by its time (an invalid date equals another invalid one), a RegExp by
// source, flags and lastIndex, a Map or Set by its entries in any order, a
// URL by its href, a URLSearchParams by nothing (it has no own enumerable
// properties), and a WeakMap or WeakSet only by identity. Typed arrays and
// Buffers compare by their bytes once the prototype gate passes, which the
// third argument turns off; the entries of a collection that points at
// itself terminate.
import { isDeepStrictEqual as equal } from "node:util";

const show = (label: string, value: boolean): void => {
  console.log(`${label}: ${value}`);
};

show("dates", equal(new Date(1_000), new Date(1_000)));
show("dates differ", equal(new Date(1_000), new Date(2_000)));
show("date invalid pair", equal(new Date(NaN), new Date(NaN)));
show("date vs record", equal(new Date(1_000) as any, {}));
show("dates nested", equal({ when: new Date(1_000) }, { when: new Date(1_000) }));

const regex = /a(b)c/gi;
show("regex", equal(/a(b)c/gi, /a(b)c/ig));
show("regex source", equal(/a(b)c/g, /a(b)d/g));
show("regex flags", equal(/a(b)c/g, /a(b)c/i));
show("regex lastIndex", equal(regex, /a(b)c/gi));
const moved = /a(b)c/gi;
moved.lastIndex = 2;
show("regex moved", equal(regex, moved));
show("regex escaped", equal(/\//, new RegExp("/")));

show("maps", equal(new Map([["a", 1], ["b", 2]]), new Map([["b", 2], ["a", 1]])));
show("maps value", equal(new Map([["a", 1]]), new Map([["a", 2]])));
show("maps size", equal(new Map([["a", 1]]), new Map([["a", 1], ["b", 2]])));
show("maps object keys", equal(new Map([[{ k: 1 }, "v"]]), new Map([[{ k: 1 }, "v"]])));
show("maps nested", equal({ m: new Map([["k", new Set([1, 2])]]) }, { m: new Map([["k", new Set([2, 1])]]) }));

show("sets", equal(new Set([1, 2, 3]), new Set([3, 1, 2])));
show("sets objects", equal(new Set([{ a: 1 }, { a: 2 }]), new Set([{ a: 2 }, { a: 1 }])));
show("sets differ", equal(new Set([{ a: 1 }]), new Set([{ a: 2 }])));
show("set vs array", equal(new Set([1]) as any, [1]));

const selfMap = new Map<string, any>();
selfMap.set("self", selfMap);
const otherMap = new Map<string, any>();
otherMap.set("self", otherMap);
show("maps cycle", equal(selfMap, otherMap));
const selfSet = new Set<any>();
selfSet.add(selfSet);
const otherSet = new Set<any>();
otherSet.add(otherSet);
show("sets cycle", equal(selfSet, otherSet));

const url = new URL("https://example.test/a?q=1");
show("urls", equal(url, new URL("https://example.test/a?q=1")));
show("urls differ", equal(url, new URL("https://example.test/a?q=2")));
show("params", equal(new URLSearchParams("a=1&b=2"), new URLSearchParams("b=2&a=1")));
show("params entries ignored", equal(new URLSearchParams("a=1"), new URLSearchParams("a=2")));
show("params vs url", equal(new URL("https://example.test/?a=1").searchParams, new URLSearchParams("a=1")));

const weak = new WeakMap<object, number>();
show("weakmap", equal(weak, weak));
show("weakmap distinct", equal(weak, new WeakMap<object, number>()));
const weakSet = new WeakSet<object>();
show("weakset distinct", equal(weakSet, new WeakSet<object>()));

show("buffers", equal(Buffer.from([1, 2]), Buffer.from([1, 2])));
show("buffers differ", equal(Buffer.from([1, 2]), Buffer.from([1, 3])));
show("buffer vs view", equal(Buffer.from([1, 2]), new Uint8Array([1, 2])));
show("buffer vs view skip", equal(Buffer.from([1, 2]) as any, new Uint8Array([1, 2]) as any, true));
show("typed widths", equal(new Uint16Array([1, 2]), new Int16Array([1, 2])));

console.log("done");
