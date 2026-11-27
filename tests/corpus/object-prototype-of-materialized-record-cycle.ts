// A record capsule that has already built its view still owns its hidden
// prototype slot: Object.setPrototypeOf must store the prototype there (the
// receiver's own edge), not in the fallback table. The prototype's method
// closure captures the receiver, and the sanitized lane (ASan + RC audit)
// proves the graph is reclaimed.
let total = 0
for (let i = 0; i < 200; i++) {
  const record = { value: i }
  const view: any = record
  // An undeclared property keeps the record's extra-property table, and
  // serializing and listing it builds the capsule's view: either way the
  // capsule's live field table no longer answers, and the prototype must
  // still land in the record's own slot.
  Reflect.set(view, "extra", i)
  JSON.stringify(view)
  Object.keys(view)
  const recordPrototype = {
    read(): number {
      return record.value
    },
  }
  Object.setPrototypeOf(view, recordPrototype)
  total += (Object.getPrototypeOf(view) as { read(): number }).read()
}
console.log("total", total)
