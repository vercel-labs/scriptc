// A named type alias of `Pick<C, K>` / `Omit<C, K>` over a program class is
// the same view as the inline form: calls through the alias run the
// instance's own methods, so its state is shared with every other reference.
class Session {
  reads = 0;
  id: string;
  constructor(id: string) {
    this.id = id;
  }
  read(): string {
    this.reads += 1;
    return this.id + ":" + this.reads;
  }
  reset(): void {
    this.reads = 0;
  }
  count(): number {
    return this.reads;
  }
}

type Readable = Pick<Session, "read">;
type Resettable = Omit<Session, "read">;

function twice(view: Readable): string {
  return view.read() + "/" + view.read();
}

const session = new Session("a");
console.log(twice(session), session.reads);

// The alias names a live view: writes to the instance show through it.
const readable: Readable = session;
session.reads = 10;
console.log(readable.read(), session.reads);
console.log((readable as unknown as Session) === session);

// Omit over the same class, through a named alias.
function reset(view: Resettable): number {
  view.reset();
  return view.count();
}
console.log(reset(session));

// An alias of an alias resolves to the same view.
type AlsoReadable = Readable;
function once(view: AlsoReadable): string {
  return view.read();
}
console.log(once(session), session.reads);

// Another class with the view's members flows through it the same way.
class Token {
  reads = 0;
  read(): string {
    this.reads += 1;
    return "t" + this.reads;
  }
}
const token = new Token();
console.log(twice(token), token.reads);
