// Catch bindings narrowed by typeof or instanceof extract their payload
// through a kind or class guard. Covers string, number and boolean throws,
// Error subclass hierarchies, and a thrown standalone class.
class AppError extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}
class NotFound extends AppError {
  path: string;
  constructor(path: string) {
    super(`missing ${path}`, 404);
    this.name = "NotFound";
    this.path = path;
  }
}
class Signal {
  reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

function fail(which: number): void {
  if (which === 0) throw "text";
  if (which === 1) throw 7.5;
  if (which === 2) throw false;
  if (which === 3) throw new NotFound("/etc/x");
  if (which === 4) throw new AppError("bad", 500);
  if (which === 5) throw new RangeError("range");
  if (which === 6) throw new Signal("stop");
}

function classify(which: number): string {
  try {
    fail(which);
    return "ok";
  } catch (e) {
    if (typeof e === "string") return `string ${e.length} ${e}`;
    if (typeof e === "number") return `number ${e * 2}`;
    if (typeof e === "boolean") return `boolean ${!e}`;
    if (e instanceof NotFound) return `notfound ${e.path} ${e.code}`;
    if (e instanceof AppError) return `app ${e.code} ${e.message}`;
    if (e instanceof Error) return `error ${e.name}: ${e.message}`;
    if (e instanceof Signal) return `signal ${e.reason}`;
    return "unknown";
  }
}

for (let which = 0; which <= 7; which++) console.log(which, classify(which));

let codes = 0;
for (let i = 0; i < 500; i++) {
  try {
    fail(3 + (i % 2));
  } catch (e) {
    if (e instanceof AppError) codes += e.code;
  }
}
console.log("codes", codes);
