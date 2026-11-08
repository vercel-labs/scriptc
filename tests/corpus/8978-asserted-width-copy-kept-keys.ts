// A record converted from an object with undeclared own keys keeps them beside
// its declared fields. `as unknown as T` between two record types copies the
// declared fields; Node erases the assertion, so a target field the source
// type does not declare still answers the key the object carries. The copy
// reads that field from the source record's kept view and answers undefined
// when the object lacks it.

interface Tool {
  name: string;
  label: string;
}
interface View {
  name: string;
  snippet?: string;
}
interface Counted {
  name: string;
  count?: number;
}

const t = JSON.parse('{"name":"sh","label":"SH","snippet":"run shell","count":42}') as Tool;
const bare = JSON.parse('{"name":"b","label":"B"}') as Tool;

// The double assertion: a declared field reads its slot, and the kept key
// reads what the object carries.
const v = t as unknown as View;
console.log("basic", String(v.snippet), v.name, String(v.snippet === undefined));
console.log("length", v.snippet?.length, v.snippet ?? "none", typeof v.snippet);
console.log("number", (t as unknown as Counted).count, typeof (t as unknown as Counted).count);

// A source without the key: Node's object lacks it, so the field is undefined.
const bv = bare as unknown as View;
console.log("absent", String(bv.snippet), "snippet" in bv, Object.hasOwn(bv, "snippet"));

// The copy is the object for the reflective surfaces: its kept keys are
// listed and serialized as Node lists them.
console.log("reflect", Object.keys(v).join(","), JSON.stringify(v), "snippet" in v);
console.log("bare-reflect", Object.keys(bv).join(","), JSON.stringify(bv));

// Through a function parameter and a return.
function view(tool: Tool): View {
  return tool as unknown as View;
}
console.log("fn", String(view(t).snippet), String(view(bare).snippet), view(t).name);

// Nested in another record.
const envelope: { tool: Tool } = { tool: t };
console.log("nested", String((envelope.tool as unknown as View).snippet));

// Through a union-typed variable: the record itself is converted, not the
// union.
const maybe: Tool | undefined = t;
console.log("union", String((maybe as unknown as View).snippet));
const nullable = t as unknown as View | null;
console.log("nullable", nullable === null ? "null" : String(nullable.snippet));

// A target field whose own type is a union.
const unionField = t as unknown as { name: string; snippet: string | undefined };
console.log("union-field", unionField.snippet, unionField.snippet === undefined);

// A target field of the untyped kind reads the kept key as it is.
const dynView = JSON.parse('{"name":"d","label":"D","payload":{"deep":true}}') as Tool;
const dv = dynView as unknown as { name: string; payload?: unknown };
console.log("dyn", JSON.stringify(dv.payload), JSON.stringify(dv));

// A second assertion of a copy keeps the first object's keys.
const step = t as unknown as { name: string; label: string; snippet?: string };
const step2 = step as unknown as View;
console.log("two-step", String(step2.snippet), JSON.stringify(step2));

// A record with no kept source answers undefined, as Node's object does.
const plain = { name: "p", label: "P" } as Tool;
console.log("plain", String((plain as unknown as View).snippet), JSON.stringify(plain as unknown as View));

// Copies kept in an array of the target type answer per element.
const views: View[] = [t as unknown as View, bare as unknown as View];
console.log("array", String(views[0]!.snippet), String(views[1]!.snippet), JSON.stringify(views));

// A cast of an array converts each element the same way.
const cast = [t, bare] as unknown as View[];
console.log("array-cast", String(cast[0]!.snippet), String(cast[1]!.snippet), cast[0]!.name);

// An unrelated kept key does not make an absent target key present: the
// presence test is per key, exactly as the erased assertion leaves a key the
// source never held.
const extra = JSON.parse('{"name":"e","label":"E","count":7}') as Tool;
const ev = extra as unknown as View;
console.log(
  "extra",
  String(ev.snippet),
  "snippet" in ev,
  Object.hasOwn(ev, "snippet"),
  Object.keys(ev).join(","),
  JSON.stringify(ev),
);

// A kept accessor runs with the view as its receiver, and a getter that
// throws reaches the catch block as the erasure's own property read does.
// The copy reads the key when it is built, so the assertion sits inside the
// try: the read's exception must reach the same catch the erased read does.
// The target field is of the untyped kind, so the read's value is the field.
const dyn = JSON.parse('{"name":"g","label":"G"}');
Object.defineProperty(dyn, "payload", {
  get() {
    throw new Error("boom");
  },
  enumerable: true,
  configurable: true,
});
try {
  const g = dyn as unknown as { name: string; payload?: unknown };
  console.log("getter", String(g.payload));
} catch (e) {
  console.log("getter-caught", (e as Error).message);
}
