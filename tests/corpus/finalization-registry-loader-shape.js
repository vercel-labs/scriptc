// The wasm-loader shape: a registry that tracks wrapper objects through the
// global, with the cleanup callback never running (no collection is
// observable). Node prints the bookkeeping answers below.
if (typeof FinalizationRegistry === "undefined") {
  console.log("no registry");
} else {
  const registry = new FinalizationRegistry((held) => {
    console.log("collected", held);
  });
  const wrapper = { id: 1 };
  const result = registry.register(wrapper, { id: wrapper.id }, wrapper);
  console.log(typeof result, registry instanceof FinalizationRegistry);
  console.log(registry.unregister(wrapper), registry.unregister(wrapper));
  console.log(wrapper.id);
}
