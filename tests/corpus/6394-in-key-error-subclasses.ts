// `'key' in err` on Error receivers, including subclasses that declare it.
class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
function describe(err: Error): string {
  if ("status" in err) return `status ${(err as HttpError).status}`;
  if ("code" in err) return "has code";
  return `plain ${err.message}`;
}
console.log(describe(new Error("x")));
console.log(describe(new HttpError("nf", 404)));
class Timeout extends HttpError {
  get retryable(): boolean {
    return true;
  }
}
function retryable(err: Error): boolean {
  return "retryable" in err;
}
console.log(retryable(new Error("x")), retryable(new HttpError("a", 500)), retryable(new Timeout("t", 504)));
console.log(describe(new Timeout("t", 504)));
// Keys every Error has: its own stack, and Error.prototype's and
// Object.prototype's members.
function inherent(err: Error): boolean[] {
  return ["stack" in err, "toString" in err, "constructor" in err, "hasOwnProperty" in err];
}
console.log(inherent(new Error("s")), inherent(new HttpError("h", 400)), inherent(new TypeError("t")));
