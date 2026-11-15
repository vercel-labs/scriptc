// @requires-libnode
// A built-in constructor that crosses a Node island boundary is the other
// side's own: inside the island the program's `String` is the island's
// `String`, the island hands the program's value back, and the island's
// own constructor arrives as the program's. Bare, as an object's member,
// as a typed option table's member, and wrapped by the island.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

function attempt(label: string, body: () => unknown): void {
  try {
    console.log(label, body());
  } catch (error) {
    console.log(label, "threw:", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
}

// Into the island: the island's own constructor, with its name and length.
attempt("String is the island's", () => lib.isGlobal(String, "String"));
attempt("Number is the island's", () => lib.isGlobal(Number, "Number"));
attempt("Boolean is the island's", () => lib.isGlobal(Boolean, "Boolean"));
attempt("BigInt is the island's", () => lib.isGlobal(BigInt, "BigInt"));
attempt("String is not the island's Number", () => lib.isGlobal(String, "Number"));
attempt("seen in the island", () =>
  [lib.describe(String), lib.describe(Number), lib.describe(Boolean), lib.describe(BigInt)].join(" "),
);
attempt("called in the island", () =>
  [lib.callWith(String, 42), lib.callWith(Number, "42"), lib.callWith(Boolean, ""), lib.callWith(BigInt, "42")].join(" "),
);

// And back: the program's value again.
attempt("echo String", () => lib.echo(String) === String);
attempt("echo Number", () => lib.echo(Number) === Number);
attempt("echo Boolean", () => lib.echo(Boolean) === Boolean);
attempt("echo BigInt", () => lib.echo(BigInt) === BigInt);
attempt("echo String is not Number", () => lib.echo(String) === Number);

// Through an object's member, both ways.
const spec = { name: String, count: Number, force: Boolean };
attempt("member seen in the island", () => lib.sameMember(spec, "count", "Number"));
attempt("member of the echoed object", () => lib.echo(spec).force === Boolean);
attempt("member read by the island", () => lib.member(spec, "name") === String);
attempt("wrapped by the island", () => {
  const wrapped = lib.wrap(Boolean);
  return [wrapped.type === Boolean, wrapped.list[0] === Boolean, wrapped.type === String].join(",");
});

// A typed option table's member: one of several constructors, or a list.
type Kind = typeof String | typeof Number | typeof Boolean;
const table: Record<string, Kind | [Kind]> = {
  "--name": String,
  "--count": Number,
  "--force": Boolean,
  "--tag": [String],
};
for (const flag of Object.keys(table)) {
  const kind = table[flag]!;
  if (Array.isArray(kind)) {
    const inner = kind[0];
    attempt(flag, () => ["list", lib.isGlobal(inner, "String"), lib.echo(inner) === String].join(","));
  } else {
    attempt(flag, () =>
      [lib.describe(kind), lib.echo(kind) === kind, lib.echo(kind) === Number, lib.callWith(kind, "7")].join(","),
    );
  }
}

// The island's own constructor, first met coming out of the island.
attempt("the island's String", () => lib.own("String") === String);
attempt("the island's BigInt", () => lib.own("BigInt") === BigInt);
attempt("the island's Number, called here", () => {
  const number = lib.own("Number");
  return typeof number("42") + ":" + number("42");
});

// A collection keyed by constructors finds its entry after the round trip.
const labels = new Map<unknown, string>([
  [String, "text"],
  [Number, "number"],
]);
attempt("map key after the round trip", () => [labels.get(lib.echo(Number)), labels.get(lib.own("String"))].join(","));
