// `arguments.length` in a typed function whose parameter list lets a caller
// leave an argument out counts what each call passes: an omitted position
// contributes nothing, and an explicit `undefined` (or `void 0`) is an
// argument the caller passed. The same holds for a method, a constructor,
// an arrow that inherits the function's `arguments`, an async function and
// a call that spreads an array in.
function defaulted(value: string = "x"): string {
  return `${arguments.length}:${value}`;
}

function optional(value?: string): string {
  return `${arguments.length}:${String(value)}`;
}

console.log(defaulted(), defaulted("y"), defaulted(undefined), defaulted(void 0));
console.log(optional(), optional(), optional("y"), optional(undefined), optional(void 0));

class Slot {
  count = 0;
  value = "";
  constructor(value: string = "x") {
    this.count = arguments.length;
    this.value = value;
  }
  set(value?: string): string {
    return `${arguments.length}:${String(value)}`;
  }
}

const slot = new Slot();
console.log(slot.count, slot.value, new Slot("y").count, new Slot(undefined).count);
console.log(slot.set(), slot.set("y"), slot.set(undefined));

function arrow(value: number = 1): number {
  const read = (): number => arguments.length;
  return value + read();
}
console.log(arrow(), arrow(5));

async function later(value: number = 1): Promise<string> {
  return `${arguments.length}:${value}`;
}
later().then((result) => console.log(result));
later(9).then((result) => console.log(result));

const none: string[] = [];
const one: string[] = ["y"];
console.log(defaulted(...none), defaulted(...one), optional(...none), optional(...one));

// A defaulted parameter makes the parameter list non-simple, so even in a
// script `arguments` is a copy that a write to the parameter leaves alone,
// and an optional parameter that is never written cannot observe aliasing.
function unaliased(value: number = 1): string {
  value = 7;
  return `${arguments.length}:${String(arguments[0])}:${value}`;
}

function readOnly(value?: number): string {
  return `${arguments.length}:${String(arguments[0])}:${String(value)}`;
}
console.log(unaliased(), unaliased(2), readOnly(), readOnly(3));
