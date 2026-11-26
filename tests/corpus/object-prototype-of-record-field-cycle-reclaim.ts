// A class instance owns a record that receives a prototype: the record's
// hidden slot keeps the prototype, and the prototype's method closure
// captures the class instance. The class sits on that cycle, so the
// collector must trace it too — the prototype-bearing record is seeded into
// the cycle analysis, and every shape that holds it inherits the answer. The
// sanitized lane (ASan + RC audit) proves the graph is reclaimed.
class Holder {
  item = { value: 0 }
}

let total = 0
for (let i = 0; i < 200; i++) {
  const holder = new Holder()
  holder.item.value = i
  const itemPrototype = {
    read(): number {
      return holder.item.value
    },
  }
  Object.setPrototypeOf(holder.item, itemPrototype)
  total += (Object.getPrototypeOf(holder.item) as { read(): number }).read()
}
console.log("total", total)
