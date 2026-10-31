// The localized-failure report of `scriptc coverage --explain-dynamic`:
// type failures that would become checked dynamic slots, and the uses
// each one rejects today.
interface Tool {
  name: string;
  hooks: Map<string, (x: number) => string> | AbortSignal | (() => void) | Set<string>;
}
type Progress = (done: number, total: number) => void;
type Callbacks = Progress | AbortSignal | Map<string, (x: number) => string> | Set<number>;

// A field: rejects the class, so every use of an instance fails.
class Session {
  private tools: Tool[] = [];
  count(): number {
    return this.tools.length;
  }
  label(): string {
    return "s";
  }
}

// A parameter: rejects the function, so every call fails.
function listAll(dir: string, progress?: Callbacks): number {
  return dir.length;
}

// The dyn class field policy.
class Holder {
  state: any = {};
  get(): number {
    return 1;
  }
}

// A local: rejects its declaration statement, so its uses fail.
function pick(n: number): boolean {
  const callbacks: Callbacks | undefined = n > 1 ? new Set<number>() : undefined;
  return callbacks === undefined;
}

// Refused: a value the compiler cannot produce stays an error.
class Cache {
  tokens: WeakRef<object> = new WeakRef({});
  size(): number {
    return 0;
  }
}

const s = new Session();
console.log(s.count(), s.label());
console.log(listAll("abc"));
console.log(new Holder().get());
console.log(pick(1), new Cache().size());

// A class extending one the dyn class field policy rejects: its rejection
// and the uses of the derived class are that field's cascade.
class Base {
  state: any = {};
  get(): number {
    return 1;
  }
}
class Derived extends Base {
  twice(): number {
    return 2;
  }
}
console.log(new Derived().twice());
