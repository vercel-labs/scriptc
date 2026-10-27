// An interface method with literal-discriminated overloads (the event
// registry shape: on("x", (e: X) => R)) holds ONE function at runtime, as
// JavaScript does. Each call site resolves its overload statically; handlers
// whose types differ per overload cross into the stored function as checked
// function values, and the implementation receives them in its own
// callback type. Events keep their identity across that boundary.
export {};

interface SaveEvent {
  type: "save";
  path: string;
  cancel: boolean;
}
interface LoadEvent {
  type: "load";
  path: string;
}
interface Context {
  cwd: string;
}
interface Api {
  on(event: "save", handler: (e: SaveEvent, ctx: Context) => void): () => void;
  on(event: "load", handler: (e: LoadEvent, ctx: Context) => boolean): () => void;
  on(event: "tick", handler: (n: number) => void): () => void;
  name: string;
}

let nextId = 0;
const saves: { id: number; h: (e: SaveEvent, ctx: Context) => void }[] = [];
const loads: { id: number; h: (e: LoadEvent, ctx: Context) => boolean }[] = [];
const ticks: { id: number; h: (n: number) => void }[] = [];

function createApi(name: string): Api {
  return {
    name,
    on(event: "save" | "load" | "tick", handler: any): () => void {
      const id = ++nextId;
      const count =
        event === "save"
          ? saves.push({ id, h: handler })
          : event === "load"
            ? loads.push({ id, h: handler })
            : ticks.push({ id, h: handler });
      console.log(`${name}: registered ${event} #${id} (${count})`);
      return () => {
        if (event === "save") saves.splice(saves.findIndex((x) => x.id === id), 1);
        else if (event === "load") loads.splice(loads.findIndex((x) => x.id === id), 1);
        else ticks.splice(ticks.findIndex((x) => x.id === id), 1);
        console.log(`${name}: removed ${event} #${id}`);
      };
    },
  };
}

// An extension sees only the interface.
function extension(pi: Api): () => void {
  pi.on("save", (e, ctx) => {
    e.cancel = e.path.endsWith(".lock");
    console.log(`save ${ctx.cwd}/${e.path}`);
  });
  pi.on("load", (e) => e.path.length > 3);
  return pi.on("tick", (n) => console.log("tick", n * 2, pi.name));
}

const api = createApi("main");
const stopTicks = extension(api);
const ctx: Context = { cwd: "/work" };
for (const path of ["a.txt", "b.lock"]) {
  const ev: SaveEvent = { type: "save", path, cancel: false };
  for (const { h } of saves) h(ev, ctx);
  console.log(path, "cancelled:", ev.cancel);
}
for (const { h } of loads) console.log(h({ type: "load", path: "ab" }, ctx), h({ type: "load", path: "abcd" }, ctx));
for (const { h } of ticks) h(21);
stopTicks();
console.log("ticks left", ticks.length);

// A named handler value converts the same way as a lambda.
function onTick(n: number): void {
  console.log("named tick", n);
}
const off = api.on("tick", onTick);
for (const { h } of ticks) h(7);
off();

// A handler that throws propagates through the boundary unchanged.
api.on("load", (e) => {
  if (e.path === "") throw new Error("empty path");
  return true;
});
try {
  for (const { h } of loads) h({ type: "load", path: "" }, ctx);
} catch (err) {
  console.log("caught", (err as Error).message);
}
