// A presence probe whose receiver is a call over a union whose arms unify to
// one shape still runs the call exactly once, and an absent optional arm
// answers `in` and a bracketed member read with Node's own TypeError text.
interface Alpha {
  stream: () => string;
}
interface Beta {
  stream: () => string;
}
const side: string[] = [];
function assertArm(): { api: Alpha | Beta } {
  side.push("assertArm");
  return { api: { stream: () => "s" } };
}
function plainArm(): { api: Alpha | Beta } {
  side.push("plainArm");
  return { api: { stream: () => "s" } };
}
console.log("asserted", "stream" in (assertArm().api as Alpha));
console.log("asserted-missing", "nope" in (assertArm().api as Alpha));
console.log("plain", "stream" in plainArm().api);
console.log("plain-missing", "nope" in plainArm().api);
console.log("side", side.join(","));

type Api = "alpha" | "beta";
interface Streams {
  stream: () => string;
}
interface Required {
  api: Streams | Record<Api, Streams>;
}
interface Optional {
  api?: Streams | Partial<Record<Api, Streams>>;
}
function requiredIn(input: Required): boolean {
  return "stream" in (input.api as Streams);
}
function requiredIndexUndefined(input: Required): boolean {
  return (input.api as Streams)["stream"] !== undefined;
}
function optionalIn(input: Optional): boolean {
  return "stream" in (input.api as Streams);
}
function optionalIndexNullish(input: Optional): boolean {
  return (input.api as Streams)["stream"] == null;
}
const one: Streams = { stream: () => "one" };
const registry: Record<Api, Streams> = { alpha: one, beta: one };
const partial: Partial<Record<Api, Streams>> = { alpha: one };
console.log("req-in", requiredIn({ api: one }), requiredIn({ api: registry }));
console.log(
  "req-undef",
  requiredIndexUndefined({ api: one }),
  requiredIndexUndefined({ api: registry }),
);
console.log("opt-in", optionalIn({ api: one }), optionalIn({ api: partial }));
console.log("opt-null", optionalIndexNullish({ api: one }), optionalIndexNullish({ api: partial }));
try {
  console.log("opt-missing", optionalIn({}));
} catch (err) {
  console.log(
    "opt-missing threw",
    err instanceof TypeError ? "TypeError" : "other",
    (err as Error).message,
  );
}
try {
  console.log("opt-idx-missing", optionalIndexNullish({}));
} catch (err) {
  console.log(
    "opt-idx-missing threw",
    err instanceof TypeError ? "TypeError" : "other",
    (err as Error).message,
  );
}
