// A width copy reads an undeclared target field from the source object it
// keeps. When that key is an accessor and the getter throws, the read's
// exception must reach the same catch as the erased assertion's own property
// read: the copy is built where the assertion sits, and no field value may be
// consumed from the failed read first. A target whose extra field is of the
// untyped kind is the case that carries no check of its own, so only the
// read's exception marks the projection as throwing.

interface Tool {
  name: string;
  label: string;
}
interface Wide {
  name: string;
  payload?: unknown;
}
interface Typed {
  name: string;
  snip?: string;
}

function tool(): any {
  return JSON.parse('{"name":"g","label":"G"}');
}

// The projection inside a function throws into the caller's catch.
function widen(t: Tool): Wide {
  return t as unknown as Wide;
}

function payloadSource(message: string): Tool {
  const source = tool();
  Object.defineProperty(source, "payload", {
    get() {
      throw new Error(message);
    },
    enumerable: true,
    configurable: true,
  });
  return source as Tool;
}

function snipSource(): Tool {
  const source = tool();
  Object.defineProperty(source, "snip", {
    get() {
      throw "plain";
    },
    enumerable: true,
    configurable: true,
  });
  return source as Tool;
}

// The assertion sits inside the try, so the read that throws is inside it,
// and the statement after it never runs.
try {
  const w = payloadSource("direct") as unknown as Wide;
  console.log("direct", String(w.payload), w.name);
} catch (e) {
  console.log("direct-caught", (e as Error).message);
}

// A typed target field checks the read value; the throw wins over the check.
try {
  const t = snipSource() as unknown as Typed;
  console.log("typed", String(t.snip), t.name);
} catch (e) {
  console.log("typed-caught", String(e));
}

// The projection inside a function throws into the caller's catch.
try {
  const w = widen(payloadSource("fn"));
  console.log("fn", w.name.toUpperCase(), String(w.payload));
} catch (e) {
  console.log("fn-caught", (e as Error).message);
}

// The failed read is not consumed by the surrounding expression.
try {
  const w = payloadSource("mixed") as unknown as Wide;
  console.log("mixed", w.name.toUpperCase(), String(w.payload ?? "none"));
} catch (e) {
  console.log("mixed-caught", (e as Error).message);
}

// A second copy of the same source answers the same way, and the keys the
// copy does declare are still projected around the failing one.
try {
  const first = payloadSource("twice");
  const one = first as unknown as Wide;
  console.log("twice", String(one.payload), one.name);
} catch (e) {
  console.log("twice-caught", (e as Error).message);
}

// An accessor that answers normally still projects its value, once.
const okSource = tool();
let reads = 0;
Object.defineProperty(okSource, "payload", {
  get() {
    reads++;
    return { deep: true };
  },
  enumerable: true,
  configurable: true,
});
const ok = okSource as Tool;
const ow = ok as unknown as Wide;
console.log("ok", JSON.stringify(ow.payload), reads, ow.name);

// The copy answers a source without the key as absent, getter or not.
const bare = tool() as Tool;
const bw = bare as unknown as Typed;
console.log("bare", String(bw.snip), "snip" in bw, bw.name);
