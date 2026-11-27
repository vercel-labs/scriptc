// Blob and File tokens are remembered by the registry's identity bookkeeping
// rather than a weak-map entry: registering and unregistering them answers
// like Node, and the registry keeps no reference that would pin their bytes.
const registry = new FinalizationRegistry(() => {});
const blob = new Blob([new Uint8Array(4)]);
const file = new File([new Uint8Array(4)], "x.bin");
registry.register({ a: 1 }, "blob", blob);
registry.register({ b: 2 }, "file", file);
console.log("unregister blob", registry.unregister(blob), registry.unregister(blob));
console.log("unregister file", registry.unregister(file));
console.log("other blob", registry.unregister(new Blob([new Uint8Array(4)])));
