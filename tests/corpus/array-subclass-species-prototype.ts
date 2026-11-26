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

// The same shape when the replaced prototype still inherits from the class's
// own prototype: Get(instance, "constructor") then names the class, so Node's
// species is the class again, and both the plain and retyped results inherit
// the constructor-installed prototype.
let protoInherits: any
class D extends Array<number> {
  constructor(len: number = 0) {
    super(len)
    Object.setPrototypeOf(this, protoInherits)
  }
}
protoInherits = Object.create(D.prototype)
protoInherits.marker2 = true
const d = new D()
d.push(1)
const dMap = d.map((x) => x)
const dRetyped = d.map((x) => [x])
console.log(
  "inherits",
  dMap.length,
  Object.getPrototypeOf(dMap) === protoInherits,
  Object.getPrototypeOf(dRetyped) === protoInherits,
  (Object.getPrototypeOf(dRetyped) as any).marker2 === true,
)

// A subclass whose constructor installs noncanonical numeric reference
// properties that point back at the instance: the type-changing map retypes
// the species result, whose cleanup must unlink those edges before releasing
// their payloads (a release can run a collection). The sanitized lane proves
// no freed payload is traced.
const stash = (target: any, key: string, value: any): void => {
  target[key] = value
}
type Row = { v: number; back: any }
class E extends Array<Row> {
  constructor(len: number = 0) {
    super(len)
    const self: any = this
    stash(self, "1.5", { v: 0, back: self })
    stash(self, "-1", { v: 1, back: [self] })
  }
}
let edgeTotal = 0
for (let i = 0; i < 500; i++) {
  const e = new E()
  e.push({ v: i, back: null })
  const relaid = e.map((x) => [x])
  edgeTotal += relaid.length
}
console.log("edges", edgeTotal)
