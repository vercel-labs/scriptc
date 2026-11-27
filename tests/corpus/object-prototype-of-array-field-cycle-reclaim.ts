// A class instance owns an array that receives a prototype: the array keeps
// the prototype on its own metadata, and the prototype's method closure
// captures the class instance. The class sits on that cycle, so the analysis
// seeds an array of a prototype-bearing element kind as able to reach
// anything, and every shape that holds the array inherits the answer. The
// sanitized lane (ASan + RC audit) proves the graph is reclaimed.
class Holder {
  items: number[] = [0]
}

let total = 0
for (let i = 0; i < 200; i++) {
  const holder = new Holder()
  holder.items[0] = i
  const itemsPrototype = {
    read(): number {
      return holder.items[0]!
    },
  }
  Object.setPrototypeOf(holder.items, itemsPrototype)
  total += (Object.getPrototypeOf(holder.items) as { read(): number }).read()
}
console.log("total", total)
