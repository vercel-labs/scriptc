// An async function with a typed result that returns a checked-dynamic value
// resolves its promise with that value, as JS does: a promise behind the value
// is adopted (the function settles with its result, two microtask turns after
// a plain value would, the same turns as a returned typed promise), and any
// other value settles the function at once. The adoption runs after every
// crossed finally, and a rejected promise rejects the function instead of
// reaching its own catch. Concise arrow bodies follow the same rule. The
// first case is a store's add path: a helper whose schema parameter does not
// map is a checked-dynamic value, so the promise of its call is dynamic too.

/** @typedef {Record<string, unknown> & { id?: string | number }} Row */
/** @typedef {{ id: string }} Item */

/** @type {{ upload(value: unknown): Promise<string> } | null} */
let storage = null;
if (process.argv.length > 99) storage = { upload: async (value) => String(value) };

/**
 * @param {Record<string, Function & { fieldType?: string }> | undefined} schema
 * @param {Row} row
 * @returns {Promise<Row>}
 */
const uploadFiles = async (schema, row) => {
  if (!storage || !schema) return row;
  const provider = storage;
  /** @type {Row} */
  const out = Object.fromEntries(Object.entries(row));
  for (const [field, def] of Object.entries(schema))
    if (def.fieldType === "file") out[field] = await provider.upload(out[field]);
  return out;
};

/**
 * @param {Record<string, Function & { fieldType?: string }> | undefined} schema
 * @param {Row} data
 * @returns {Promise<Row>}
 */
const prepareAdd = async (schema, data) => {
  const row = await Promise.resolve(Object.fromEntries(Object.entries(data)));
  if (row.id == null) row.id = "n1";
  return uploadFiles(schema, row);
};

const title = Object.assign(() => 1, { fieldType: "text" });
const stored = await prepareAdd({ title }, { title: "first" });
console.log(typeof stored, stored.id, stored.title);

/** @type {string[]} */
const log = [];

/** @param {string} tag @param {number} steps */
function ticker(tag, steps) {
  let p = Promise.resolve();
  for (let i = 0; i < steps; i++) {
    const k = i;
    p = p.then(() => {
      log.push(tag + k);
    });
  }
  return p;
}

/** @type {(value: unknown) => any} */
const opaque = (value) => value;

/** @param {Item} item @returns {Promise<Item>} */
async function dynamicPromise(item) {
  return opaque(Promise.resolve(item));
}

/** @param {Item} item @returns {Promise<Item>} */
async function dynamicValue(item) {
  return opaque(item);
}

/** @param {Item} item @returns {Promise<Item>} */
async function typedPromise(item) {
  return Promise.resolve(item);
}

/** @returns {Promise<number>} */
async function dynamicNumber() {
  return opaque(41) + 1;
}

/** @param {string} label @param {() => Promise<Item>} call */
async function ordering(label, call) {
  log.length = 0;
  const ticks = ticker("t", 6);
  const settled = call().then((item) => {
    log.push(`${label}:${item.id}`);
  });
  await Promise.all([ticks, settled]);
  console.log(log.join(" "));
}

await ordering("dynamic-promise", () => dynamicPromise({ id: "a" }));
await ordering("dynamic-value", () => dynamicValue({ id: "b" }));
await ordering("typed-promise", () => typedPromise({ id: "c" }));
console.log("number", await dynamicNumber());

/** @param {Item} item @returns {Promise<Item>} */
async function guarded(item) {
  try {
    log.push("try");
    return opaque(Promise.resolve(item));
  } finally {
    log.push("finally");
  }
}

/** @param {Item} item @returns {Promise<Item>} */
async function awaitedCaller(item) {
  const got = await guarded(item);
  log.push(`caller:${got.id}`);
  return got;
}

log.length = 0;
const ticks = ticker("t", 6);
const viaCaller = await awaitedCaller({ id: "g" });
await ticks;
console.log(viaCaller.id, log.join(" "));

/** @returns {Promise<Item>} */
async function rejecting() {
  try {
    return opaque(Promise.reject(new Error("no")));
  } catch {
    log.push("own catch");
    return { id: "caught" };
  }
}

log.length = 0;
try {
  const item = await rejecting();
  console.log("fulfilled", item.id);
} catch (error) {
  console.log("rejected", error instanceof Error ? error.message : String(error), log.length);
}

/** @type {(item: Item) => Promise<Item>} */
const concisePromise = async (item) => opaque(Promise.resolve(item));

/** @type {(item: Item) => Promise<Item>} */
const conciseValue = async (item) => opaque(item);

log.length = 0;
const conciseTicks = ticker("t", 5);
await Promise.all([
  conciseTicks,
  concisePromise({ id: "p" }).then((item) => {
    log.push(item.id);
  }),
  conciseValue({ id: "v" }).then((item) => {
    log.push(item.id);
  }),
]);
console.log(log.join(" "));
