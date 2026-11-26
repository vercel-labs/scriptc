// An Array subclass with a traced class (a closure field) holds plain
// number[] rows: the rows have no collector header of their own, so the
// class instance's trace must not hand them to the collector as objects.
class RowStore extends Array<number[]> {
  tag = 1
  size(): number {
    return this.length
  }
  counter = (): number => this.length
}

let total = 0
for (let i = 0; i < 50; i++) {
  const rows = new RowStore()
  rows.push([i, i + 1], [i + 2])
  // Species results are subclass instances too, with the same rows.
  const mapped = rows.map((row) => row)
  const sliced = rows.slice(1)
  // A dynamic store through the view commits the storage into a checked
  // array that takes the class: the retyped instance still holds headerless
  // rows, so the commit must carry the guard that keeps the trace off them.
  const view: any = rows
  view["meta"] = i
  total += rows.size() + rows.counter() + mapped.length + sliced.length
}
console.log("total", total)

// A subclass of a value array mapped to rows retypes its species result to
// the row type: the retyped instance still holds headerless rows, so its
// trace keeps skipping them.
class Numbers extends Array<number> {
  counter = (): number => this.length
}
let numbersTotal = 0
for (let i = 0; i < 50; i++) {
  const numbers = new Numbers()
  numbers.push(i, i + 1)
  const pairs = numbers.map((n) => [n, n + 1])
  numbersTotal += numbers.counter() + pairs.length
}
console.log("numbers", numbersTotal)
