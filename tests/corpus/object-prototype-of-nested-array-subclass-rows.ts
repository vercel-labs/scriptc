// An array of arrays receives a prototype: every array kind is forced, so a
// row—an Array subclass instance with primitive elements—is traced as a child
// and needs the collector header as well. The sanitized lane (ASan + RC
// audit) fails if the collector walks a headerless row.
class Row extends Array<number> {}

let total = 0
for (let i = 0; i < 200; i++) {
  const rows: Row[] = [new Row(), new Row()]
  rows[0]!.push(i)
  const rowsPrototype = {
    first(): number {
      return rows[0]![0]!
    },
  }
  Object.setPrototypeOf(rows, rowsPrototype)
  total += (Object.getPrototypeOf(rows) as { first(): number }).first()
}
console.log("total", total)
