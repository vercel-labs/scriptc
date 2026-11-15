// Object.freeze of an object that was built by filling in an asserted empty
// literal: the object is frozen through every reference, whether it was
// complete or not, and a later write throws Node's TypeError for the key.
type Point = { x: number; y: number; z: number };

function attempt(label: string, write: () => void): void {
  try {
    write();
    console.log(label, "wrote");
  } catch (error) {
    console.log(label, error instanceof TypeError, (error as Error).message);
  }
}

// Frozen after it is complete.
const done = {} as Point;
const doneAlias = done;
const doneUnknown: unknown = done;
done.z = 3;
done.x = 1;
done.y = 2;
console.log("before", Object.isFrozen(done), Object.isFrozen(doneAlias));
const answer = Object.freeze(done);
console.log("after", answer === done, Object.isFrozen(done), Object.isFrozen(doneAlias), Object.isFrozen(doneUnknown));
attempt("x", () => {
  done.x = 10;
});
attempt("alias y", () => {
  doneAlias.y = 20;
});
attempt("unknown z", () => {
  (doneUnknown as Point).z = 30;
});
console.log("done", JSON.stringify(done), Object.keys(done).join(","), done.x + done.y + done.z);

// Frozen while a property is still unwritten: the write would add it.
const partial = {} as Point;
partial.y = 5;
Object.freeze(partial);
console.log("partial", Object.isFrozen(partial), JSON.stringify(partial), "x" in partial);
attempt("add x", () => {
  partial.x = 1;
});
attempt("set y", () => {
  partial.y = 6;
});
const key: keyof Point = "z";
attempt("add z by key", () => {
  partial[key] = 7;
});
console.log("partial", JSON.stringify(partial), Object.keys(partial).join(","));

// Frozen through an untyped reference, written through the typed one.
const viaUnknown = {} as Point;
viaUnknown.x = 1;
const loose: unknown = viaUnknown;
Object.freeze(loose);
console.log("loose", Object.isFrozen(viaUnknown), Object.isFrozen(loose));
attempt("typed y", () => {
  viaUnknown.y = 2;
});
console.log("loose", JSON.stringify(viaUnknown));

// Another object of the type is untouched.
const other = {} as Point;
other.x = 7;
other.y = 8;
other.z = 9;
other.x += 1;
console.log("other", Object.isFrozen(other), JSON.stringify(other));

// A frozen object stays the same object across a round trip.
const again = doneUnknown as Point;
console.log("again", again === done, again.x, Object.isFrozen(again));
