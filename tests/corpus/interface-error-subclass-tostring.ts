// toString called through an interface while the program boxes user Error
// subclasses that inherit toString from Error (issue #3503). The protocol
// dispatch gives each boxed class a native arm; an Error subclass's arm must
// call the runtime's Error.prototype.toString.

class StmtCore {
  private _source: string = "";
  constructor(source: string) {
    this._source = source;
  }
  toString(): string {
    return this._source;
  }
}
interface Stmt extends StmtCore {}
const Stmt = StmtCore;

function prepare(sql: string): Stmt {
  return new Stmt(sql);
}

const ins: Stmt = prepare("INSERT INTO t VALUES (?)");
console.log(ins.toString());
const list: Stmt[] = [prepare("SELECT 1"), prepare("SELECT 2")];
console.log(list.map((stmt) => stmt.toString()).join(" | "));

class DbError extends Error {}

class NamedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NamedError";
  }
}

class RangeLimitError extends RangeError {
  limit: number;
  constructor(limit: number) {
    super(`over ${limit}`);
    this.limit = limit;
  }
}

class LoudError extends Error {
  override toString(): string {
    return `LOUD(${this.message})`;
  }
}

class QuietError extends LoudError {}

// Boxing the instances makes each class a receiver the dispatch serves.
const boxed: unknown[] = [new DbError("x"), new NamedError("y"), 1];
console.log(boxed.length);

interface Printable {
  toString(): string;
}

function show(value: Printable): string {
  return value.toString();
}

const printables: Printable[] = [
  new DbError("db failed"),
  new DbError(""),
  new NamedError("named failed"),
  new RangeLimitError(3),
  new LoudError("loud failed"),
  new QuietError("quiet failed"),
  new Error("plain failed"),
  new TypeError("type failed"),
  prepare("UPDATE t SET x = 1"),
];
for (const value of printables) console.log(show(value));

// A name changed after construction is what toString reads.
const renamed = new DbError("renamed failed");
renamed.name = "Renamed";
console.log(show(renamed));
renamed.message = "";
console.log(show(renamed));

// The call order through the interface matches a direct call.
const order: string[] = [];
class TracedError extends Error {
  constructor(message: string) {
    super(message);
    order.push(`construct ${message}`);
  }
}
const traced: Printable[] = [new TracedError("a"), prepare("b"), new TracedError("c")];
console.log(traced.map((value) => show(value)).join(", "), order.join(", "));

try {
  throw new NamedError("thrown");
} catch (error) {
  console.log(show(error as Printable));
}

// Fields and conversions through an interface that a plain class and Error
// subclasses both implement, and a generic toString call.
class Pair {
  name: string;
  message: string;
  constructor(name: string, message: string) {
    this.name = name;
    this.message = message;
  }
  toString(): string {
    return `Pair(${this.name})`;
  }
}
interface Described {
  name: string;
  message: string;
  toString(): string;
}
class FirstError extends Error {}
class SecondError extends FirstError {
  constructor(message: string) {
    super(message);
    this.name = "SecondError";
  }
}
class WrappedTypeError extends TypeError {
  override toString(): string {
    return "wrapped " + super.toString();
  }
}
const described: Described[] = [
  new Pair("p", "q"),
  new FirstError("first"),
  new SecondError("second"),
  new WrappedTypeError("third"),
];
for (const value of described)
  console.log(value.name, "|", value.message, "|", value.toString(), "|", `${value}`, "|", String(value));
function generic<T extends { toString(): string }>(value: T): string {
  return value.toString();
}
console.log(generic(new SecondError("generic")), generic(new Pair("r", "s")));
