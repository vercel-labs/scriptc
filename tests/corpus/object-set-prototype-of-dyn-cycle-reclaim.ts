// A record and an array held as checked-dynamic values reach
// Object.setPrototypeOf, and the prototype's method closure captures the
// receiver: the receiver owns the prototype (a hidden slot in the record,
// the array's own metadata), so the collector walks the edge and reclaims
// the whole graph when the program drops it. The sanitized lane (ASan + RC
// audit) proves zero live heap at exit.
let total = 0
for (let i = 0; i < 200; i++) {
  let record: any = { value: i }
  const recordPrototype = {
    read(): number {
      return (record as { value: number }).value
    },
  }
  Object.setPrototypeOf(record, recordPrototype)
  total += (Object.getPrototypeOf(record) as { read(): number }).read()
}
for (let i = 0; i < 200; i++) {
  let list: any = [i, i + 1]
  const listPrototype = {
    first(): number {
      return (list as number[])[0]!
    },
  }
  Object.setPrototypeOf(list, listPrototype)
  total += (Object.getPrototypeOf(list) as { first(): number }).first()
}
console.log("total", total)
