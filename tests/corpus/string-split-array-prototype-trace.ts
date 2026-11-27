// A checked-dynamic Object.setPrototypeOf marks every array kind as able to
// carry a prototype, so a string array is traced. String.split builds its
// result through the inline constructor, which must give such an array the
// collector header as well: the sanitized lane (ASan + RC audit) fails if a
// split result reaches the collector without one.
let total = 0
const pending: Promise<string[]>[] = []
for (let i = 0; i < 200; i++) {
  let record: any = { value: i }
  const recordPrototype = {
    read(): number {
      return (record as { value: number }).value
    },
  }
  Object.setPrototypeOf(record, recordPrototype)
  total += (Object.getPrototypeOf(record) as { read(): number }).read()
  pending.push(Promise.resolve("x,y,z".split(",")))
}
pending.length = 0
console.log("total", total)
