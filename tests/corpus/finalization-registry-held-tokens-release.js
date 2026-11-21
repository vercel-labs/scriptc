// A FinalizationRegistry accepts tokens whose kind has no weak lifetime (a
// Date handle) and holds them by value. The array that holds them grows as
// tokens are added; releasing the registry when its scope ends must return
// that array to the allocator that served it.
function useRegistry() {
  const registry = new FinalizationRegistry((held) => {});
  const tokens = [];
  for (let i = 0; i < 8; i++) {
    const token = new Date(i);
    tokens.push(token);
    registry.register({ value: i }, "held" + i, token);
  }
  for (const token of tokens) console.log(registry.unregister(token));
}
useRegistry();
console.log("done");
