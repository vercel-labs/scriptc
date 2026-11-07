// A checked-dynamic value returned from an async function settles the way
// a returned promise does: the caller's promise adopts it (one then-job
// turn, and only after any finally the return crosses), and its rejection
// rejects that promise instead of reaching the function's own catch
// clauses.

function opaque(value: unknown): any {
  return value;
}

const log: string[] = [];

function tick(name: string): void {
  log.push(name);
}

async function adopted(): Promise<string> {
  tick("adopted:enter");
  try {
    return opaque(Promise.resolve("value"));
  } finally {
    tick("adopted:finally");
  }
}

async function immediate(): Promise<string> {
  tick("immediate:enter");
  return opaque("value");
}

async function guarded(): Promise<string> {
  try {
    return opaque(Promise.reject(new Error("boom")));
  } catch (error) {
    tick("guarded:caught");
    return error instanceof Error ? error.message : "caught";
  }
}

// A concise async body follows the same rule: the implicit return adopts a
// checked-dynamic promise, and a checked-dynamic value settles where it is
// returned.
const arrowAdopted = async (): Promise<string> => opaque(Promise.resolve("arrow:"));

const arrowValue = async (): Promise<string> => opaque("arrow-value");

async function main(): Promise<void> {
  tick("main:enter");
  const adoptedPromise = adopted();
  const immediatePromise = immediate();
  tick("main:after-calls");
  void Promise.resolve().then(() => tick("microtask"));
  tick(`adopted:${await adoptedPromise}`);
  tick(`immediate:${await immediatePromise}`);
  tick("main:before-guarded");
  let outcome: string;
  try {
    outcome = await guarded();
  } catch (error) {
    outcome = error instanceof Error ? `caller:${error.message}` : "caller";
  }
  tick(`guarded:${outcome}`);
  // Both arrows settle in the order their reactions were registered: the
  // immediate one first, the adopted one once the returned promise settles.
  const settled: string[] = [];
  void arrowAdopted().then((value) => settled.push(value));
  void arrowValue().then((value) => settled.push(value));
  tick("main:before-arrows");
  await arrowAdopted();
  await arrowValue();
  tick(`arrows:${settled.join(",")}`);
  console.log(log.join(","));
}

void main();
