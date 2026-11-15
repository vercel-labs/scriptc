// An Error subclass with an index signature: a parser's problem report.
// Its declared fields say where the problem is; whatever else the reporter
// knows travels as extra properties, written in the constructor from a Map
// and later by name. Thrown and rejected, then read in catch clauses after
// a type guard, after instanceof, through an assertion and by
// destructuring.
class ParseProblem extends Error {
  line: number;
  column: number;
  [key: string]: any;

  constructor(what: string, line: number, column: number, details?: Map<string, unknown>) {
    super(`${line}:${column} ${what}`);
    this.line = line;
    this.column = column;
    if (details) {
      for (const [name, value] of details) this[name] = value;
    }
  }
}

class UnclosedBlock extends ParseProblem {
  constructor(line: number, opener: string) {
    super("unclosed block", line, 1);
    this.opener = opener;
  }
  hint(): string {
    return `close the ${String(this.opener)} opened on line ${this.line}`;
  }
}

function isParseProblem(value: unknown): value is ParseProblem {
  return value instanceof ParseProblem;
}

function where(problem: ParseProblem, prefix: string): string {
  return `${prefix} ${problem.line}:${problem.column} ${problem.token ?? "no token"}`;
}

function parse(source: string): void {
  if (source === "token") {
    const details = new Map<string, unknown>();
    details.set("token", "}");
    details.set("expected", ["identifier", "string"]);
    throw new ParseProblem("unexpected token", 3, 7, details);
  }
  if (source === "number") {
    const details = new Map<string, unknown>();
    details.set("token", 12);
    details.set("radix", 8);
    throw new ParseProblem("bad number", 1, 2, details);
  }
  if (source === "empty") throw new ParseProblem("empty input", 0, 0);
  if (source === "block") throw new UnclosedBlock(9, "{");
  if (source === "plain") throw new Error("plain");
  if (source === "text") throw "text";
}

const SOURCES = ["token", "number", "empty", "block", "plain", "text", "fine"];

for (const source of SOURCES) {
  try {
    parse(source);
    console.log(source, "parsed");
  } catch (err) {
    if (isParseProblem(err)) {
      console.log(
        source,
        err.line,
        err.column,
        err.token,
        typeof err.token,
        err.expected?.length,
        err.radix,
        err.missing,
        err.message,
        "token" in err,
        "radix" in err,
      );
      console.log(source, where(err, "passed"), err.line === 3, err.token === "}");
      console.log(source, Object.keys(err).join(","), err instanceof UnclosedBlock ? err.hint() : "no hint");
    } else if (err instanceof Error) {
      console.log(source, "error", err.message);
    } else {
      console.log(source, "other", String(err));
    }
  }
}

// instanceof in the clause, an assertion, and a rethrow that keeps the object.
function recover(source: string): string {
  let seen: unknown;
  try {
    try {
      parse(source);
    } catch (err) {
      seen = err;
      if (err instanceof ParseProblem && err.line === 0) return "skipped " + err.message;
      throw err;
    }
  } catch (again) {
    const same = again === seen;
    if (again instanceof ParseProblem) return `rethrown ${same} ${(again as ParseProblem).column} ${again.token}`;
    return `rethrown ${same} ${String(again)}`;
  }
  return "parsed";
}
for (const source of SOURCES) console.log(source, recover(source));

// The same through a rejected promise.
async function parseLater(source: string): Promise<string> {
  await Promise.resolve();
  parse(source);
  return "done";
}
for (const source of SOURCES) {
  try {
    console.log(source, await parseLater(source));
  } catch (err: unknown) {
    console.log(source, isParseProblem(err) ? where(err, "rejected") : `rejected ${String(err)}`);
  }
}

// A property added after construction, and a destructuring declaration that
// takes declared and undeclared names alike.
try {
  const problem = new ParseProblem("too deep", 40, 2);
  problem.depth = 64;
  problem.limit = 32;
  throw problem;
} catch (err) {
  if (isParseProblem(err)) {
    const { depth, limit, line, absent, severity = "error" } = err;
    console.log(depth, limit, line, absent, severity, Object.keys(err).join(","));
  }
}

// `code` written by name: in the constructor, later, to another type, and
// to undefined. Every read agrees, by name, by key, through an untyped
// view, through the Error type, and in `in`.
class Coded extends Error {
  depth: number;
  [key: string]: any;
  constructor(depth: number, code?: string) {
    super("coded");
    this.depth = depth;
    if (code !== undefined) this.code = code;
    this.origin = "constructor";
  }
}
const first = new Coded(1, "first");
console.log(first.code, (first as any).code, first["code"], "code" in first, Object.keys(first).join(","));
first.code = "second";
console.log(first.code, typeof first.code, first.code === "second");
first.code = 7;
console.log(first.code, typeof first.code, "code" in first);
first.code = undefined;
console.log(first.code, "code" in first, Object.keys(first).join(","));
const bare = new Coded(2);
console.log(bare.code, "code" in bare, Object.keys(bare).join(","));
bare.code = "late";
const asError: Error = bare;
console.log(bare.code, "code" in asError, (asError as Error & { code?: string }).code, String(bare));
try {
  throw new Coded(3, "thrown");
} catch (err) {
  if (err instanceof Coded) console.log(err.code, err.code || "none", `${err.depth}:${err.code}`, err.origin);
  console.log(err instanceof Error && "code" in err);
}
