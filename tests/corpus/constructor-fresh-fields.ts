// Constructor field stores: first stores into a fresh object next to stores
// that replace an earlier value (initializers overwritten by the body,
// branches, loops, inherited fields, stores after `this` escapes, a base
// constructor's virtual call) and constructors that throw midway.

class Label {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

class Plain {
  name: string;
  tags: string[];
  label: Label | undefined;
  count: number;
  constructor(name: string, tags: string[], label?: Label) {
    this.name = name;
    this.tags = tags;
    this.label = label;
    this.count = tags.length;
  }
}

class Overwritten {
  items: string[] = ["initial"];
  label: Label | undefined = new Label("initial");
  title = "initial";
  constructor(replace: boolean) {
    if (replace) {
      this.items = ["replaced"];
      this.label = new Label("replaced");
    } else {
      this.label = undefined;
    }
    this.title = `${this.title} -> ${replace ? "replaced" : "kept"}`;
  }
}

class Branches {
  value: Label;
  other: Label | undefined;
  constructor(flag: number) {
    if (flag > 0) this.value = new Label("positive");
    else this.value = new Label("not positive");
    if (flag > 1) this.other = new Label("big");
    this.value = new Label(`${this.value.text}!`);
  }
}

class Looped {
  last: Label | undefined;
  parts: string[];
  constructor(n: number) {
    this.parts = [];
    for (let i = 0; i < n; i++) {
      this.last = new Label(`part ${i}`);
      this.parts = [...this.parts, this.last.text];
    }
  }
}

class Base {
  shared: Label;
  base: string[];
  constructor(text: string) {
    this.shared = new Label(`base ${text}`);
    this.base = [text];
  }
}

class Derived extends Base {
  own: Label;
  constructor(text: string) {
    super(text);
    this.shared = new Label(`derived ${text}`);
    this.own = new Label(`own ${text}`);
  }
}

class DeeperDerived extends Derived {
  deeper: string[] = ["deeper"];
  constructor() {
    super("deeper");
    this.base = [...this.base, "more"];
  }
}

const registry: Escaping[] = [];

function touch(target: Escaping): void {
  target.note = new Label("written while registering");
}

class Escaping {
  note: Label | undefined;
  first: Label;
  constructor() {
    this.first = new Label("before escape");
    registry.push(this);
    touch(this);
    this.note = new Label(`after escape (was ${this.note?.text ?? "unset"})`);
  }
}

class Announcer {
  constructor() {
    this.announce();
  }
  announce(): void {}
}

class Listener extends Announcer {
  heard: Label | undefined = new Label("initializer");
  override announce(): void {
    this.heard = new Label("from the base constructor");
  }
}

class Failing {
  kept: Label;
  later: Label | undefined;
  constructor(fail: boolean) {
    this.kept = new Label("set before the throw");
    if (fail) throw new Error("constructor failed");
    this.later = new Label("set after the check");
  }
}

class FailingDerived extends Base {
  extra: Label;
  constructor(fail: boolean) {
    super("failing");
    this.extra = new Label("extra");
    if (fail) throw new RangeError("derived constructor failed");
  }
}

class Switched {
  label: Label | undefined;
  constructor(kind: number) {
    // The second case's test runs before the default body.
    switch (kind) {
      default:
        this.label = new Label(`default after ${this.label?.text ?? "nothing"}`);
        break;
      case ((this.label = new Label("tested")), 1):
        this.label = new Label(`one after ${this.label?.text ?? "nothing"}`);
        break;
    }
  }
}

function describe(label: Label | undefined): string {
  return label === undefined ? "undefined" : label.text;
}

const plains: Plain[] = [];
for (let i = 0; i < 3; i++)
  plains.push(new Plain(`plain ${i}`, ["a", "b"].slice(0, i), i === 1 ? new Label("one") : undefined));
for (const p of plains) console.log(p.name, p.tags.join(","), describe(p.label), p.count);

for (const replace of [true, false]) {
  const o = new Overwritten(replace);
  console.log(o.items.join(","), describe(o.label), o.title);
}

for (const flag of [0, 1, 2]) {
  const b = new Branches(flag);
  console.log(b.value.text, describe(b.other));
}

for (const n of [0, 1, 3]) {
  const l = new Looped(n);
  console.log(n, describe(l.last), l.parts.join("|"));
}

const d = new Derived("x");
console.log(d.shared.text, d.own.text, d.base.join(","));
const dd = new DeeperDerived();
console.log(dd.shared.text, dd.own.text, dd.base.join(","), dd.deeper.join(","));

const e = new Escaping();
console.log(describe(e.note), e.first.text, registry.length, registry[0] === e);

const listener = new Listener();
console.log(describe(listener.heard));

for (const fail of [false, true]) {
  try {
    const f = new Failing(fail);
    console.log("built", f.kept.text, describe(f.later));
  } catch (error) {
    console.log("caught", (error as Error).message);
  }
  try {
    const f = new FailingDerived(fail);
    console.log("built", f.shared.text, f.extra.text);
  } catch (error) {
    console.log("caught", error instanceof RangeError, (error as Error).message);
  }
}

for (const kind of [0, 1]) console.log(describe(new Switched(kind).label));

let total = 0;
for (let i = 0; i < 2000; i++) {
  const p = new Derived(`n${i % 7}`);
  total += p.own.text.length + p.shared.text.length;
}
console.log("total", total);
