// Parentheses, a non-null assertion and a type assertion around a member
// callee do not detach the member from its receiver: `(c.m)()`, `c.m!()` and
// `(c.m as F)()` call `m` on `c`, as `c.m()` does. A comma, a conditional or
// an assignment in the callee yields the value, called without a receiver.
interface Handler {
  tag: string;
  onOpen(): string;
  onClose?(): string;
}

class Socket implements Handler {
  tag = "socket";
  onOpen(): string {
    return `open ${this.tag}`;
  }
  onClose(): string {
    return `close ${this.tag}`;
  }
  add(x: number, y: number): number {
    console.log("add", this.tag, x, y);
    return x + y;
  }
  static label(): string {
    return "static label";
  }
  get reader(): () => string {
    return () => `reader ${this.tag}`;
  }
  callback: (() => string) | undefined = () => "callback";
  run(): string {
    return [(this.onOpen)(), this.onClose!(), (this.onClose as () => string)()].join(", ");
  }
}

class Pipe {
  tag = "pipe";
  onOpen(): string {
    return `open ${this.tag}`;
  }
}

function thrown(f: () => unknown): string {
  try {
    f();
    return "no error";
  } catch (e) {
    return e instanceof TypeError ? "TypeError" : "another error";
  }
}

const socket = new Socket();

// A class receiver.
console.log((socket.onOpen)(), ((socket.onOpen))(), socket.onOpen!());
console.log((socket.onClose as () => string)(), (socket.onClose satisfies () => string)());
console.log((socket.onClose!)(), ((socket.onClose as () => string)!)(), socket.run());

// An interface receiver, with a required and an optional method.
const handler: Handler = socket;
console.log((handler.onOpen)(), handler.onClose!(), (handler.onClose as () => string)());

// A union of classes, an untyped receiver and an object literal's method.
const ends: (Socket | Pipe)[] = [socket, new Pipe()];
for (const end of ends) console.log((end.onOpen)(), end.onOpen!());
const untyped: any = socket;
console.log((untyped.onOpen)(), untyped.onClose!());
const literal = {
  tag: "literal",
  describe(): string {
    return `describe ${this.tag}`;
  },
};
console.log((literal.describe)(), literal.describe!());

// The receiver is evaluated once, before the arguments.
let step = 0;
const make = (): Socket => {
  console.log("make", step++);
  return socket;
};
console.log((make().add)(step++, step++), make().add!(step++, step++));

// A static method, a getter's function and a function-typed field.
console.log((Socket.label)(), Socket.label!(), (socket.reader)(), socket.callback!());

// These callees are values: the method runs without a receiver.
console.log(
  thrown(() => (0, socket.onOpen)()),
  thrown(() => (step > 0 ? socket.onOpen : socket.onClose)()),
);
