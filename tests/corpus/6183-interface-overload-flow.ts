// Values of an interface with an overloaded member flow like any record:
// through arrays, factory callbacks, and function results. A class that
// implements the interface dispatches to its own overloaded method.
export {};

interface Bus {
  emit(kind: "num", value: number): void;
  emit(kind: "text", value: string): void;
  label: string;
}
type Plugin = (bus: Bus) => void;

const log: string[] = [];
function makeBus(label: string): Bus {
  return {
    label,
    emit(kind: "num" | "text", value: number | string): void {
      log.push(`${label}:${kind}:${typeof value}:${value}`);
    },
  };
}
const plugins: Plugin[] = [
  (bus) => bus.emit("num", 1),
  (bus) => {
    bus.emit("text", "two");
    bus.emit("num", bus.label.length + 2);
  },
];
const buses: Bus[] = [makeBus("x"), makeBus("yy")];
for (const bus of buses) for (const plugin of plugins) plugin(bus);
console.log(log.join("\n"));
console.log(typeof buses[1]!.emit, JSON.stringify(buses[0]));

interface Picker {
  pick(kind: "s"): string;
  pick(kind: "n"): number;
}
class Impl implements Picker {
  private readonly base: number;
  constructor(base: number) {
    this.base = base;
  }
  pick(kind: "s"): string;
  pick(kind: "n"): number;
  pick(kind: "s" | "n"): string | number {
    return kind === "s" ? `str${this.base}` : this.base * 7;
  }
}
function use(p: Picker): string {
  return `${p.pick("s").length}/${p.pick("n") + 1}`;
}
console.log(use(new Impl(1)), use(new Impl(10)));
const literal: Picker = {
  pick(kind: "s" | "n"): any {
    return kind === "s" ? "literal" : -1;
  },
};
console.log(use(literal));

// Receivers of every shape resolve the overload the same way: a union of
// records sharing the member, an optional chain, and a call result.
interface Measure {
  kind: "len";
  of(x: number): string;
  of(x: string): number;
}
interface Sign {
  kind: "sign";
  of(x: number): string;
  of(x: string): number;
}
const measure: Measure = {
  kind: "len",
  of(x: number | string): any {
    return typeof x === "number" ? `#${x}` : x.length;
  },
};
const sign: Sign = {
  kind: "sign",
  of(x: number | string): any {
    return typeof x === "number" ? (x < 0 ? "-" : "+") : -x.length;
  },
};
for (const m of [measure, sign] as (Measure | Sign)[]) console.log(m.kind, m.of(-4).length, m.of("xyz") + 1);
const maybe: Measure | undefined = buses.length > 5 ? undefined : measure;
const none: Measure | undefined = buses.length > 5 ? measure : undefined;
console.log(maybe?.of(5), maybe?.of("abc"), none?.of(1), none?.of("q"));
const pickMeasure = (): Measure => measure;
console.log(pickMeasure().of(7).toUpperCase());
