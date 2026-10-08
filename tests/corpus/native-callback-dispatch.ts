class Counter {
  count = 0;
  notify(): void { this.count++; }
  callback = (n: number): number => { this.count += n; return this.count; };
}
const counter = new Counter();
counter.notify();
console.log(counter.callback(2), counter.count);
counter.callback = (n: number): number => n * 3;
console.log(counter.callback(4), counter.count);

const calls: ((n: number) => number)[] = [(n: number): number => n + 1];
let receivers = 0;
let indexes = 0;
function receiver(): ((n: number) => number)[] { receivers++; return calls; }
function index(): number { indexes++; return 0; }
function replace(): number { calls[0] = (n: number): number => n + 100; return 5; }
console.log(receiver()[index()](replace()), calls[0](5), receivers, indexes);
let effects = 0;
function effect(): number { effects++; return 1; }
try { calls[3](effect()); } catch (error) { console.log(error instanceof TypeError, effects); }
function withReceiver(this: unknown, n: number): number {
  console.log(this === calls);
  return n + 9;
}
calls[0] = withReceiver;
console.log(calls[0](2));
function capture(this: unknown): () => boolean { return () => this === calls; }
const captures: (() => () => boolean)[] = [capture];
const saved = captures[0]();
console.log(saved());
const captureCalls: ((same?: unknown) => () => boolean)[] = [];
function captured(this: unknown, same: unknown = this): () => boolean { return () => this === same; }
captureCalls.push(captured);
const check = captureCalls[0]();
console.log(check());
function plainReceiver(this: unknown): boolean { return this === undefined; }
function nestedReceiver(this: unknown): boolean { return plainReceiver(); }
const nestedCalls: (() => boolean)[] = [nestedReceiver];
console.log(nestedCalls[0]());
