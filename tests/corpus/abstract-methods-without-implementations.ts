// An abstract declaration has no runtime value: JavaScript's prototype has
// no member for it. A direct call with no implementation below the
// receiver's static class therefore evaluates its receiver and the written
// arguments, then throws Node's "<callee> is not a function" TypeError. An
// untyped lookup selects the implementation of the constructible class the
// instance belongs to, nearest first, then the nearest implementation above
// the abstract re-declaration, and reads undefined when no class in the
// chain implements the member.
abstract class Source {
  abstract count(step: number): number;

  liveFrom(factor: () => number): number {
    return this.count(factor()) * 2;
  }
}

class Shelf {
  source: Source | null = null;
}

// The issue's shape: tsc knows every instantiable subclass implements
// `count`, so the call is only reachable with a null receiver here.
const shelf = new Shelf();
console.log(shelf.source === null ? "none" : shelf.source.liveFrom(() => 1));

function caught(label: string, fn: () => unknown): void {
  try {
    fn();
    console.log(label, "no throw");
  } catch (error) {
    if (error instanceof Error) console.log(label, error.name, error.message);
  }
}

// Constructing the class value dynamically builds a bare instance, exactly
// as JavaScript's `new` does for a class whose declaration is abstract only
// in the type system.
const bare = new (Source as any)() as Source;
caught("dot", () => bare.count(1));
caught("element", () => bare["count"](1));
caught("this-call", () =>
  bare.liveFrom(() => {
    console.log("factor evaluated");
    return 3;
  }),
);

function makeSource(): Source {
  console.log("receiver evaluated");
  return bare;
}
caught("arguments", () =>
  makeSource().count(
    (() => {
      console.log("argument evaluated");
      return 2;
    })(),
  ),
);
caught("spread", () => bare.count(...([7] as [number])));

// Untyped lookups over a hierarchy: the nearest implementation answers, an
// abstract class that implements the member answers with its own, and an
// instance with nothing below reads undefined.
abstract class Holder {
  abstract current(): string;
}

abstract class Naming extends Holder {
  current(): string {
    return "named";
  }
}

class Suffixed extends Naming {
  current(): string {
    return "suffixed";
  }
}

const read = (value: any, key: string) => value[key];
const instances: [string, unknown][] = [
  ["suffixed", new Suffixed()],
  ["naming", new (Naming as any)()],
  ["holder", new (Holder as any)()],
];
for (const [label, value] of instances) {
  const member = read(value, "current");
  console.log(
    label,
    typeof member,
    typeof member === "function" ? (member as () => string)() : "absent",
  );
}

// An abstract re-declaration over a concrete ancestor: the chain above the
// abstract class still answers. `Quiet` emits no member of its own, so a
// bare instance reads `Plain`'s implementation, and `Loud` overrides it.
class Plain {
  describe(): string {
    return "plain";
  }
}

abstract class Quiet extends Plain {
  abstract describe(): string;
}

class Loud extends Quiet {
  describe(): string {
    return "loud";
  }
}

abstract class Root {
  abstract label(): string;
}

class Middle extends Root {
  label(): string {
    return "middle";
  }
}

abstract class Top extends Middle {
  abstract label(): string;
}

class Leaf extends Top {
  label(): string {
    return "leaf";
  }
}

const chain: [string, unknown, string][] = [
  ["quiet", new (Quiet as any)(), "describe"],
  ["loud", new Loud(), "describe"],
  ["plain", new Plain(), "describe"],
  ["top", new (Top as any)(), "label"],
  ["middle", new Middle(), "label"],
  ["leaf", new Leaf(), "label"],
  ["root", new (Root as any)(), "label"],
];
for (const [label, value, key] of chain) {
  const member = read(value, key);
  console.log(
    label,
    typeof member,
    typeof member === "function" ? (member as () => string)() : "absent",
  );
}

// A direct call through an abstract re-declaration with nothing below it
// reaches the nearest implementation above, through every spelling, with
// the implementation's own parameter defaults.
class Sign {
  mark = "sign";

  text(prefix: string = "default"): string {
    return `${prefix}:${this.mark}`;
  }
}

abstract class Blank extends Sign {
  abstract text(prefix?: string): string;

  both(): string {
    return `${this.text()} ${this["text"]("own")}`;
  }
}

abstract class Blanker extends Blank {
  abstract text(prefix?: string): string;
}

const blank = new (Blank as any)() as Blank;
const blanker = new (Blanker as any)() as Blanker;
console.log(blank.text(), blank["text"]("element"), blank.both());
console.log(blanker.text("deeper"), blanker.both());
const untypedBlank: any = blank;
console.log(untypedBlank.text("untyped"), typeof read(blank, "text"));

// Object.prototype's methods re-declared abstractly: the chain ends at
// Object.prototype, so the untyped reads answer its functions and the
// conversions use its default. An abstract toString on an Error subclass
// leaves Error.prototype.toString in charge.
abstract class Shown {
  abstract toString(): string;
  abstract valueOf(): number;
  abstract hasOwnProperty(key: PropertyKey): boolean;
}

const shown: any = new (Shown as any)();
console.log(typeof shown.toString, typeof shown.valueOf, typeof shown.hasOwnProperty);
console.log(shown.hasOwnProperty("toString"), shown.valueOf() === shown);
console.log(String(shown), `${shown}`);

class Banner {
  toString(): string {
    return "banner";
  }
}

abstract class Muted extends Banner {
  abstract toString(): string;
}

console.log(String(new (Muted as any)()), `${new (Muted as any)() as unknown}`);

abstract class Faulty extends Error {
  abstract toString(): string;
}

const faulty = new (Faulty as any)("boom") as Faulty;
console.log(faulty.toString(), faulty["toString"](), String(faulty as unknown));
