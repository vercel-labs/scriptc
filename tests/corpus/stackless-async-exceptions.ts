// Exceptions in stackless async bodies: a throw before the first await
// rejects the promise inside the call, a throw after an await rejects it
// later, rejections re-throw at the awaiting site, try/catch/finally
// regions span awaits (including a finally that awaits and a return
// through a finally), loops break out of awaits, and Promise combinators
// observe the rejections in Node's order.
const log: string[] = [];
const say = (s: string): void => {
  log.push(s);
};

class AppError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

async function early(n: number): Promise<number> {
  if (n < 0) throw new AppError("negative " + n, 1);
  await null;
  return n;
}

async function late(n: number): Promise<number> {
  await Promise.resolve();
  if (n > 2) throw new AppError("too big " + n, 2);
  await null;
  return n * 2;
}

async function guarded(n: number): Promise<string> {
  try {
    say("guarded try " + n);
    const v = await late(n);
    say("guarded value " + v);
    return "ok " + v;
  } catch (e) {
    const err = e as AppError;
    say("guarded catch " + err.message + " code " + err.code);
    await null;
    return "caught " + err.code;
  } finally {
    say("guarded finally " + n);
    await Promise.resolve();
    say("guarded finally after await " + n);
  }
}

async function nested(n: number): Promise<number> {
  let attempts = 0;
  for (let i = 0; i < 5; i++) {
    try {
      attempts++;
      await late(n + i);
      if (i === 1) break;
    } catch (e) {
      say("nested caught " + (e as Error).message);
      await null;
      continue;
    } finally {
      say("nested finally " + i);
    }
  }
  return attempts;
}

async function rethrow(n: number): Promise<number> {
  try {
    return await early(n);
  } catch (e) {
    say("rethrow saw " + (e as Error).message);
    throw new AppError("wrapped " + (e as Error).message, 3);
  }
}

async function throwsString(): Promise<void> {
  await null;
  throw "plain string";
}

async function syncFail(n: number): Promise<number> {
  if (n > 0) throw new AppError("sync fail " + n, 4);
  return -n;
}

async function inlineAwaits(label: string): Promise<string> {
  const ok = await syncFail(-3);
  say(label + " ok " + ok);
  try {
    await syncFail(5);
    return "unreachable";
  } catch (e) {
    return label + " " + ok + " " + (e as AppError).code + " " + (e as Error).message;
  }
}

async function main(): Promise<void> {
  const p = early(-1);
  say("early returned a promise");
  p.catch((e: unknown) => say("early catch " + (e as Error).message));
  say("guarded " + (await guarded(1)));
  say("guarded " + (await guarded(5)));
  say("nested " + (await nested(1)));
  say("nested " + (await nested(2)));
  try {
    await rethrow(-4);
  } catch (e) {
    const err = e as AppError;
    say("main caught " + err.message + " " + err.code + " " + (err instanceof AppError));
  }
  try {
    await throwsString();
  } catch (e) {
    say("string " + String(e));
  }
  const attempts: Promise<number>[] = [late(1), late(3), early(-2), early(2)];
  const settled = await Promise.allSettled(attempts);
  for (const s of settled) {
    if (s.status === "fulfilled") say("fulfilled " + s.value);
    else say("rejected " + (s.reason as Error).message);
  }
  try {
    const all: Promise<number>[] = [late(1), late(4), late(5)];
    await Promise.all(all);
  } catch (e) {
    say("all rejected " + (e as Error).message);
  }
  const first = await Promise.race([late(2), early(9)]);
  say("race " + first);
  const anyOf: Promise<number>[] = [late(7), late(1)];
  const any = await Promise.any(anyOf);
  say("any " + any);
  const inlined: Promise<string>[] = [inlineAwaits("i1"), inlineAwaits("i2")];
  queueMicrotask(() => say("inline microtask"));
  const results = await Promise.all(inlined);
  say("inline " + results.join(" | "));
}

main().then(
  () => {
    for (const line of log) console.log(line);
  },
  (e: unknown) => console.log("main failed", String(e)),
);
