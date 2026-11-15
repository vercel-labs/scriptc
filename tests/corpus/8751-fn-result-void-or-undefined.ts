// Slots whose result is `void | undefined` or `undefined`: a function that
// returns nothing, returns undefined or never returns fills them, and a
// caller that reads the result reads undefined.
let calls = 0;
const plain = (): void => {
  calls++;
};
const undef = (): undefined => {
  calls++;
  return undefined;
};
const loose = (): any => {
  calls++;
  return undefined;
};
const fail = (): never => {
  calls++;
  throw new Error("thrown at " + calls);
};

type Maybe = () => void | undefined;
const maybes: Maybe[] = [plain, undef, loose];
for (const maybe of maybes) maybe();
const maybeThrower: Maybe = fail;
try {
  maybeThrower();
} catch (error) {
  console.log("maybe threw", (error as Error).message);
}
console.log("maybe", calls, maybes[0] === plain, maybes[1] === undef, maybes[2] === loose);

type Undef = () => undefined;
const undefs: Undef[] = [undef, loose];
for (const slot of undefs) {
  const value = slot();
  console.log("value", value, value === undefined, typeof value);
}
const undefThrower: Undef = fail;
try {
  const value = undefThrower();
  console.log("unreachable", value);
} catch (error) {
  console.log("undef threw", (error as Error).message);
}
console.log("undef", calls, undefs[0] === undef, undefs[1] === loose, undefThrower === fail);

class Step {
  readonly before: Maybe;
  readonly after: Undef;
  constructor(before: Maybe, after: Undef) {
    this.before = before;
    this.after = after;
  }
  run(): string {
    this.before();
    const value = this.after();
    return value === undefined ? "undefined" : "a value";
  }
}
const step = new Step(plain, undef);
let text = "";
for (let i = 0; i < 100; i++) text = step.run();
console.log("step", text, calls);
