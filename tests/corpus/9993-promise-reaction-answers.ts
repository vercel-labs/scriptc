// Promise reactions: the order of microtasks and the settlement of the derived promise, by the
// handler's declared answer (void, a number, a string, a record, unknown, a promise, a union with
// a promise), by the handler's form and by the registering call. Every section is read against
// a clock: a chain of reactions that marks one tick each.
const log: string[] = [];
function mark(s: string): void {
  log.push(s);
}
function flush(title: string): void {
  console.log(title + ': ' + log.join(' '));
  log.length = 0;
}
function pause(): Promise<void> {
  return new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
}
function clock(name: string, ticks: number): void {
  let p: Promise<void> = Promise.resolve();
  for (let i = 1; i <= ticks; i++) {
    const k = i;
    p = p.then(() => {
      mark(name + k);
    });
  }
}
function text(e: unknown): string {
  return e instanceof Error ? e.name + ': ' + e.message : 'not an error: ' + String(e);
}

type Rec = {a: number};
function takeNumber(v: number): number {
  mark('named-num');
  return v + 10;
}
function takeUnknown(v: number): unknown {
  mark('named-unk');
  return v + 20;
}
function takeVoid(v: number): void {
  mark('named-void' + v);
}
class Holder {
  base = 100;
  take(v: number): unknown {
    mark('method');
    return v + this.base;
  }
}

async function main(): Promise<void> {
  // 1. Answers that are not promises: the derived promise settles in the handler's own tick.
  clock('c', 3);
  Promise.resolve(1)
    .then((v: number): number => {
      mark('num');
      return v + 1;
    })
    .then(v => {
      mark('num>' + v);
    });
  Promise.resolve(1)
    .then((v: number): unknown => {
      mark('unk');
      return v + 2;
    })
    .then(v => {
      mark('unk>' + String(v));
    });
  Promise.resolve(1)
    .then((v: number): void => {
      mark('void' + v);
    })
    .then(v => {
      mark('void>' + String(v));
    });
  Promise.resolve(1)
    .then((v: number): string => {
      mark('str');
      return 's' + v;
    })
    .then(v => {
      mark('str>' + v);
    });
  Promise.resolve(1)
    .then((v: number): Rec => {
      mark('rec');
      return {a: v + 4};
    })
    .then(v => {
      mark('rec>' + v.a);
    });
  Promise.resolve(1)
    .then((v: number): undefined => {
      mark('undef' + v);
      return undefined;
    })
    .then(v => {
      mark('undef>' + String(v));
    });
  await pause();
  flush('plain answers');

  // 2. Answers that are promises already settled: the derived promise adopts them, which takes
  // two more ticks.
  clock('c', 5);
  const inner = Promise.resolve(7);
  Promise.resolve(1)
    .then((v: number): Promise<number> => {
      mark('p' + v);
      return inner;
    })
    .then(v => {
      mark('p>' + v);
    });
  Promise.resolve(1)
    .then((v: number): unknown => {
      mark('u' + v);
      return inner;
    })
    .then(v => {
      mark('u>' + String(v));
    });
  Promise.resolve(1)
    .then(async (v: number): Promise<number> => {
      mark('a');
      return v + 1;
    })
    .then(v => {
      mark('a>' + v);
    });
  Promise.resolve(1)
    .then(async (v: number): Promise<unknown> => {
      mark('au');
      return v + 2;
    })
    .then(v => {
      mark('au>' + String(v));
    });
  Promise.resolve(1)
    .then((v: number): number | Promise<number> => {
      mark('m');
      return v > 0 ? inner : v;
    })
    .then(v => {
      mark('m>' + v);
    });
  Promise.resolve(-1)
    .then((v: number): number | Promise<number> => {
      mark('n');
      return v > 0 ? inner : v;
    })
    .then(v => {
      mark('n>' + v);
    });
  await pause();
  flush('settled promise answers');

  // 3. Answers that are promises still pending: the derived promise settles two ticks after
  // the answer does.
  clock('c', 6);
  let releaseUnknown: (v: number) => void = () => {};
  const laterUnknown = new Promise<number>(resolve => {
    releaseUnknown = resolve;
  });
  let releaseTyped: (v: number) => void = () => {};
  const laterTyped = new Promise<number>(resolve => {
    releaseTyped = resolve;
  });
  Promise.resolve(1)
    .then((v: number): unknown => {
      mark('u' + v);
      return laterUnknown;
    })
    .then(v => {
      mark('u>' + String(v));
    });
  Promise.resolve(2)
    .then((v: number): unknown => {
      mark('u' + v);
      return laterUnknown;
    })
    .then(v => {
      mark('uu>' + String(v));
    });
  Promise.resolve(1)
    .then((v: number): Promise<number> => {
      mark('p' + v);
      return laterTyped;
    })
    .then(v => {
      mark('p>' + v);
    });
  Promise.resolve(2)
    .then((v: number): Promise<number> => {
      mark('p' + v);
      return laterTyped;
    })
    .then(v => {
      mark('pp>' + v);
    });
  Promise.resolve()
    .then(() => {})
    .then(() => {})
    .then(() => {
      mark('release');
      releaseUnknown(9);
      releaseTyped(8);
    });
  await pause();
  flush('pending promise answers');

  // 4. A handler that throws rejects the derived promise; a rejection passes a reaction that
  // has no rejection handler.
  clock('c', 4);
  Promise.resolve(1)
    .then((v: number): unknown => {
      mark('t' + v);
      throw new Error('boom');
    })
    .then(
      () => {
        mark('not reached');
      },
      (e: unknown) => {
        mark('[' + text(e) + ']');
      },
    );
  Promise.resolve(1)
    .then((v: number): number => {
      mark('r' + v);
      throw new RangeError('range');
    })
    .catch((e: unknown): number => {
      mark('[' + text(e) + ']');
      return 0;
    })
    .then(v => {
      mark('after' + v);
    });
  Promise.reject(new Error('x'))
    .then((): unknown => {
      mark('not reached');
      return 1;
    })
    .then(undefined, (e: unknown): unknown => {
      mark('[passed ' + text(e) + ']');
      return undefined;
    });
  Promise.reject(new Error('y'))
    .catch((e: unknown): unknown => {
      mark('[first ' + text(e) + ']');
      throw new TypeError('second');
    })
    .catch((e: unknown): void => {
      mark('[' + text(e) + ']');
    });
  await pause();
  flush('throws');

  // 5. finally passes the settlement through, after its callback.
  clock('c', 6);
  Promise.resolve(5)
    .finally(() => {
      mark('f1');
    })
    .then(v => {
      mark('f1>' + v);
    });
  Promise.reject(new Error('fr'))
    .finally(() => {
      mark('f2');
    })
    .catch((e: unknown) => {
      mark('f2>' + text(e));
    });
  Promise.resolve(5)
    .finally(() => {
      mark('f3');
      throw new Error('replaced');
    })
    .catch((e: unknown) => {
      mark('f3>' + text(e));
    });
  await pause();
  flush('finally');

  // 6. An answer that is the derived promise itself.
  let self: Promise<unknown> | null = null;
  const derived: Promise<unknown> = Promise.resolve(1).then((): unknown => {
    mark('self');
    return self;
  });
  self = derived;
  derived.then(
    () => {
      mark('not reached');
    },
    (e: unknown) => {
      mark('[' + text(e) + ']');
    },
  );
  await pause();
  flush('self');

  // 7. Several reactions on one pending promise run in the order they were registered,
  // whatever their kind.
  let open: (v: number) => void = () => {};
  const gate = new Promise<number>(resolve => {
    open = resolve;
  });
  gate.then((v): void => {
    mark('g1:' + v);
  });
  gate.then((v): unknown => {
    mark('g2');
    return v;
  });
  const awaiting = async (): Promise<void> => {
    await gate;
    mark('g3');
  };
  awaiting();
  gate.then((): unknown => {
    mark('g4');
    return gate;
  });
  gate.then(
    (v): number => {
      mark('g5');
      return v;
    },
    (): number => 0,
  );
  gate.catch((): void => {
    mark('not reached');
  });
  gate.then(takeNumber);
  gate.then(takeUnknown);
  gate.then(takeVoid);
  const holder = new Holder();
  gate
    .then(v => holder.take(v))
    .then(v => {
      mark('method>' + String(v));
    });
  mark('open');
  open(1);
  mark('opened');
  await pause();
  flush('one promise');

  // 8. A chain alternates with a second chain, tick for tick, whatever the handlers answer.
  Promise.resolve(0)
    .then((v: number): unknown => {
      mark('a1');
      return v + 1;
    })
    .then((v: unknown): unknown => {
      mark('a2');
      return v;
    })
    .then((v: unknown): number => {
      mark('a3');
      return typeof v === 'number' ? v : -1;
    })
    .then((v: number): void => {
      mark('a4=' + v);
    });
  Promise.resolve(0)
    .then((v: number): number => {
      mark('b1');
      return v + 1;
    })
    .then((v: number): void => {
      mark('b2');
    })
    .then((): unknown => {
      mark('b3');
      return 'b';
    })
    .then((v: unknown): void => {
      mark('b4=' + String(v));
    });
  await pause();
  flush('two chains');
}
main().then(() => {
  console.log('done');
});
