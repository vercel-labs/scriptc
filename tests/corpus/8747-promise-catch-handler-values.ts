// `promise.catch(handler)` with a handler that is not written inline: the
// call is `promise.then(undefined, handler)`, so every function value a
// program can name is a handler. Each form below is one a real program
// writes; the receiver is an ordinary Promise<T> that rejects.
async function failing<T>(message: string): Promise<T> {
  throw new Error(message);
}
async function throwing(reason: string): Promise<void> {
  throw reason;
}
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// A declared function and a const arrow.
function onError(e: unknown): void {
  console.log("declared:", messageOf(e));
}
const describe = (e: unknown): string => "arrow: " + messageOf(e);
const noop = (): void => {};
const fallback = (): number => 7;

// Methods: an arrow field keeps its instance, a bound method too, and an
// unbound prototype method is called without a receiver.
class Reporter {
  count = 0;
  report = (e: unknown): void => {
    this.count++;
    console.log("field:", messageOf(e), this.count);
  };
  method(e: unknown): string {
    this.count++;
    return "method: " + messageOf(e) + " " + this.count;
  }
  detached(e: unknown): string {
    return "detached: " + messageOf(e);
  }
  static summarize(e: unknown): string {
    return "static: " + messageOf(e);
  }
  run(p: Promise<void>): Promise<void> {
    return p.catch(this.report);
  }
}
function prefixed(prefix: string, e: unknown): string {
  return prefix + " " + messageOf(e);
}

// Function-typed fields, parameters and results.
interface Options {
  onError: (e: unknown) => string;
}
const sink = {
  name: "sink",
  error(e: unknown): string {
    return "literal method: " + messageOf(e);
  },
};
function guard(p: Promise<string>, handler: (e: unknown) => string): Promise<string> {
  return p.catch(handler);
}
function recover<T>(p: Promise<T>, handler: (e: unknown) => T): Promise<T> {
  return p.catch(handler);
}
function handlerFor(context: string): (e: unknown) => string {
  return (e) => context + ": " + messageOf(e);
}

// Parameters wider and narrower than the reason.
const claimsError = (e: Error): string => "claims Error: " + e.message;
const takesAny = (e: any): string => "any: " + e.message;
const withContext = (e: unknown, context?: string): string =>
  "optional second: " + messageOf(e) + " " + String(context);
const counting = (...reasons: unknown[]): number => reasons.length;

interface Coded {
  code: number;
}
async function coded(): Promise<string> {
  throw { code: 404 };
}

async function main(): Promise<void> {
  await failing<void>("one").catch(onError);
  console.log(await failing<string>("two").catch(describe));
  await failing<void>("three").catch(noop);
  console.log("ignored");
  console.log(await failing<number>("four").catch(fallback));

  const reporter = new Reporter();
  await failing<void>("five").catch(reporter.report);
  await reporter.run(failing<void>("six"));
  console.log(await failing<string>("seven").catch(reporter.method.bind(reporter)));
  console.log(await failing<string>("eight").catch(reporter.detached));
  console.log(await failing<string>("nine").catch(Reporter.summarize));
  console.log(await failing<string>("ten").catch(prefixed.bind(null, "bound argument:")));
  console.log(reporter.count);

  const options: Options = { onError: (e) => "field: " + messageOf(e) };
  console.log(await failing<string>("eleven").catch(options.onError));
  console.log(await failing<string>("twelve").catch(sink.error));
  console.log(await guard(failing<string>("thirteen"), describe));
  console.log(await recover(failing<number>("fourteen"), (e) => messageOf(e).length));
  console.log(await failing<string>("fifteen").catch(handlerFor("call result")));

  for (const first of [true, false]) {
    console.log(await failing<string>("sixteen").catch(first ? describe : handlerFor("second")));
  }

  console.log(await failing<string>("seventeen").catch(claimsError));
  console.log(await failing<string>("eighteen").catch(takesAny));
  console.log(await failing<string>("nineteen").catch(withContext));
  console.log(await failing<number>("twenty").catch(counting));

  // A reason that is not an Error, and console.log itself as the handler.
  await throwing("plain reason").catch(console.log);
  await throwing("plain reason").catch(onError);

  // A fulfilled receiver passes its value on and never calls the handler.
  console.log(await Promise.resolve("fulfilled").catch(describe));

  // Inline handlers a catch binding cannot express.
  console.log(
    await failing<number>("inline async").catch(async (e) => {
      await null;
      return messageOf(e).length;
    }),
  );
  console.log(await failing<number>("two parameters").catch((e: unknown, _extra?: unknown) => -1));
  console.log(await failing<string>("destructured").catch(({ message }: Error) => "inline " + message));
  console.log(await failing<string>("defaulted").catch((e: unknown = 1) => "inline " + messageOf(e)));
  console.log(await coded().catch((e: Coded) => "inline claim " + e.code));

  // An unbound method that reads `this` has no receiver to read from: the
  // handler throws a TypeError, which rejects the result.
  console.log(
    await failing<string>("unbound")
      .catch(reporter.method)
      .catch((e) => (e instanceof TypeError ? "unbound method threw a TypeError" : "other")),
  );
}

void main();
