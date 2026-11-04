// Reflect.getPrototypeOf rejects every primitive target with its own
// TypeError, where Object.getPrototypeOf boxes it: a target held as any is
// checked at the call, and an object target still answers its prototype.
class Thing {}

function probe(target: any): string {
  try {
    const proto = Reflect.getPrototypeOf(target);
    return "proto=" + typeof proto;
  } catch (error) {
    return (error as Error).name + ": " + (error as Error).message;
  }
}

console.log("number", probe(1));
console.log("string", probe("text"));
console.log("boolean", probe(true));
console.log("null", probe(null));
console.log("undefined", probe(undefined));
console.log("object", probe({}));
console.log("array", probe([]));
console.log("instance", probe(new Thing()));

const shared = new Thing();
console.log("same", Reflect.getPrototypeOf(shared) === Reflect.getPrototypeOf(new Thing()));
console.log("object", Object.getPrototypeOf(shared) === Reflect.getPrototypeOf(new Thing()));
