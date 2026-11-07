// A fixed-key record built by filling in an empty object literal asserted to
// its type, in a program that freezes other values of that type. The object
// asserted is the object returned: it keeps its identity, lists its keys in
// the order they were written, and is not frozen.
type Token = "accent" | "border" | "text";
type Palette = Record<Token, string | number>;
const SLOTS: Record<Token, number> = { text: 15, accent: 4, border: 8 };
const ORDER: Token[] = ["text", "accent", "border"];

function defaults(): Readonly<Palette> {
  const base: Palette = { accent: "", border: "", text: "" };
  return Object.freeze(base);
}

function build(scale: number): Palette {
  const colors = {} as Palette;
  for (const [token, slot] of Object.entries(SLOTS) as [Token, number][]) {
    colors[token] = scale > 0 ? slot * scale : "";
  }
  return colors;
}

function byField(scale: number): Palette {
  const colors = {} as Palette;
  colors.border = SLOTS.border * scale;
  colors.text = "t";
  colors.accent = SLOTS.accent * scale;
  return colors;
}

function reduced(scale: number): Palette {
  return ORDER.reduce((acc, token) => {
    acc[token] = SLOTS[token] * scale;
    return acc;
  }, {} as Palette);
}

function finish(colors: Palette): void {
  colors.accent = 1;
  colors.border = 2;
}

function describe(colors: Palette): string {
  return ORDER.map((token) => `${token}=${colors[token]}`).join(" ");
}

class Theme {
  private colors = {} as Palette;
  set(token: Token, value: string | number): this {
    this.colors[token] = value;
    return this;
  }
  keys(): string {
    return Object.keys(this.colors).join(",");
  }
  total(): string {
    return describe(this.colors);
  }
}

const frozen = defaults();
console.log("frozen", Object.isFrozen(frozen), JSON.stringify(frozen));

const built = build(2);
console.log("loop", JSON.stringify(built), Object.keys(built).join(","), Object.isFrozen(built));
console.log("empty scale", JSON.stringify(build(0)));
const fields = byField(3);
console.log("fields", JSON.stringify(fields), Object.values(fields).join(","), describe(fields));
console.log("reduce", JSON.stringify(reduced(1)), Object.entries(reduced(2)).length);

// One object: aliases, an unknown round trip, a Map key and an array slot.
const partial = {} as Palette;
const alias = partial;
const unknownRef: unknown = partial;
const index = new Map<Palette, string>([[partial, "first"]]);
const list: Palette[] = [partial];
partial.text = "late";
console.log("early", JSON.stringify(alias), "text" in alias, "accent" in alias);
finish(partial);
const back = unknownRef as Palette;
back.border = 20;
console.log(
  "identity",
  alias === partial,
  back === partial,
  index.get(alias),
  list.indexOf(back),
  describe(alias),
);
const seen: string[] = [];
for (const key in partial) seen.push(key);
console.log("for-in", seen.join(","));

// A copy made by spread is another object with the same keys in the same order.
const copy = { ...partial };
copy.text = "copy";
console.log("spread", copy === partial, JSON.stringify(copy), partial.text);

// A frozen value of the type still refuses writes, and reads as before.
try {
  (frozen as Palette).accent = 9;
  console.log("wrote", frozen.accent);
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}
console.log("frozen reads", describe(frozen as Palette), Object.keys(frozen).join(","));

console.log("class", new Theme().set("border", 1).set("accent", "a").set("text", 3).keys());
console.log("class", new Theme().set("text", 3).set("border", 1).set("accent", "a").total());

// Many objects built and dropped.
let total = 0;
for (let i = 0; i < 2000; i++) {
  const row = {} as Palette;
  row.text = i;
  row.accent = 1;
  row.border = "b";
  total += (row.text as number) + (row.accent as number);
}
console.log("many", total);
