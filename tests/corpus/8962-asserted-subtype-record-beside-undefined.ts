// A record beside `undefined` asserted to a subtype with required members
// the record's own type lacks (`result as Routed` on `Reply | undefined`):
// the value is checked into the subtype member by member, and a value that
// came in as the subtype through the base-typed slot still has the members
// the base type does not declare.
interface Part {
  name: string;
  handle?(x: number): Reply | undefined;
  accept?(text: string): void;
}
interface Reply {
  handled?: boolean;
  capture?: boolean;
  focus?: boolean;
}
interface Origin {
  part: Part;
  x: number;
}
interface Routed extends Reply {
  handled: true;
  origin: Origin;
  focused?: Part;
}
function route(part: Part, x: number): Routed | undefined {
  const result = part.handle?.(x);
  if (!result) return undefined;
  if ("origin" in result) {
    const forwarded = result as Routed;
    return forwarded.focus && part.accept ? { ...forwarded, focused: part } : forwarded;
  }
  if (!result.handled && !result.capture && !result.focus) return undefined;
  return { ...result, handled: true, ...(result.focus ? { focused: part } : {}), origin: { part, x } };
}
class Leaf implements Part {
  name = "leaf";
  handle(x: number): Reply | undefined {
    return x > 0 ? { handled: true, focus: x > 5 } : undefined;
  }
  accept(_text: string): void {}
}
class Group implements Part {
  name = "group";
  readonly child: Part;
  constructor(child: Part) {
    this.child = child;
  }
  handle(x: number): Routed | undefined {
    return route(this.child, x);
  }
  accept(_text: string): void {}
}
const show = (r: Routed | undefined): string =>
  r ? `${r.origin.part.name}@${r.origin.x} ${r.focused?.name ?? "-"} ${r.handled} ${r.focus ?? "-"}` : "none";
const leaf = new Leaf();
console.log(show(route(leaf, 3)), "|", show(route(leaf, 9)), "|", show(route(leaf, 0)));
const group = new Group(leaf);
console.log(show(route(group, 3)), "|", show(route(group, 9)), "|", show(route(group, 0)));
console.log(show(route(new Group(group), 7)));

// The same assertion on a value a function returned through the base type.
interface Tagged extends Reply {
  handled: true;
  tag: { label: string; weight: number };
}
function produce(n: number): Reply | undefined {
  if (n === 0) return undefined;
  if (n > 5) {
    const tagged: Tagged = { handled: true, focus: n > 7, tag: { label: "t" + n, weight: n } };
    return tagged;
  }
  return { handled: n > 2 };
}
function read(n: number): string {
  const result = produce(n);
  if (!result) return "none";
  if ("tag" in result) {
    const tagged = result as Tagged;
    return `tag ${tagged.tag.label} ${tagged.tag.weight} ${tagged.focus ?? "-"} ${JSON.stringify(tagged)}`;
  }
  return `plain ${result.handled ?? "-"}`;
}
console.log([0, 3, 6, 9].map(read).join(" | "));

// The asserted value placed straight into a slot that also holds undefined.
function tagOf(n: number): Tagged | undefined {
  const result = produce(n);
  if (result === undefined) return undefined;
  return "tag" in result ? (result as Tagged) : undefined;
}
console.log(tagOf(0)?.tag.label ?? "-", tagOf(3)?.tag.label ?? "-", tagOf(8)?.tag.label, tagOf(8)?.focus);

// An array beside undefined asserted to an array of the subtype.
function batch(n: number): Reply[] | undefined {
  if (n === 0) return undefined;
  const out: Reply[] = [];
  for (let i = 0; i < n; i++) {
    const tagged: Tagged = { handled: true, tag: { label: "b" + i, weight: i } };
    out.push(tagged);
  }
  return out;
}
const tags = batch(3) as Tagged[];
console.log(tags.map((tagged) => `${tagged.tag.label}:${tagged.tag.weight}`).join(","), tags.length);

// A write through a member the asserted view shares with the value reaches
// the value, also when the source is a record beside undefined.
interface Meter {
  count: number;
}
interface Gauge {
  meter: Meter;
  label: string;
}
interface NotedGauge extends Gauge {
  note?: string;
}
function bump(source: Gauge | undefined): number {
  const view = source as NotedGauge;
  view.meter.count += 1;
  return view.meter.count;
}
const gauge: Gauge = { meter: { count: 1 }, label: "g" };
console.log(bump(gauge), gauge.meter.count, bump(gauge), gauge.meter.count);
