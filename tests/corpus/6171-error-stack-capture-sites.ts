// Stack captures keep the frames of every function active when the Error is
// created: callers of constructors and closures, recursion, and errors a
// runtime operation creates and a local catch takes. Leaf functions and
// accessors that cannot create an Error run in between. Captures record
// frames when the Error is created and format them on the first `.stack`
// read.
let lastCaught: Error | null = null;

function parseNumber(text: string): number {
  try {
    return JSON.parse(text) as number;
  } catch (error) {
    lastCaught = error as Error;
    return -1;
  }
}

class Failure {
  readonly error: Error;
  constructor(reason: string) {
    this.error = new Error(reason);
  }
}
function buildFailure(reason: string): Failure {
  return new Failure(reason);
}

class Counter {
  count: number = 0;
  get next(): number {
    return ++this.count;
  }
}

function leaf(n: number): number {
  return n * 2 + 1;
}
function sumLeaves(n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) total += leaf(i);
  return total;
}
function viaClosure(make: () => Error): Error {
  return make();
}
function recurse(n: number): Error {
  return n === 0 ? new Error('deep') : recurse(n - 1);
}
function hasFrame(error: Error, name: string): boolean {
  return error.stack!.split('\n').some((line) => line.includes(' ' + name + ' ') || line.endsWith(' ' + name));
}

const counter = new Counter();
console.log(parseNumber('12'), parseNumber('{'), counter.next, counter.next, sumLeaves(4));
const caught = lastCaught!;
console.log(caught.name, caught.stack!.startsWith('SyntaxError: '), hasFrame(caught, 'parseNumber'));

const constructed = buildFailure('in constructor').error;
console.log(constructed.stack!.split('\n')[0], hasFrame(constructed, 'buildFailure'));

const closure = viaClosure(() => new Error('in closure'));
console.log(closure.stack!.split('\n')[0], hasFrame(closure, 'viaClosure'));

// Frames are recorded at creation: a later limit and later calls do not
// change them, and the first read fixes the text.
Error.stackTraceLimit = 3;
const deep = recurse(10);
Error.stackTraceLimit = 10;
sumLeaves(100);
const first = deep.stack!;
console.log(first.split('\n').length, hasFrame(deep, 'recurse'), first === deep.stack);
deep.message = 'changed';
console.log(deep.stack === first);

// An Error created with the limit at zero has no frames.
Error.stackTraceLimit = 0;
const bare = recurse(2);
Error.stackTraceLimit = 10;
console.log(JSON.stringify(bare.stack));
