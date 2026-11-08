// Object.assign onto a native object held in an untyped value (a Map, a Set,
// a RegExp, a URL, a WeakMap, a promise, a Date), from untyped sources: the
// call answers the same object and the program goes on. Nothing here reads
// a copied member back; what is pinned is that the copy itself does not
// stop a program whose object keeps working as what it is.

const extra: any = { crew: ["ana", "li"] };
const parsed = JSON.parse('{"dock":4,"notes":["cold"]}');

function label(target: any, source: any): any {
  return Object.assign(target, source);
}

const stock: any = new Map<string, number>([["bolt", 3]]);
const stocked = Object.assign(stock, extra);
console.log(stocked === stock, stocked instanceof Map, stock.get("bolt"), stock.size);

const seen: any = new Set<string>(["a"]);
const marked = label(seen, parsed);
console.log(marked === seen, marked instanceof Set, seen.has("a"), seen.size);

const pattern: any = /b+/;
console.log(Object.assign(pattern, { 0: "z" }) === pattern, pattern.test("abba"));

const place: any = new URL("https://example.com/yard?gate=2");
console.log(label(place, extra) === place, place.pathname, place.searchParams.get("gate"));

const weak: any = new WeakMap<object, number>();
console.log(Object.assign(weak, parsed) === weak, typeof weak);

const due: any = new Date(86400000);
console.log(label(due, { marks: 1, lane: "b" }) === due, due.getTime(), due instanceof Date);

const later: any = Promise.resolve(7);
const same = Object.assign(later, extra) === later;
later.then((value: number) => {
  console.log(same, value);
});
