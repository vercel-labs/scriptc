// Untyped reads of class instances dispatch on the capsule's class key.
// These classes have keys of equal length, keys that share their last
// eight bytes, and short keys, so every stage of the brand probe decides.
class FooHandlerA {
  kind = "foo-a";
  label(): string {
    return `FooHandlerA:${this.kind}`;
  }
}
class BarHandlerA {
  kind = "bar-a";
  label(): string {
    return `BarHandlerA:${this.kind}`;
  }
}
class FooHandlerB extends FooHandlerA {
  override kind = "foo-b";
  extra = 2;
}
class Q {
  kind = "q";
  label(): string {
    return "Q";
  }
}
class R {
  kind = "r";
  label(): string {
    return "R";
  }
}
class LongerClassNameWithSharedTail {
  kind = "long";
  label(): string {
    return "long";
  }
}
class OtherClassNameWithSharedTail {
  kind = "other";
  label(): string {
    return "other";
  }
}

const values: any[] = [
  new FooHandlerA(),
  new BarHandlerA(),
  new FooHandlerB(),
  new Q(),
  new R(),
  new LongerClassNameWithSharedTail(),
  new OtherClassNameWithSharedTail(),
  { kind: "plain", label: () => "plain" },
];

for (const value of values) {
  const extra = value.extra;
  console.log(value.kind, value.label(), extra === undefined ? "-" : extra, value.constructor.name);
}

// Writes through the untyped view reach the right instance.
for (const value of values) value.kind = `${value.kind}!`;
console.log(values.map((value) => value.kind).join(","));

// Computed reads go through the same tables.
const key: string = ["kind", "label"][values.length % 2];
console.log(values.map((value) => typeof value[key]).join(","));
console.log(values.filter((value) => value instanceof FooHandlerA).length);
