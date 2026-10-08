// Unchecked element reads are undefined past the end of an array even
// though the element type omits undefined. Slots whose types admit
// undefined receive that value as their undefined state; present
// elements keep their ordinary values.

function attempt(label: string, run: () => unknown): void {
  try {
    console.log(label, run());
  } catch (e) {
    if (e instanceof Error) console.log(label, "threw", e.name);
  }
}

const noNames: string[] = [];
const names = ["ada", "bo"];
const scores = [7];

function firstName(preferred: string | undefined, list: string[]): string | undefined {
  return preferred ?? list[0];
}
function thirdScore(list: number[]): number | undefined {
  return list[2];
}
function describe(value: string | undefined): string {
  return value === undefined ? "none" : value;
}
function pickOr(flag: boolean, list: string[]): string | undefined {
  return flag ? list[0] : "fixed";
}
function eitherName(list: string[]): string | undefined {
  return list[1] || list[0];
}
function stored(preferred: string | undefined, list: string[]): string | undefined {
  const chosen = preferred ?? list[0];
  return chosen;
}
function fromPattern(preferred: string | undefined, list: string[]): string | undefined {
  const [head] = list;
  return preferred ?? head;
}
function laterRead(preferred: string | undefined, list: string[]): () => string | undefined {
  return () => preferred ?? list[0];
}
function orFallback<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

class Shelf {
  items: string[] = [];
  label: string | undefined;
  top(): string | undefined {
    return this.label ?? this.items[this.items.length - 1];
  }
}

attempt("first empty", () => firstName(undefined, noNames));
attempt("first named", () => firstName(undefined, names));
attempt("first preferred", () => firstName("cy", noNames));
attempt("third", () => thirdScore(scores));
attempt("describe", () => describe(noNames[0]));
attempt("describe present", () => describe(names[1]));
attempt("ternary", () => pickOr(true, noNames));
attempt("or", () => eitherName(noNames));
attempt("or present", () => eitherName(names));
attempt("stored", () => stored(undefined, noNames));
attempt("pattern", () => fromPattern(undefined, noNames));
attempt("pattern present", () => fromPattern(undefined, names));
attempt("capture", () => laterRead(undefined, noNames)());
attempt("generic", () => orFallback(noNames[0] ?? undefined, "fallback"));
attempt("explicit generic", () => orFallback<string | undefined>(noNames[3], "unused"));
attempt("length", () => (firstName(undefined, names) ?? "").length);
let missing: string | undefined;
attempt("concat", () => (missing ?? noNames[0]) + "!");
attempt("template", () => `${firstName(undefined, noNames)}`);

const shelf = new Shelf();
attempt("shelf empty", () => shelf.top());
shelf.items.push("box", "jar");
attempt("shelf top", () => shelf.top());
shelf.label = "label";
attempt("shelf label", () => shelf.top());

// A member read needs the present value: undefined still throws there.
attempt("member", () => (missing ?? noNames[0]).length);
