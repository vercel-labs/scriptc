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
// Reflect.setPrototypeOf reaches the same prototype storage through the
// Reflect wrapper: the array kinds it can touch are stamped as well, so the
// cycle through the stored prototype is one the collector walks.
for (let i = 0; i < 200; i++) {
  const list: number[] = [i]
  const listPrototype = {
    first(): number {
      return list[0]!
    },
  }
  Reflect.setPrototypeOf(list, listPrototype)
  total += listPrototype.first()
}
// An array of arrays given a prototype: its child slots are arrays the
// collector walks, so every array in the program must be a collector object
// too, or a plain child would be read as one.
for (let i = 0; i < 50; i++) {
  const outer: number[][] = [[i, i + 1], [i + 2]]
  const outerPrototype = {
    first(): number {
      return outer[0]![0]!
    },
  }
  Object.setPrototypeOf(outer, outerPrototype)
  total += outerPrototype.first()
}
// Arrays of strings and of booleans given prototypes: each element is
// released exactly once, at the element kind's slot width.
for (let i = 0; i < 50; i++) {
  const words: string[] = ["a" + i, "b" + i, "c" + i]
  const wordPrototype = {
    sized(): number {
      return words.length
    },
  }
  Object.setPrototypeOf(words, wordPrototype)
  total += wordPrototype.sized()
  const flags: boolean[] = [i % 2 === 0, true, false]
  // A non-index property holds the element kind's own value (a raw boolean
  // here), not a pointer: the array's trace must not walk it as an object.
  const looseFlags: any = flags
  looseFlags[-1] = true
  const flagPrototype = {
    sized(): number {
      return flags.length
    },
  }
  Object.setPrototypeOf(flags, flagPrototype)
  total += flagPrototype.sized()
}
console.log("total", total)
