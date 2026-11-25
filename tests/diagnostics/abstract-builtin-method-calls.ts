// A direct call through an abstract re-declaration that no class in the
// program implements, of a method a built-in supplies above it: Node's
// prototype chain reaches the built-in's function (Object.prototype's for
// every class, the Array or Date method under `extends Array` or
// `extends Date`), so the call does not throw. The built-in call lowerings
// do not answer a name the class declares, so each call is refused.
abstract class Shown {
  abstract toString(): string;
}
abstract class Owns {
  abstract hasOwnProperty(key: string): boolean;
}
abstract class Joined extends Array<number> {
  abstract join(separator?: string): string;
}
abstract class Timed extends Date {
  abstract getTime(): number;
}
// Two abstract levels above the built-in.
abstract class Retimed extends Timed {
  abstract getTime(): number;
}

const shown = new (Shown as any)() as Shown;
const owns = new (Owns as any)() as Owns;
const joined = new (Joined as any)() as Joined;
const timed = new (Timed as any)(5) as Timed;
const retimed = new (Retimed as any)(6) as Retimed;
console.log(shown.toString());
console.log(owns.hasOwnProperty("x"));
console.log(joined.join("-"));
console.log(timed.getTime());
console.log(retimed.getTime());
