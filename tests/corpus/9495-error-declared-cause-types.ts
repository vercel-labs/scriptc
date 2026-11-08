// An Error subclass may declare `cause` again with a type of its own. The
// field is the error's one cause: a read through the class answers it at the
// declared type, a read through the Error base class answers the same value,
// and it is listed where the class declares it.
class Kiln {
  degrees = 900;
}
class Cracked extends Error {
  shelf = 2;
}

class Misfire extends Error {
  batch = "b7";
  cause: Error;
  constructor(message: string, inner: Error) {
    super(message);
    this.cause = inner;
  }
}

class Slump extends Error {
  batch = "b8";
  cause?: Cracked;
  glaze = "ash";
  constructor(message: string, inner?: Cracked) {
    super(message, { cause: inner });
    this.cause = inner;
  }
}

class Bloat extends Error {
  cause: string = "trapped gas";
  cone = 6;
}

class Dunt extends Error {
  cone = 4;
  cause!: { tray: number; note: string };
}

class Overfire extends Error {
  cause!: Kiln;
  hours = 11;
}

class Warp extends Error {
  side = "left";
  cause: Error | string = "uneven shelf";
}

function isMisfire(error: unknown): error is Misfire {
  return error instanceof Misfire;
}

const misfire = new Misfire("misfire", new RangeError("too cold"));
console.log(misfire.cause.name, misfire.cause.message, Object.keys(misfire).join(","));
try {
  throw misfire;
} catch (error) {
  if (isMisfire(error)) console.log(error.batch, error.cause.message);
}
const base: Error = misfire;
console.log(base.cause === misfire.cause, typeof base.cause);

const slump = new Slump("slump", new Cracked("hairline"));
console.log(slump.cause?.shelf, slump.cause?.message, Object.keys(slump).join(","));
const bare = new Slump("bare");
console.log(bare.cause === undefined, "cause" in bare, Object.keys(bare).join(","));

const bloat = new Bloat("bloat");
console.log(bloat.cause.toUpperCase(), Object.keys(bloat).join(","), JSON.stringify(bloat));
bloat.cause = "wet clay";
console.log(bloat.cause.length, (bloat as Error).cause);
const fromOptions = new Bloat("given", { cause: "from the options" });
console.log(fromOptions.cause, (fromOptions as Error).cause, Object.keys(fromOptions).join(","));

const dunt = new Dunt("dunt");
dunt.cause = { tray: 3, note: "cold spot" };
console.log(dunt.cause.tray, dunt.cause.note, Object.keys(dunt).join(","));

const overfire = new Overfire("overfire");
overfire.cause = new Kiln();
console.log(overfire.cause.degrees, overfire.cause instanceof Kiln, Object.keys(overfire).join(","));

const warp = new Warp("warp");
console.log(typeof warp.cause === "string" ? warp.cause : warp.cause.message);
warp.cause = new TypeError("thin wall");
console.log(typeof warp.cause === "string" ? warp.cause : warp.cause.message, Object.keys(warp).join(","));
