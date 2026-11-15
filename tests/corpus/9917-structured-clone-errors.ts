// structuredClone of an Error, at untyped and typed call sites: the copy is
// a new error of the nearest of Error and its six native subclasses that the
// source's name spells, with the source's own message, its stack, and a
// clone of its own cause. The class, an own name, extra properties and an
// AggregateError's errors do not travel. An error referenced twice clones
// once, and a cause may lead back to its error.
function facts(label: string, o: unknown, c: unknown): void {
  const out: string[] = [];
  const fact = (k: string, f: () => unknown): void => {
    try {
      out.push(k + "=" + String(f()));
    } catch (e) {
      out.push(k + "=!" + (e instanceof Error ? e.name + ": " + e.message : String(e)));
    }
  };
  fact("same", () => c === o);
  fact("typeof", () => typeof c);
  fact("isError", () => c instanceof Error);
  fact("inst", () =>
    [c instanceof TypeError, c instanceof RangeError, c instanceof SyntaxError, c instanceof ReferenceError, c instanceof EvalError, c instanceof URIError, c instanceof AggregateError]
      .map((b) => (b ? "1" : "0"))
      .join(""),
  );
  fact("name", () => (c as { name: unknown }).name);
  fact("message", () => JSON.stringify((c as { message: unknown }).message));
  fact("tStack", () => typeof (c as { stack: unknown }).stack);
  fact("stack0", () => String((c as { stack: unknown }).stack).split("\n")[0]);
  fact("stackSame", () => (c as { stack: unknown }).stack === (o as { stack: unknown }).stack);
  fact("cause", () => String((c as { cause: unknown }).cause));
  fact("hasCause", () => Object.prototype.hasOwnProperty.call(c, "cause"));
  fact("keys", () => Object.keys(c as object).join(","));
  fact("own", () => Object.getOwnPropertyNames(c as object).join(","));
  fact("json", () => JSON.stringify(c));
  fact("str", () => String(c));
  fact("tag", () => Object.prototype.toString.call(c));
  console.log(label + " :: " + out.join(" ;; "));
}

function run(label: string, make: () => unknown): void {
  let o: unknown;
  try {
    o = make();
  } catch (e) {
    console.log(label + " :: make threw " + String(e));
    return;
  }
  let c: unknown;
  try {
    c = structuredClone(o);
  } catch (e) {
    console.log(label + " :: clone threw " + (e instanceof Error ? e.name + ": " + e.message : String(e)));
    return;
  }
  facts(label, o, c);
}

class AppError extends Error {
  code: string;
  constructor(m: string, code: string) {
    super(m);
    this.name = "AppError";
    this.code = code;
  }
}
class QuietError extends TypeError {
  extra = 7;
}
class DeepError extends QuietError {}
class SpelledError extends Error {
  override get name(): string {
    return "SyntaxError";
  }
}
class OtherError extends RangeError {
  override get name(): string {
    return "Other";
  }
}

run("error", () => new Error("plain"));
run("error-empty", () => new Error());
run("type", () => new TypeError("t"));
run("range", () => new RangeError("r"));
run("syntax", () => new SyntaxError("s"));
run("reference", () => new ReferenceError("ref"));
run("eval", () => new EvalError("ev"));
run("uri", () => new URIError("u"));
run("aggregate", () => new AggregateError([new Error("e1"), new TypeError("e2")], "agg"));
run("cause-error", () => new TypeError("typed", { cause: new RangeError("inner") }));
run("cause-string", () => new Error("outer", { cause: "why" }));
run("cause-object", () => new Error("outer", { cause: { a: 1, b: [2, 3] } }));
run("cause-undefined", () => new Error("outer", { cause: undefined }));
run("cause-nested", () => new Error("a", { cause: new TypeError("b", { cause: new RangeError("c") }) }));
run("class-named", () => new AppError("app", "E_APP"));
run("class-quiet", () => new QuietError("quiet"));
run("class-deep", () => new DeepError("deep"));
run("class-name-getter", () => new SpelledError("spelled"));
run("class-name-getter-other", () => new OtherError("other"));
run("extra-props", () => {
  const e = new Error("with extras") as Error & { code?: string; detail?: unknown };
  e.code = "E_X";
  e.detail = { n: 1 };
  return e;
});
run("renamed", () => {
  const e = new Error("renamed");
  e.name = "RangeError";
  return e;
});
run("renamed-custom", () => {
  const e = new TypeError("custom");
  e.name = "Custom";
  return e;
});
run("stack-replaced", () => {
  const e = new Error("st");
  e.stack = "replaced stack";
  return e;
});
run("message-replaced", () => {
  const e = new Error("first");
  e.message = "second";
  return e;
});

// Nested positions: what the nested value is.
{
  const src = { a: 1, err: new RangeError("nested") };
  const c = structuredClone(src) as { a: number; err: unknown };
  facts("in-object.err", src.err, c.err);
  const arrSrc = [new Error("in array"), 2];
  const arr = structuredClone(arrSrc) as unknown[];
  facts("in-array[0]", arrSrc[0], arr[0]);
  const mapSrc = new Map<string, Error>([["k", new TypeError("in map")]]);
  const m = structuredClone(mapSrc);
  facts("in-map.k", mapSrc.get("k"), m.get("k"));
  const setSrc = new Set<Error>([new SyntaxError("in set")]);
  const st = structuredClone(setSrc);
  for (const member of st) facts("in-set.member", [...setSrc][0], member);
  const twice = new Error("twice");
  const pair = structuredClone([twice, twice]) as unknown[];
  console.log("shared :: " + String(pair[0] === pair[1]) + " " + String(pair[0] === twice));
}

// The cause of a clone.
{
  const inner = new RangeError("inner");
  const outer = new TypeError("typed", { cause: inner });
  const c = structuredClone(outer) as unknown as { cause: unknown };
  facts("cause-of-clone", inner, c.cause);
}

// A cycle through cause.
{
  const a = new Error("cyc") as Error & { cause?: unknown };
  a.cause = a;
  try {
    const c = structuredClone(a) as unknown as { cause: unknown };
    console.log("cycle-self :: " + String(c !== (a as unknown)) + " " + String(c.cause === c) + " " + String(c instanceof Error));
  } catch (e) {
    console.log("cycle-self :: threw " + (e instanceof Error ? e.name + ": " + e.message : String(e)));
  }
  const x = new Error("x") as Error & { cause?: unknown };
  const y = new TypeError("y", { cause: x });
  x.cause = y;
  try {
    const c = structuredClone(x) as unknown as { cause: { cause: unknown } };
    console.log("cycle-two :: " + String(c.cause.cause === c) + " " + String(c.cause instanceof TypeError));
  } catch (e) {
    console.log("cycle-two :: threw " + (e instanceof Error ? e.name + ": " + e.message : String(e)));
  }
}

// The clone is an error: it can be thrown and caught as one.
{
  const c: unknown = structuredClone(new TypeError("thrown clone") as unknown);
  try {
    throw c;
  } catch (e) {
    console.log("throw :: " + String(e === c) + " " + String(e instanceof TypeError) + " " + String(e));
  }
}

// Typed call sites: the copy checks back into Error.
function line(label: string, parts: unknown[]): void {
  console.log(label + " :: " + parts.map((p) => String(p)).join(" ;; "));
}

{
  const e = new Error("plain");
  const c = structuredClone(e);
  line("error", [c === e, c instanceof Error, c.name, c.message, typeof c.stack, c.stack === e.stack, String(c.stack).split("\n")[0], String(c), c.cause === undefined]);
}
{
  const e = new Error("outer", { cause: "why" });
  const c = structuredClone(e);
  line("cause-string", [c.message, typeof c.cause, String(c.cause)]);
}
{
  const e = new Error("first");
  e.message = "second";
  e.stack = "replaced stack";
  const c = structuredClone(e);
  line("replaced", [c.message, c.stack, String(c)]);
}
{
  const e = new Error("renamed");
  e.name = "RangeError";
  const c = structuredClone(e);
  line("renamed", [c instanceof RangeError, c.name, c.message, String(c)]);
}
{
  const src = [new Error("in array"), new Error("second")];
  const c = structuredClone(src);
  line("in-array", [c.length, c[0] === src[0], c[0] instanceof Error, c[0]!.message, c[1]!.message]);
}
{
  const src = new Map<string, Error>([["k", new TypeError("in map")]]);
  const c = structuredClone(src);
  const got = c.get("k");
  line("in-map", [c.size, got === src.get("k"), got instanceof TypeError, got?.name, got?.message]);
}
{
  const e: Error | string = Math.random() < 2 ? new TypeError("union") : "text";
  const c = structuredClone(e);
  line("union", [typeof c, c instanceof Error, c instanceof TypeError, c instanceof Error ? c.message : c]);
}
{
  const e = new Error("first");
  const seen: unknown = e;
  console.log("crossed", Object.keys(seen as object).length);
  e.message = "second";
  e.name = "TypeError";
  const c = structuredClone(e);
  line("typed-write-after-crossing", [c.message, c.name, c instanceof TypeError, String(c)]);
}

{
  const e = new Error("typed throw");
  const c = structuredClone(e);
  try {
    throw c;
  } catch (err) {
    line("throw", [err === c, err === e, err instanceof Error, String(err)]);
  }
}
