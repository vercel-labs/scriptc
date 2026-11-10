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
