// A callback with a defaulted parameter, written as a member of an options
// record that goes to a package compiled from its JavaScript. The package's
// declarations type the member as optional (`glaze?: Glaze`): the callback's
// untyped parameters take the declared types through that optional member,
// so `(piece, finish = "matte")` is a function of a string and an optional
// string. Where the declared parameter is not data the program can name (a
// class instance) or the member is a method, the parameter stays untyped and
// the function is boxed as a member of the untyped record. Either way the
// package may pass one argument, two, an explicit undefined, or one more than
// the callback declares.
import { fire, lift } from "kiln-kit";

const PLAIN = "plain";
const notes: string[] = [];
let stamps = 0;
const stamp = (): string => "s" + ++stamps;
const note = (message: string): void => {
  notes.push(message);
};

// Arrow callbacks under the optional member.
console.log(fire({ glaze: (piece, finish = "matte") => [piece, finish].join(":"), note }));
console.log(fire({ glaze: (piece, finish = PLAIN) => [piece, finish].join(":"), note, label: "ash" }));
console.log(
  fire({ glaze: (piece, finish = "matte", coats = 1) => [piece, finish, coats].join(":"), note }),
);
// The default is evaluated once per call that omits the argument or passes
// undefined, and never when a value arrives.
console.log(fire({ glaze: (piece, finish = stamp()) => [piece, finish].join(":"), note, label: "ash" }));
console.log("stamps", stamps);
// A default that reads an earlier parameter.
console.log(fire({ glaze: (piece, finish = piece) => [piece, finish].join(":"), note }));
// The same member as a function expression, a method, and in parentheses.
console.log(
  fire({
    glaze: function (piece, finish = "matte") {
      return [piece, finish].join(":");
    },
    note,
  }),
);
console.log(
  fire({
    glaze(piece, finish = "matte") {
      return [piece, finish].join(":");
    },
    note,
  }),
);
console.log(fire({ glaze: (piece, finish = "matte") => [piece, finish].join(":"), note }));
// The member left out: the package's own function runs.
console.log(fire({ note, label: "ash" }));
// A default that throws surfaces at the package's first call.
try {
  fire({
    glaze: (piece, finish = ((): string => {
      throw new RangeError("no finish for " + piece);
    })()) => [piece, finish].join(":"),
    note,
  });
} catch (err) {
  console.log(err instanceof RangeError, (err as Error).message);
}
// A declared parameter that is a class instance of the package.
console.log(lift({ carry: (tongs, pace = "steadily") => [tongs.hold("cup"), pace].join(":") }));
console.log(
  lift({
    carry(tongs, pace = "steadily") {
      return [tongs.hold("jug"), pace].join(":");
    },
  }),
);
console.log(lift({}));
console.log(notes.length, notes[0]);
