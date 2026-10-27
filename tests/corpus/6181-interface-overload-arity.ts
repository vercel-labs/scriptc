// Arity overloads on interface and type-literal members: positions some
// overloads omit are optional in the stored function, so one implementation
// with optional parameters serves every overload, and a call omitting a
// trailing argument passes undefined exactly as Node does.
export {};

interface Formatter {
  label(): string;
  label(prefix: string): string;
  label(prefix: string, width: number): string;
}
const formatter: Formatter = {
  label(prefix?: string, width?: number): string {
    const text = prefix ?? "none";
    return width === undefined ? text : text.padEnd(width, ".") + "|";
  },
};
console.log(formatter.label());
console.log(formatter.label("p"));
console.log(formatter.label("q", 6));

// Overloads spelled as call signatures of a type-literal member.
type Logger = {
  log: {
    (message: string): void;
    (level: number, message: string): void;
  };
  lines: string[];
};
const lines: string[] = [];
const logger: Logger = {
  lines,
  log: (a: string | number, b?: string) => {
    lines.push(typeof a === "number" ? `[${a}] ${b}` : a);
  },
};
logger.log("plain");
logger.log(2, "leveled");
console.log(logger.lines.join("; "));

// A single-signature method with an optional parameter fills its slot the
// same way.
interface Greeter {
  greet(name?: string): string;
}
const greeter: Greeter = {
  greet(name?: string): string {
    return `hello ${name ?? "stranger"}`;
  },
};
console.log(greeter.greet(), greeter.greet("ada"));

// Arguments are evaluated once, left to right, before the call.
let n = 0;
const next = (): string => `#${++n}`;
console.log(formatter.label(next(), 4 + n), n);
