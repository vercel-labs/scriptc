// Slow paths (SC7001): writes that can replace any method by name. The
// program compiles and behaves like Node, but every method call then reads
// the method from the instance and boxes the receiver. Both writes are
// reported, not only the last one the census keeps.
class Counter {
  n: number;
  constructor() {
    this.n = 0;
  }
  bump(): void {
    this.n++;
  }
  read(): number {
    return this.n;
  }
}

const put = (target: Record<string, unknown>, key: string, value: unknown): void => {
  target[key] = value;
};
const merge = (target: object, source: object): void => {
  Object.assign(target, source);
};

put({}, "k", 1);
merge({}, {});
const counter = new Counter();
counter.bump();
console.log(counter.read());
