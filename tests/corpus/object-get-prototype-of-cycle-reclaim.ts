// A prototype whose method closure captures the receiver is a cycle:
// the receiver's stored prototype -> the prototype -> its closure -> the
// receiver. The receiver owns the reference (a hidden slot in the record
// struct, a hidden property of the array's metadata), so its own trace
// reports it and the collector subtracts that edge with the receiver's other
// children and reclaims the whole graph once the program drops it. The
// sanitized lane (ASan + RC audit) proves zero live heap at exit.
let total = 0
for (let i = 0; i < 200; i++) {
  const record = { value: i }
  const recordPrototype = {
    read(): number {
      return record.value
    },
  }
  Object.setPrototypeOf(record, recordPrototype)
  total += recordPrototype.read()
}
for (let i = 0; i < 200; i++) {
  const list: number[] = [i]
  const listPrototype = {
    first(): number {
      return list[0]!
    },
  }
  Object.setPrototypeOf(list, listPrototype)
  total += listPrototype.first()
}
console.log("total", total)
