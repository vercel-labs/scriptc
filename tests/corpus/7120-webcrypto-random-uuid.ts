// crypto.randomUUID() on the WebCrypto global, directly and through
// globalThis: version-4 UUIDs, distinct on every call, and inside
// closures and default parameters the way request-id middleware uses it.
const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const direct: string = crypto.randomUUID();
console.log(direct.length, shape.test(direct));
const viaGlobalThis = globalThis.crypto.randomUUID();
console.log(viaGlobalThis.length, shape.test(viaGlobalThis), viaGlobalThis !== direct);

const seen = new Set<string>();
for (let i = 0; i < 100; i++) seen.add(crypto.randomUUID());
console.log("distinct", seen.size);

function requestId(generator: () => string = () => crypto.randomUUID()): string {
  return generator();
}
console.log(shape.test(requestId()), requestId(() => "fixed"));

const ids = ["a", "b", "c"].map((name) => ({ name, id: crypto.randomUUID() }));
console.log(ids.every((entry) => shape.test(entry.id)), ids[0]!.id !== ids[1]!.id);
console.log(typeof crypto.randomUUID());
