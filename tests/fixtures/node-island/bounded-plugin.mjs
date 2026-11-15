// Island code (loaded with requireModule): the module it loads only at run
// time, through a BOUNDED argument, is a module the program compiles, so
// the island loader answers the live native instance.
export async function loadDyn() {
  const ns = await import("./bounded" + "-dyn.mjs");
  const seen = ns.entries();
  const next = ns.note("island-dyn");
  return `${seen} -> ${next} ns=${ns.hits}`;
}
