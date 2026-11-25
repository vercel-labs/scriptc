// @env: SCR_CYCLE_THRESHOLD=16
// A promise settles while it has many conversion waiters, and the cycle
// collector runs inside the settle. Every dynamic look at a typed promise (a
// record member read by a computed key, an array element read through
// unknown[], a closure's unknown return, an unknown parameter, a member of a
// dynamic object) is a second promise that waits on the typed one. The settle
// runs those waiters in order and lets each go; a look nobody kept is freed
// there, and the looks that were kept become cycle candidates, so with the
// trigger pinned low a collection starts between two waiters and traces the
// settling promise. Its waiter list must not name a look it has already let
// go. The forecast promise is also captured by a closure that sits in a cycle.

type Station = { name: string; forecast: Promise<string> };
type Board = { title: string; source: Promise<string>; refresh: (() => number) | null; shown: number };

function byKey(record: unknown, key: string): unknown {
  return (record as Record<string, unknown>)[key];
}

function byIndex(list: unknown, at: number): unknown {
  return (list as unknown[])[at];
}

function asUnknown(p: Promise<string>): unknown {
  return p;
}

function inBag(p: Promise<string>): Record<string, unknown> {
  return { forecast: p, kind: "bag" };
}

function mount(title: string, source: Promise<string>): Board {
  const board: Board = { title, source, refresh: null, shown: 0 };
  board.refresh = () => {
    board.shown++;
    return board.source === source ? board.shown : -1;
  };
  return board;
}

function flash(source: Promise<string>): number {
  const board = mount("lobby", source);
  return board.refresh ? board.refresh() : 0;
}

async function listen(p: Promise<string>): Promise<string> {
  try {
    return "heard " + (await p);
  } catch (e) {
    return "silence " + (e instanceof Error ? e.message : "?");
  }
}

async function compute(gate: Promise<void>, text: string): Promise<string> {
  await gate;
  return text;
}

type Look = "key" | "index" | "closure" | "parameter" | "bag";
type Keep = "all-but-first" | "odd" | "all" | "none";
type Moment = "now" | "microtask" | "timer" | "return";

async function season(look: Look, keep: Keep, moment: Moment, lookers: number): Promise<string> {
  let publish: (text: string) => void = () => {};
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const forecast =
    moment === "return"
      ? compute(gate, "rain")
      : new Promise<string>((resolve) => {
          publish = resolve;
        });
  const station: Station = { name: look + "/" + keep + "/" + moment, forecast };
  const row: Promise<string>[] = [forecast];
  const hand = (): unknown => forecast;
  const heard = listen(forecast);
  const kept: unknown[] = [];
  let passed = 0;
  for (let i = 0; i < lookers; i++) {
    const seen =
      look === "key"
        ? byKey(station, "forecast")
        : look === "index"
          ? byIndex(row, 0)
          : look === "closure"
            ? hand()
            : look === "parameter"
              ? asUnknown(forecast)
              : inBag(forecast)["forecast"];
    const stays = keep === "all" || (keep === "all-but-first" && i > 0) || (keep === "odd" && i % 2 === 1);
    if (stays) kept.push(seen);
    else passed += typeof seen === "object" ? 1 : 0;
  }
  let shown = flash(forecast);
  const board = mount("roof", forecast);
  if (moment === "now") publish("rain");
  else if (moment === "microtask") queueMicrotask(() => publish("rain"));
  else if (moment === "timer") setTimeout(() => publish("rain"), 1);
  else open();
  shown += flash(forecast);
  const outcome = await heard;
  let letters = 0;
  for (const seen of kept) letters += String(await seen).length;
  shown += board.refresh ? board.refresh() : 0;
  return [station.name, outcome, kept.length, passed, letters, shown].join(" ");
}

const looks: Look[] = ["key", "index", "closure", "parameter", "bag"];
const keeps: Keep[] = ["all-but-first", "odd", "all", "none"];
for (const look of looks) {
  for (const keep of keeps) console.log(await season(look, keep, "now", 40));
}
for (const moment of ["microtask", "timer", "return"] as Moment[]) {
  for (const look of looks) console.log(await season(look, "all-but-first", moment, 40));
}
console.log(await season("key", "all-but-first", "now", 700));
console.log(await season("closure", "odd", "timer", 700));
