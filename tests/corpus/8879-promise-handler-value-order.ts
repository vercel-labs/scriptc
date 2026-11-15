// Handler values run on the same microtask turns as inline handlers: the
// handler one turn after the receiver settles, the result promise's
// reactions one turn later, and two further turns when the handler returns
// a promise. Each scenario logs against a chain of plain `then` turns.
async function failing<T>(message: string): Promise<T> {
  throw new Error(message);
}
function turns(log: string[], count: number): void {
  let p = Promise.resolve();
  for (let i = 1; i <= count; i++) {
    const label = "t" + i;
    p = p.then(() => {
      log.push(label);
    });
  }
}
function settled(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 5));
}

async function scenario(name: string, start: (log: string[]) => void): Promise<void> {
  const log: string[] = [];
  start(log);
  turns(log, 6);
  await settled();
  console.log(name + ": " + log.join(" "));
}

async function main(): Promise<void> {
  await scenario("catch(named), rejected", (log) => {
    const handler = (e: unknown): string => {
      log.push("handler");
      return "v";
    };
    const result = failing<string>("x").catch(handler);
    result.then((v) => log.push("result " + v));
    queueMicrotask(() => log.push("microtask"));
    process.nextTick(() => log.push("tick"));
  });

  await scenario("catch(inline), rejected", (log) => {
    const result = failing<string>("x").catch((e) => {
      log.push("handler");
      return "v";
    });
    result.then((v) => log.push("result " + v));
    queueMicrotask(() => log.push("microtask"));
    process.nextTick(() => log.push("tick"));
  });

  await scenario("then(undefined, named), rejected", (log) => {
    const handler = (e: unknown): string => {
      log.push("handler");
      return "v";
    };
    const result = failing<string>("x").then(undefined, handler);
    result.then((v) => log.push("result " + v));
  });

  await scenario("catch(named), fulfilled", (log) => {
    const handler = (e: unknown): string => {
      log.push("handler");
      return "v";
    };
    const result = Promise.resolve("ok").catch(handler);
    result.then((v) => log.push("result " + v));
  });

  await scenario("catch(named returning a promise)", (log) => {
    const handler = (e: unknown): Promise<string> => {
      log.push("handler");
      return Promise.resolve("v");
    };
    const result = failing<string>("x").catch(handler);
    result.then((v) => log.push("result " + v));
  });

  await scenario("catch(async named)", (log) => {
    async function handler(e: unknown): Promise<string> {
      log.push("handler");
      return "v";
    }
    const result = failing<string>("x").catch(handler);
    result.then((v) => log.push("result " + v));
  });

  await scenario("catch(inline async)", (log) => {
    const result = failing<string>("x").catch(async (e) => {
      log.push("handler");
      return "v";
    });
    result.then((v) => log.push("result " + v));
  });

  await scenario("catch(named that throws)", (log) => {
    const handler = (e: unknown): string => {
      log.push("handler");
      throw new Error("again");
    };
    const result = failing<string>("x").catch(handler);
    result.then(
      (v) => log.push("result " + v),
      (e) => log.push("rejected " + (e as Error).message),
    );
  });

  for (const present of [true, false]) {
    await scenario("catch(optional), " + (present ? "present" : "absent"), (log) => {
      const handler: ((e: unknown) => string) | undefined = present
        ? (e) => {
            log.push("handler");
            return "v";
          }
        : undefined;
      const result = failing<string>("x").catch(handler);
      result.then(
        (v) => log.push("result " + v),
        (e) => log.push("rejected " + (e as Error).message),
      );
    });
  }

  // A result that is a promise only at run time is adopted on the same
  // turns as one declared to be a promise.
  for (const useAsync of [false, true]) {
    await scenario("catch(sync or async), " + (useAsync ? "async" : "sync"), (log) => {
      const sync = (e: unknown): string => {
        log.push("sync handler");
        return "s";
      };
      const later = async (e: Error): Promise<string> => {
        log.push("async handler");
        return "a";
      };
      const result = failing<string>("x").catch(useAsync ? later : sync);
      result.then((v) => log.push("result " + v));
    });
  }

  await scenario("catch(optional async)", (log) => {
    const handlers: ((e: unknown) => Promise<string>)[] = [
      async (e) => {
        log.push("handler");
        return "v";
      },
    ];
    const handler: ((e: unknown) => Promise<string>) | undefined = handlers.pop();
    const result = failing<string>("x").catch(handler);
    result.then((v) => log.push("result " + v));
  });

  for (const useAsync of [false, true]) {
    await scenario("catch(void or promise), " + (useAsync ? "async" : "sync"), (log) => {
      const handler: (e: unknown) => void | Promise<void> = useAsync
        ? async (e) => {
            log.push("async handler");
            throw new Error("from the handler");
          }
        : (e) => {
            log.push("sync handler");
          };
      const result = failing<void>("x").catch(handler);
      result.then(
        () => log.push("result"),
        (e) => log.push("rejected " + (e as Error).message),
      );
    });
  }

  await scenario("catch(named), pending receiver", (log) => {
    const handler = (e: unknown): string => {
      log.push("handler");
      return "v";
    };
    let fail: (e: Error) => void = () => {};
    const pending = new Promise<string>((_resolve, reject) => {
      fail = reject;
    });
    const result = pending.catch(handler);
    result.then((v) => log.push("result " + v));
    queueMicrotask(() => {
      log.push("reject");
      fail(new Error("late"));
    });
  });

  await scenario("then(named, wider parameter)", (log) => {
    const handler = (v: string | number): string => {
      log.push("handler " + v);
      return "w";
    };
    const result = Promise.resolve("ok").then(handler);
    result.then((v) => log.push("result " + v));
  });

  await scenario("then(named, optional second parameter)", (log) => {
    const handler = (v: string, suffix?: string): string => {
      log.push("handler " + v + " " + String(suffix));
      return "w";
    };
    const result = Promise.resolve("ok").then(handler);
    result.then((v) => log.push("result " + v));
  });

  await scenario("then(named, named), rejected", (log) => {
    const ok = (v: string): string => {
      log.push("ok " + v);
      return "w";
    };
    const bad = (e: unknown): string => {
      log.push("bad");
      return "recovered";
    };
    const result = failing<string>("x").then(ok, bad);
    result.then((v) => log.push("result " + v));
  });
}

void main();
