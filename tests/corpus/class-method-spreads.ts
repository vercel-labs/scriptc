const events: string[] = [];
class Collector {
  value = 10;
  collect(...values: (number | undefined)[]): number {
    events.push("original");
    return this.value + values.reduce<number>((total, value) => total + (value ?? 0), 0);
  }
}
class DerivedCollector extends Collector {
  override collect(...values: (number | undefined)[]): number {
    events.push("derived");
    return this.value + values.length;
  }
}
const collector = new Collector();
const derived: Collector = new DerivedCollector();
function receiver(): Collector { events.push("receiver"); return collector; }
function values(label: string, value: number): number[] {
  events.push(label);
  return [value, value + 1];
}
function replacement(this: Collector, ...values: (number | undefined)[]): number {
  events.push("replacement");
  return this.value * 10 + values.length;
}
console.log(collector.collect(...[1, 2]), derived.collect(...[3, 4]));
Object.defineProperty(collector, "collect", { configurable: true, value: replacement });
console.log(receiver().collect(...values("first", 1), 7, ...values("last", 3)));
console.log(events.join(","));
events.length = 0;
Object.defineProperty(collector, "collect", {
  configurable: true,
  get() { events.push("get"); return replacement; },
});
function replaceDuringSpread(): number[] {
  events.push("spread");
  Object.defineProperty(collector, "collect", { configurable: true, value: () => -1 });
  return [4, 5];
}
console.log(receiver().collect(...replaceDuringSpread()));
const empty: number[] = [];
console.log(events.join(","), collector.collect(...empty));
Object.defineProperty(collector, "collect", { value: replacement });
const sparse: number[] = [];
sparse.length = 3;
sparse[1] = 9;
console.log(collector.collect(...sparse));
function fail(): number[] { events.push("throw"); throw new Error("stop"); }
events.length = 0;
try { receiver().collect(...fail(), ...values("unreachable", 8)); }
catch (error) { console.log(error instanceof Error, events.join(",")); }
