// A parameter the callee writes through, met by a value whose field layout
// the parameter type would copy: the callee's write would reach only the
// copy, while under Node it reaches the caller's object.
type Value = { value: number };
type Box = { next: Value | undefined; count: number };

function bump(box: Box): void {
  box.count++;
}

const value = { next: undefined as any, count: 0 };
bump(value);
console.log(value.count);
