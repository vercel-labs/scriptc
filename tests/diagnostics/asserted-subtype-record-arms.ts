// `result as Sub` on `Base | undefined` checks the one record into Sub. Two
// records beside each other have no one value to check, so that assertion
// stays refused; and the checked value is a copy, so a write through the
// asserted binding is refused by name.
interface Base {
  handled?: boolean;
}
interface Other {
  capture?: boolean;
}
interface Sub extends Base {
  handled: true;
  origin: { x: number };
}

function eitherArm(value: Base | Other | undefined): number {
  const sub = value as Sub;
  return sub.origin.x;
}

function writeThrough(value: Base | undefined): number {
  const sub = value as Sub;
  sub.handled = true;
  return sub.origin.x;
}

console.log(eitherArm({ handled: true }), writeThrough({ handled: true }));
