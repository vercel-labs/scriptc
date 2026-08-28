// @dynamic
// STATIC promises crossing INTO the island as real engine thenables
// (lane dom-jsval-long-tail): a scriptc promise stored in an 'any' slot
// wraps through the async-callback return bridge (scr_jsval_from_promise)
// — typeof answers "object", the engine can await it, and a
// Promise<any[]> fulfillment re-enters as an engine array whose elements
// are the same engine values. Promise.all over MIXED island/static
// entries runs the ENGINE's own combinator (the withPlugins shape), the
// result staying an island value the static side awaits through the
// island→static bridge.

'use strict';
/** @returns {any} */
function mint() {
  return {
    /** @returns {Promise<any>} */
    load: async () => [{ name: "builtin" }],
    hold: null,
  };
}
const eng = mint();

/** @returns {any} */
function mintLoader() {
  return {
    /** @returns {Promise<any>} */
    one: async (x) => ({ got: `${x}` }),
  };
}
const loader = mintLoader();

// the loadPlugins shape: Promise.all over a NON-literal any[] argument,
// through an INFERRED Promise<any[]> return — the bridge's array payload
// exits Array.isArray-gated by reference at the settle
function loadAll(xs = []) {
  return Promise.all(xs.map((x) => loader.one(x)));
}

/** @returns {Promise<any[]>} */
async function loadOthers(xs = []) {
  // Keep the promise pending when it crosses into the island. WASI's
  // stackless scheduler must resume the runtime bridge after this timer,
  // not try to suspend the bridge's ordinary C stack.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return xs.map((x) => ({ name: `${x}` }));
}

async function main(...args) {
  const options = args[0] ?? {};
  const { plugins = [] } = options;

  // an unawaited static promise in an island slot: a real thenable
  eng.hold = { p: loadOthers(["x"]) };
  console.log(`typeof ${typeof eng.hold.p}`);
  const held = await eng.hold.p;
  console.log(`held ${held.length} ${held[0].name}`);

  // the withPlugins shape: mixed entries, engine Promise.all, .flat()
  args[0] = {
    ...options,
    plugins: (
      await Promise.all([
        eng.load(),
        loadOthers(plugins),
      ])
    ).flat(),
  };
  console.log(`len ${args[0].plugins.length} first ${args[0].plugins[0].name} second ${args[0].plugins[1].name}`);

  const got = await loadAll(["a", "b"]);
  console.log(`all ${got.length} ${got[0].got} ${got[1].got}`);
}
void main({ plugins: ["p1"] });
