// Feature-detection probes of a member read through a type assertion.
//
// `input.api` is `Streams | Partial<Record<TApi, Streams>>` (optional) or
// `Streams | Record<K, Streams>` (required). Node erases `as`, so
// `(input.api as Streams).stream` reads the property off the value actually
// stored: when that is the record arm, the read answers undefined. The
// probe therefore answers "undefined" (false), where an eager checked
// extraction of Streams would throw on the record arm. A real use of the
// same read — calling the member when the wrong arm is stored — still
// throws, at the call.
type Api = "alpha" | "beta";

interface Streams {
  stream: () => string;
  fetch?: () => string;
}

interface Options<TApi extends Api> {
  name: string;
  api?: Streams | Partial<Record<TApi, Streams>>;
}

interface Required<K extends string> {
  name: string;
  api: Streams | Record<K, Streams>;
}

function detectTypeof<TApi extends Api>(input: Options<TApi>): boolean {
  return typeof (input.api as Streams).stream === "function";
}

function detectUndefined<TApi extends Api>(input: Options<TApi>): boolean {
  return (input.api as Streams).stream !== undefined;
}

function detectNullish<TApi extends Api>(input: Options<TApi>): boolean {
  return (input.api as Streams).stream == null;
}

function detectRequired<K extends string>(input: Required<K>): boolean {
  return typeof (input.api as Streams).stream === "function";
}

function requiredIn<K extends string>(input: Required<K>): boolean {
  return "stream" in (input.api as Streams);
}

// The probe guards the real use: the call runs only on the arm that has
// the member, so the assertion never lies at the call.
function streamName<TApi extends Api>(input: Options<TApi>): string {
  if (typeof (input.api as Streams).stream === "function") return (input.api as Streams).stream();
  return "none";
}

// A real use that reaches the wrong arm throws, as it does in Node.
function callStream<TApi extends Api>(input: Options<TApi>): string {
  try {
    return (input.api as Streams).stream();
  } catch (err) {
    return err instanceof TypeError ? "TypeError" : "other";
  }
}

const one: Streams = { stream: () => "one" };
const withFetch: Streams = { stream: () => "both", fetch: () => "fetch" };
const registry: Partial<Record<Api, Streams>> = { alpha: one, beta: withFetch };
const empty: Partial<Record<Api, Streams>> = {};
const required: Record<Api, Streams> = { alpha: one, beta: withFetch };

console.log(detectTypeof({ name: "one", api: one }));
console.log(detectTypeof({ name: "registry", api: registry }));
console.log(detectTypeof({ name: "empty", api: empty }));
console.log(detectUndefined({ name: "one", api: one }));
console.log(detectUndefined({ name: "registry", api: registry }));
console.log(detectNullish({ name: "one", api: one }));
console.log(detectNullish({ name: "registry", api: empty }));
console.log(streamName({ name: "one", api: one }));
console.log(streamName({ name: "registry", api: registry }));
console.log(detectRequired({ name: "one", api: one }));
console.log(detectRequired<"alpha" | "beta">({ name: "registry", api: required }));
console.log(requiredIn({ name: "one", api: one }));
console.log(requiredIn<"alpha" | "beta">({ name: "registry", api: required }));
console.log(callStream({ name: "one", api: withFetch }));
console.log(callStream({ name: "registry", api: registry }));

// `in` through an assertion over a computed receiver still evaluates the
// receiver, exactly once, whether the arms decide the answer (one tag test
// or several) or agree on it.
interface ArmA {
  a: number;
  x: number;
}
interface ArmB {
  b: number;
  x: number;
}
interface ArmC {
  c: number;
}
interface ArmD {
  d: number;
}
type Arm = ArmA | ArmB | ArmC | ArmD;
let boxed = 0;
function box(shape: Arm): { shape: Arm } {
  boxed++;
  return { shape };
}
const arms: Arm[] = [{ a: 1, x: 1 }, { b: 2, x: 2 }, { c: 3 }, { d: 4 }];
for (const arm of arms) console.log("x" in (box(arm).shape as ArmA), "gamma" in (box(arm).shape as ArmA));
console.log(boxed);

// A getter-backed member beside a data field of the same name: the probe
// reads the getter on its arm, as Node does.
interface Plain {
  kind: "plain";
  label: string;
}
interface Lazy {
  kind: "lazy";
  get label(): string;
}
let labelReads = 0;
const lazy: Lazy = {
  kind: "lazy",
  get label() {
    labelReads++;
    return "computed";
  },
};
const labelled: (Plain | Lazy)[] = [{ kind: "plain", label: "x" }, lazy];
for (const item of labelled) console.log(typeof (item as Plain).label, (item as Plain).label !== undefined);
console.log(labelReads);
