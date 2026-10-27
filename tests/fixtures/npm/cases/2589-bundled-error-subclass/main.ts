// A program class extending an error class that a bundled package defines
// inside a lazy __esm initializer (build-utils' NowBuildError shape): `new`
// on the subclass, `instanceof` against both classes, and errors the
// package itself throws.
import { AppError, fail, lazyCode } from "gtesmerror";

class TaggedError extends AppError {
  tag: string;
  constructor(code: string) {
    super({ message: `tagged ${code}`, code });
    this.tag = "t";
  }
}

const e = new TaggedError("X1");
console.log(e.message, e.code, e.tag, e.hideStackTrace);
console.log(e instanceof AppError, e instanceof Error, e instanceof TaggedError);
try {
  fail("BOOM");
} catch (err) {
  console.log(err instanceof AppError, err instanceof TaggedError);
  if (err instanceof AppError) console.log(err.code, err.message);
}
console.log(lazyCode());
