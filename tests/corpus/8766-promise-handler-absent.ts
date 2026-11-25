// A handler that may be absent at run time. JavaScript ignores a handler
// that is not callable: a rejection passes through `catch(undefined)`, and
// a fulfillment through `then(undefined)`, to the next handler in the
// chain.
async function failing<T>(message: string): Promise<T> {
  throw new Error(message);
}
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface Hooks {
  onError?: (e: unknown) => string;
  onDone?: (value: string) => void;
  onFail?: ((e: unknown) => void) | null;
}

function settle(p: Promise<string>, hooks: Hooks): Promise<string> {
  return p.catch(hooks.onError).then(
    (value) => "fulfilled " + value,
    (e) => "rejected " + messageOf(e),
  );
}

async function notify(p: Promise<string>, hooks: Hooks): Promise<string> {
  try {
    await p.then(hooks.onDone, hooks.onFail);
    return "settled";
  } catch (e) {
    return "threw " + messageOf(e);
  }
}

function pick(use: boolean): ((e: unknown) => string) | undefined {
  return use ? (e) => "picked " + messageOf(e) : undefined;
}

async function main(): Promise<void> {
  const handled: Hooks = { onError: (e) => "handled " + messageOf(e) };
  const none: Hooks = {};

  console.log(await settle(failing<string>("a"), handled));
  console.log(await settle(failing<string>("b"), none));
  console.log(await settle(Promise.resolve("c"), handled));
  console.log(await settle(Promise.resolve("d"), none));

  const seen: string[] = [];
  const hooks: Hooks = {
    onDone: (value) => {
      seen.push("done " + value);
    },
    onFail: (e) => {
      seen.push("fail " + messageOf(e));
    },
  };
  console.log(await notify(Promise.resolve("e"), hooks), seen.join(","));
  console.log(await notify(failing<string>("f"), hooks), seen.join(","));
  console.log(await notify(Promise.resolve("g"), none));
  console.log(await notify(failing<string>("h"), none));
  console.log(await notify(failing<string>("i"), { onFail: null }));

  // The same through locals, `then(undefined, h)` and the literal forms.
  for (const use of [true, false]) {
    const handler = pick(use);
    const viaCatch = await failing<string>("j")
      .catch(handler)
      .then(
        (value) => value,
        (e) => "passed on " + messageOf(e),
      );
    const viaThen = await failing<string>("k")
      .then(undefined, handler)
      .then(
        (value) => value,
        (e) => "passed on " + messageOf(e),
      );
    console.log(viaCatch, "|", viaThen);
  }
  console.log(await failing<string>("l").catch(undefined).catch(messageOf));
  console.log(await failing<string>("m").catch(null).catch(messageOf));

  // A value typed `any` that is not a function is ignored as well.
  const five: any = 5;
  console.log(await failing<string>("n").catch(five).catch(messageOf));
  console.log(await failing<string>("o").then(undefined, five).catch(messageOf));
  const anyHandler: any = (e: unknown) => "any handler " + messageOf(e);
  console.log(await failing<string>("p").catch(anyHandler));
}

void main();
