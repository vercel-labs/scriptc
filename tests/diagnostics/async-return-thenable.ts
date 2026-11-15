// An async function that returns an object with a callable `then` which is
// not a promise: Node settles the function's promise through that method.
// Converting the object into the declared result would settle with the
// object itself, so the return is refused by name.
type Reading = { text: string };

class Later {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  then<R1 = Reading, R2 = never>(
    onFulfilled?: ((value: Reading) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve({ text: this.text }).then(onFulfilled, onRejected);
  }
}

async function read(text: string): Promise<Reading> {
  return new Later(text);
}

const viaArrow = async (text: string): Promise<Reading> => new Later(text);

async function* steps(text: string): AsyncGenerator<number, Reading> {
  yield 1;
  return new Later(text);
}

void read("a");
void viaArrow("a");
void steps("a");
