// Reflect.construct(target, argumentsList[, newTarget]) — the construction
// React's error-stack formatter uses to run a component over a receiver
// built from a fake constructor's prototype. The two-argument form is a
// plain `new`, the three-argument form takes newTarget's prototype, and an
// arguments array-like converts through CreateListFromArrayLike.
function Base(this: any, a: number, b: number): void {
  this.sum = a + b;
}
function Fake(): void {}

const plain = Reflect.construct(Base, [2, 3]) as any;
const basePrototype = Object.getPrototypeOf(new (Base as any)(0, 0));
console.log(plain.sum, Object.getPrototypeOf(plain) === basePrototype);

const fake = Reflect.construct(Base, [4, 5], Fake as any) as any;
const fakePrototype = Object.getPrototypeOf(new (Fake as any)());
console.log(fake.sum, Object.getPrototypeOf(fake) === fakePrototype);

// An explicit undefined is a PRESENT third argument: Node checks
// IsConstructor(undefined) rather than falling back to the target.
try {
  Reflect.construct(Base, [1, 1], undefined as any);
} catch (error) {
  console.log((error as Error).message);
}

const fromArrayLike = Reflect.construct(Base, { length: 2, 0: 10, 1: 20 } as any) as any;
console.log(fromArrayLike.sum);

const object = Reflect.construct(function (this: any) { this.x = 1; }, []) as any;
console.log(object.x, Object.getPrototypeOf(object) === Object.prototype);

// The member saved as a value (React's `typeof Reflect === "object" &&
// Reflect.construct` feature test) is callable too.
const saved = Reflect.construct;
console.log(typeof saved);
const throughValue = saved(Base, [6, 7]) as any;
console.log(throughValue.sum);
