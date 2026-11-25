// util.inspect's style tables are writable program data: a program can map a
// styleType to any color name, including a very long one, and can replace
// (or null) inspect.colors and inspect.styles. A null table then throws the
// property read's TypeError, whose message names the style the inspector was
// looking up — the full name, however long. The message must be the name's
// text and nothing else: no truncation at a fixed buffer size and no bytes
// past it.
import { format, inspect } from "node:util";

const show = (label: string, run: () => unknown): void => {
  try {
    console.log(label, "no throw", JSON.stringify(run()));
  } catch (e: any) {
    console.log(label, e.name, e.message.length, JSON.stringify(e.message));
  }
};

// A long color name with inspect.colors null: Node's message carries the
// whole name. Lengths below, at and far past a small native buffer.
for (const length of [1, 40, 95, 96, 97, 200, 2000]) {
  inspect.styles.number = "n".repeat(length);
  inspect.colors = null as any;
  show(`null colors len ${length}`, () => inspect(1, { colors: true }));
}

// undefined answers the same property-read TypeError with "undefined".
inspect.styles.number = "u".repeat(300);
inspect.colors = undefined as any;
show("undefined colors", () => inspect(1, { colors: true }));

// The text is copied as bytes: non-ASCII and quote-bearing names survive.
inspect.styles.number = "é".repeat(200);
inspect.colors = null as any;
show("unicode name", () => inspect(1, { colors: true }));
inspect.styles.number = "a'b\nc";
inspect.colors = null as any;
show("quoted name", () => inspect(1, { colors: true }));

// The name comes from the style table's value for the rendered styleType,
// so a name only a leaf needs is the one the message names.
inspect.styles.string = "s".repeat(120);
inspect.colors = null as any;
show("string style", () => inspect("x", { colors: true }));
show("format string style", () => format("%o", "x"));
console.log("plain still renders", JSON.stringify(inspect(1)));

// A null styles table throws reading the styleType itself.
inspect.styles = null as any;
inspect.colors = { red: [31, 39] };
show("null styles", () => inspect(1, { colors: true }));
inspect.styles = undefined as any;
show("undefined styles", () => inspect(1, { colors: true }));

// Restored tables render again.
inspect.styles = { number: "red", string: "green" };
inspect.colors = { red: [31, 39], green: [32, 39] };
console.log("restored", JSON.stringify(inspect(1, { colors: true })), JSON.stringify(inspect("x", { colors: true })));
