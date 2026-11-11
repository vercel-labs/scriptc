// Promise reactions that are still waiting when the program ends: each waits on a promise that
// never settles, and holds that promise through its own handler or through the promise it answers.
// The program ends normally, as it does in Node, and none of the waiting handlers runs.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loose(v: unknown): any {
  return v;
}

function never(): Promise<number> {
  return new Promise<number>(() => {});
}

const ran: string[] = [];

// `finally` whose callback holds the promise it was registered on.
function finallyHoldsItsPromise(): void {
  const source = never();
  const holder: {p: Promise<number> | null} = {p: source};
  source.finally(() => {
    ran.push('finally');
    holder.p = null;
  });
  const open: Promise<unknown> = new Promise<unknown>(() => {});
  const openHolder: {p: Promise<unknown> | null} = {p: open};
  open.finally(() => {
    ran.push('finally unknown');
    openHolder.p = null;
  });
  console.log('finally registered', holder.p === source, openHolder.p === open);
}

// `then` and `catch` on an untyped receiver whose handler answers the receiver itself.
function handlerAnswersItsReceiver(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let p: any = loose(never());
  const source: unknown = p;
  const derived: unknown = p.then((v: number): unknown => {
    ran.push('then');
    return v === 0 ? source : null;
  });
  p = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = loose(never());
  const failing: unknown = q;
  const caught: unknown = q.catch((e: unknown): unknown => {
    ran.push('catch');
    return e === null ? failing : null;
  });
  q = null;
  console.log('then registered', derived instanceof Promise, caught instanceof Promise);
}

// The handler holds the promise that `then` derived for it.
function handlerHoldsTheDerivedPromise(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let p: any = loose(never());
  const holder: {d: unknown} = {d: null};
  holder.d = p.then((v: number): unknown => {
    ran.push('derived');
    return v === 0 ? holder.d : null;
  });
  p = null;
  console.log('derived registered', holder.d instanceof Promise);
}

// A `finally` callback that runs, and whose answer never settles: what follows it waits forever.
function finallyAnswerNeverSettles(): void {
  const inner = never();
  Promise.resolve(1)
    .finally((): unknown => {
      ran.push('answer');
      return inner;
    })
    .then(() => {
      ran.push('after the answer');
    });
  const rejected: Promise<number> = Promise.reject(new Error('lost'));
  rejected
    .finally((): unknown => {
      ran.push('answer of a rejection');
      return inner;
    })
    .catch(() => {
      ran.push('after the rejection');
    });
  console.log('answers registered');
}

finallyHoldsItsPromise();
handlerAnswersItsReceiver();
handlerHoldsTheDerivedPromise();
finallyAnswerNeverSettles();
setTimeout(() => {
  console.log('ran:', ran.join(', '));
}, 5);
process.on('exit', (code) => {
  console.log('exit', code, ran.length);
});
