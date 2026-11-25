// undici-types declares Response as a class whose body members come from a
// mixin base, and @types/node's global Response is an interface over it. A
// program type derived from either spelling names the same native handle:
// an interface over an Omit of the instance type that declares the omitted
// members again (here named like the global), a subset alias, and an
// intersection.
export {};

type Native = InstanceType<typeof globalThis.Response>;

// Named like the global, in a module: every use below is this interface.
// Two members are declared again, one of them answering the interface.
interface Response extends Omit<Native, "clone" | "json"> {
  clone(): Response;
  json(): Promise<any>;
}
type Brief = Pick<Native, "status" | "ok">;
type Marked = Native & { reviewed?: boolean };

function sheet(status: number): Native {
  return new globalThis.Response(JSON.stringify({ hive: "north", frames: 10 }), {
    status,
    headers: { "x-apiary": "ridge" },
  });
}

function fetchSheet(status: number): Promise<Response> {
  return Promise.resolve(sheet(status)) as Promise<Response>;
}

class Queenless extends Error {
  status: number;
  constructor(message: string, response: Response) {
    super(message);
    this.status = response.status;
  }
}

async function frames(response: Response): Promise<number> {
  if (!response.ok) throw new Queenless("no brood", response);
  const body = await response.json();
  return body.frames;
}

function grade(brief: Brief): string {
  return (brief.ok ? "ok " : "bad ") + brief.status;
}

async function main(): Promise<void> {
  const good = await fetchSheet(200);
  console.log(good.status, good.ok, good.headers.get("x-apiary"), await frames(good));
  const bad = await fetchSheet(503);
  try {
    await frames(bad);
  } catch (e) {
    console.log(e instanceof Queenless, e instanceof Queenless ? e.status : -1, (e as Error).message);
  }
  const kept: Response[] = [good, bad];
  console.log(kept[0] === good, kept[1] instanceof globalThis.Response, good.bodyUsed, bad.bodyUsed);
  const twin: Response = bad.clone();
  console.log(twin.status, twin === bad, (await bad.text()).length, (await twin.text()).length);
  console.log(grade(sheet(201)), grade(bad), grade({ status: 418, ok: false }));
  const marked: Marked = sheet(202);
  console.log(marked.status, marked.reviewed, typeof marked);
}

main();
