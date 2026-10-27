// A class instance asserted to a wider union (`(concrete as A | B).value`)
// keeps its class: field and getter reads go to the known class.
class A {
  value: number;
  label = "a";
  constructor(value: number) {
    this.value = value;
  }
  describe(): string {
    return `A(${this.value})`;
  }
  get doubled(): number {
    return this.value * 2;
  }
}
class B {
  value: number;
  flag = true;
  constructor(value: number) {
    this.value = value;
  }
  describe(): string {
    return `B(${this.value})`;
  }
  get doubled(): number {
    return this.value * 3;
  }
}
class C extends A {
  override get doubled(): number {
    return this.value * 10;
  }
}
type Rec = { value: boolean };

const concrete = new A(41);
console.log((concrete as A | B).value + 1, (concrete as A | B).doubled);
console.log((new C(5) as A | B).value, (new C(5) as A | B).doubled, (concrete as A | B).describe());
console.log((concrete as A | Rec).value, ((concrete as A | B) as A | B).value);
const maybe = (concrete as A | B | undefined)?.value;
console.log(maybe);
function show(x: A): string {
  return String((x as A | B).value) + (x satisfies A as A | B).doubled;
}
console.log(show(concrete), show(new C(2)));
const widened = concrete as A | B;
console.log(widened.value, widened instanceof A);
