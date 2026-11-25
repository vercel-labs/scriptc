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
  total += rows.size() + rows.counter() + mapped.length + sliced.length
}
console.log("total", total)
