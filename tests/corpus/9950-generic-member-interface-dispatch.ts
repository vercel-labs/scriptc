// A generic member declared only on an interface a class-backed value is
// seen through: the runtime class has no such member, so the call reads it
// from the value at run time and throws Node's TypeError.
class Box {
  label(): string {
    return "box"
  }
}
interface Box {
  pick<T extends number>(x: T): T
}

const box = new Box()
console.log(box.label())
try {
  console.log((box as Box).pick(3))
} catch (error) {
  console.log("threw", (error as Error).message)
}
