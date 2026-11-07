// Case D: values from JSON, from unknown through a checked cast, and plain records.
interface Point { x: number; y: number; norm(): number }
class P implements Point { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } norm(): number { return Math.abs(this.x) + Math.abs(this.y); } }
interface Tagged { tag: string; size: number }
class Box implements Tagged { tag = "box"; size = 3; }
function sizeOf(t: Tagged): string { return `${t.tag}:${t.size}`; }
const parsed = JSON.parse('{"tag":"json","size":5}') as Tagged;
const fromUnknown: unknown = { tag: "unk", size: 6 };
const items: Tagged[] = [new Box(), parsed, fromUnknown as Tagged, { tag: "lit", size: 1 }];
console.log(items.map(sizeOf).join(" "));
console.log(items[0] instanceof Box, items[1] instanceof Box, JSON.stringify(items[1]), Object.keys(items[3]!).join(","));
items[1]!.size = 50;
console.log(parsed.size, items[1] === parsed);
const pts: Point[] = [new P(1, -2), { x: 3, y: 4, norm() { return 7; } }];
console.log(pts.map((p) => p.norm()).join(","), pts[0] instanceof P, pts[1] instanceof P);
try {
  const bad = JSON.parse('{"x":1}') as Point;
  console.log(bad.norm());
} catch (e) {
  console.log(e instanceof TypeError);
}
// A typed callback that untyped code calls, with an instance and with a plain object.
interface Sink { put(value: number): number }
class Sum implements Sink { total = 0; put(value: number): number { this.total += value; return this.total; } }
const feed = (sink: Sink): number => sink.put(2) + sink.put(3);
const untyped: any = feed;
console.log(untyped(new Sum()), untyped({ put: (value: number) => value * 10 }));
const registry: Record<string, (...args: any[]) => unknown> = {};
registry["feed"] = feed;
console.log(registry["feed"]!(new Sum()), registry["feed"]!({ put: () => 1 }));
