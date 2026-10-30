// An untyped receiver calling a String.prototype method name holds a
// string or a checked-dynamic object with its own method of that name
// (zod's schemas assign `trim`, `toLowerCase` and `startsWith` in their
// constructors, so `z.string().trim().min(1)` chains schema calls).
// Each call dispatches on the receiver's runtime kind.
interface Field {
  value: string;
  checks: string[];
}

function field(value: string, checks: string[]): any {
  const self: Field & Record<string, unknown> = { value, checks };
  self["trim"] = () => field(value.trim(), [...checks, "trim"]);
  self["toLowerCase"] = () => field(value.toLowerCase(), [...checks, "lower"]);
  self["startsWith"] = (prefix: string) => checks.length > 0 && value.startsWith(prefix);
  self["min"] = (n: number) => field(value, [...checks, `min(${n})`]);
  return self;
}

const chained = field("  Hello World ", []).trim().toLowerCase().min(1);
console.log(JSON.stringify(chained.value), chained.checks.join(","));
console.log(field("abc", ["x"]).startsWith("ab"), field("abc", []).startsWith("ab"));

const text: any = "  Mixed Case  ";
console.log(JSON.stringify(text.trim()), text.toLowerCase(), text.startsWith("  M"));

const parsed: any = JSON.parse('{"name":"  padded  "}');
console.log(JSON.stringify(parsed.name.trim()));

for (const value of [field(" a ", []), " b ", 42, null]) {
  const v: any = value;
  try {
    const out = v.trim();
    console.log(typeof out === "string" ? JSON.stringify(out) : `field ${JSON.stringify(out.value)}`);
  } catch (error) {
    console.log(error instanceof TypeError, (error as Error).message);
  }
}
