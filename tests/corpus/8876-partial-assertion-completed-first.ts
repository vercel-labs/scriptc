// A fixed-key record built up key by key in a program that also freezes
// values of that record type. The forms here complete the object before it
// is asserted to the record type, so they need no partial record view:
// a string-keyed record asserted at the end, a Partial<T> filled and then
// asserted, and a complete literal.
type Token = "accent" | "border" | "text";
const SLOTS: Record<Token, number> = { accent: 4, border: 8, text: 15 };

function fromDictionary(scale: number): Record<Token, string | number> {
  const colors: Record<string, string | number> = {};
  for (const [token, slot] of Object.entries(SLOTS)) {
    colors[token] = scale > 0 ? slot * scale : "";
  }
  return colors as Record<Token, string | number>;
}

function fromPartial(scale: number): Record<Token, string | number> {
  const colors: Partial<Record<Token, string | number>> = {};
  colors.accent = SLOTS.accent * scale;
  colors.border = "";
  colors.text = SLOTS.text * scale;
  return colors as Record<Token, string | number>;
}

function fromLiteral(scale: number): Record<Token, string | number> {
  return { accent: SLOTS.accent * scale, border: "", text: SLOTS.text * scale };
}

function defaults(): Readonly<Record<Token, string | number>> {
  const base: Record<Token, string | number> = { accent: "", border: "", text: "" };
  return Object.freeze(base);
}

const a = fromDictionary(2);
a.border = "b";
console.log(JSON.stringify(a), Object.keys(a).join(","));
console.log(JSON.stringify(fromDictionary(0)));
const b = fromPartial(3);
b.border = 1;
console.log(JSON.stringify(b), Object.keys(b).join(","), "text" in b);
console.log(JSON.stringify(fromLiteral(4)));

const frozen = defaults();
console.log(Object.isFrozen(frozen), Object.isFrozen(a), JSON.stringify(frozen));
try {
  (frozen as Record<Token, string | number>).accent = 9;
  console.log("wrote", frozen.accent);
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}
