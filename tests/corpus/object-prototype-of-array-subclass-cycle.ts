// An Array subclass instance with primitive elements receives a prototype
// whose method closure captures the instance: the instance carries the
// collector header, and its trace must visit the stored prototype whatever
// the element type is, or the cycle never dies. The sanitized lane (ASan +
// RC audit) proves the graph is reclaimed.
class Row extends Array<number> {}

let total = 0
for (let i = 0; i < 200; i++) {
  const row = new Row()
  row.push(i)
  const rowPrototype = {
    first(): number {
      return row[0]!
    },
  }
  Object.setPrototypeOf(row, rowPrototype)
  total += (Object.getPrototypeOf(row) as { first(): number }).first()
}
console.log("total", total)
