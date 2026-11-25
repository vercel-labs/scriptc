// A promise with hundreds or thousands of conversion waiters settles, with the
// cycle collector's default trigger: each dynamic look at the typed promise
// that somebody kept becomes a cycle candidate when the settle lets it go, so
// the candidates the settle itself makes reach the trigger and a collection
// starts between two waiters. The collection traces the settling promise (a
// closure in a cycle captures it, and a record holds it), whose waiter list
// must not name the looks already let go: the first look here is kept by
// nobody, or only by a dead cycle of dynamic objects, and is freed in the
// settle before the collection runs.

type Ticket = { subject: string; answer: Promise<string> };
type Desk = { name: string; pending: Promise<string>; clerk: (() => number) | null; served: number };

function lookUp(record: unknown, key: string): unknown {
  return (record as Record<string, unknown>)[key];
}

function tie(view: unknown): number {
  const loop: Record<string, unknown> = { view, kind: "loop" };
  loop["self"] = loop;
  return typeof loop["view"] === "object" ? 1 : 0;
}

function openDesk(name: string, pending: Promise<string>): Desk {
  const desk: Desk = { name, pending, clerk: null, served: 0 };
  desk.clerk = () => {
    desk.served++;
    return desk.pending === pending ? desk.served : -1;
  };
  return desk;
}

async function queueUp(p: Promise<string>): Promise<string> {
  return "answered " + (await p);
}

type First = "dropped" | "tied";

async function shift(first: First, viaClosure: boolean, readers: number): Promise<string> {
  let reply: (text: string) => void = () => {};
  const answer = new Promise<string>((resolve) => {
    reply = resolve;
  });
  const ticket: Ticket = { subject: first + "/" + (viaClosure ? "closure" : "key") + "/" + readers, answer };
  const hand = (): unknown => answer;
  const waiting = queueUp(answer);
  const shelf: unknown[] = [];
  let gone = 0;
  for (let i = 0; i < readers; i++) {
    const view = viaClosure ? hand() : lookUp(ticket, "answer");
    if (i > 0) shelf.push(view);
    else if (first === "tied") gone += tie(view);
    else gone += typeof view === "object" ? 1 : 0;
  }
  const front = openDesk("front", answer);
  const spare = openDesk("spare", answer);
  let served = spare.clerk ? spare.clerk() : 0;
  reply("approved");
  const outcome = await waiting;
  let letters = 0;
  for (const view of shelf) letters += String(await view).length;
  served += front.clerk ? front.clerk() : 0;
  return [ticket.subject, outcome, shelf.length, gone, letters, served].join(" ");
}

for (const readers of [300, 301, 2500, 2501]) {
  console.log(await shift("dropped", false, readers));
  console.log(await shift("dropped", true, readers));
  console.log(await shift("tied", false, readers));
}
