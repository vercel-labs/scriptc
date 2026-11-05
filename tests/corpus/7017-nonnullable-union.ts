// `NonNullable<T>` over a union: the type mapper maps the checker's answer
// directly — the union with its null/undefined arms removed — so the result
// is an ordinary union VALUE (tagged, narrowed, serialized like any other),
// not a checked-dynamic slot. `Compat` carries no unit arm, so
// `NonNullable<Compat>` is `Compat` itself; `Compat | undefined` loses the
// unit arm. The runtime values are Node's.
interface OpenAiCompat {
  kind: "openai";
  maxTokensField?: string;
  supportsStore?: boolean;
}

interface AnthropicCompat {
  kind: "anthropic";
  supportsLongCacheRetention?: boolean;
}

type Compat = OpenAiCompat | AnthropicCompat;

function takePrime(value: NonNullable<string | undefined>): string {
  return value;
}

function takeCompat(value: NonNullable<Compat | undefined>): Compat {
  return value;
}

function takeWhole(value: NonNullable<Compat>): Compat {
  return value;
}

function takeNested(value: NonNullable<NonNullable<Compat | undefined> | undefined>): Compat {
  return value;
}

// A generic `NonNullable<T>` resolves per instantiation the same way.
function takeGeneric<T>(value: T | undefined): NonNullable<T> {
  return value as NonNullable<T>;
}

function pick(flag: boolean): Compat {
  return flag ? { kind: "openai", supportsStore: true } : { kind: "anthropic" };
}

const asserted = pick(true) as NonNullable<Compat | undefined>;
const whole: NonNullable<Compat> = pick(false);
const generic = takeGeneric<Compat>({ kind: "openai", supportsStore: false });

console.log(
  takePrime("p"),
  JSON.stringify(takeCompat(pick(true))),
  JSON.stringify(takeWhole({ kind: "openai", supportsStore: true })),
  JSON.stringify(takeNested(pick(false))),
  JSON.stringify(asserted),
  JSON.stringify(whole),
  JSON.stringify(generic),
);

// The mapped type narrows like any union: each arm reads its own fields.
function describe(value: NonNullable<Compat>): string {
  if (value.kind === "openai") return `openai ${value.supportsStore} ${value.maxTokensField}`;
  return `anthropic ${value.supportsLongCacheRetention}`;
}

console.log(
  describe({ kind: "openai", supportsStore: true }),
  describe({ kind: "openai", maxTokensField: "max_completion_tokens" }),
  describe({ kind: "anthropic" }),
  describe({ kind: "anthropic", supportsLongCacheRetention: false }),
);

// An array of the mapped type is an ordinary array of the union value.
const all: NonNullable<Compat>[] = [takeCompat(pick(true)), pick(false)];
for (const entry of all) console.log(describe(entry));
