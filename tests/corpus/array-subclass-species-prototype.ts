// A subclass whose constructor replaces its instances' prototype: the
// instance's own `constructor` then resolves through that prototype chain to
// Array, so Node's species is the Array constructor and map/slice build plain
// arrays. A species result must not inherit the replaced prototype, and the
// retyped (map to another element type) case must not either.
const customProto: any = Object.create(Array.prototype)
customProto.marker = true
class C extends Array<number> {
  constructor(len: number = 0) {
    super(len)
    Object.setPrototypeOf(this, customProto)
  }
}
const c = new C()
c.push(1, 2)
const mapped = c.map((x) => x)
console.log("map", mapped.length, Object.getPrototypeOf(mapped) === customProto, (Object.getPrototypeOf(mapped) as any).marker === true)
const retyped = c.map((x) => [x])
console.log("retyped", retyped.length, Object.getPrototypeOf(retyped) === customProto, (Object.getPrototypeOf(retyped) as any).marker === true)
const sliced = c.slice()
console.log("slice", sliced.length, Object.getPrototypeOf(sliced) === customProto, (Object.getPrototypeOf(sliced) as any).marker === true)
