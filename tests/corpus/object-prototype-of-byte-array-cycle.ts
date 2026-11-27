// An array of byte views that receives a prototype: the array carries the
// collector header, and its elements are byte views whose blocks have no
// collector header. The collector must not walk them as headered objects;
// the array's teardown releases them. The sanitized lane (ASan + RC audit)
// proves both.
let total = 0
for (let i = 0; i < 200; i++) {
  const chunks: Uint8Array[] = [new Uint8Array([i % 251]), new Uint8Array([(i + 1) % 251])]
  const chunksPrototype = {
    first(): number {
      return chunks[0]![0]!
    },
  }
  Object.setPrototypeOf(chunks, chunksPrototype)
  total += (Object.getPrototypeOf(chunks) as { first(): number }).first()
}
console.log("total", total)
