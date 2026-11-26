/* A dynamic collection key must keep one identity with the value the program
 * holds: the conversion adopts the value as a live capsule of the key built
 * from it, so a later insertion or lookup of the same value answers the same
 * key. A frozen dynamic object cannot be adopted, so the conversion refuses
 * the key instead of storing a copy the program's other name does not share.
 * Node accepts the insertion, so this stays a runtime refusal rather than a
 * compile-time one. */
type Layer = { parent: Layer | null; order: number };

function store(value: any): void {
  const set = new Set<Layer>();
  try {
    set.add(value);
    console.log("stored", set.size, set.has(value));
  } catch (error: any) {
    console.log("refused", error.name, error.code, error.message);
  }
}

store(Object.freeze(JSON.parse('{"parent":null,"order":1}')));
store(JSON.parse('{"parent":null,"order":1}'));
