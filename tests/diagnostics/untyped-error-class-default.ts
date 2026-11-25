function makeErrorClass(): unknown {
  const { base = Error }: { base?: new (message?: string) => Error } = {};
  const Base = base as new (message?: string) => Error;
  return class extends Base {};
}

makeErrorClass();

class Node {
  public readonly children: unknown[] = [];

  public static read(input: number, flag?: boolean): Node {
    return new Reader(input).parse();
  }

  public add(child: Node): void {
    this.children.push(child);
  }
}

class Reader {
  public constructor(private readonly input: number) {}

  public parse(): Node {
    const node = new Node();
    node.add(new Node());
    return node;
  }
}

const wireType = (read: (input: number) => Node) => ({ read });
export const nodeType = wireType((input) => new Reader(input).parse());
