// The function is reached the same way when what holds it is untyped: a
// record, an array, a Map, a class instance or a function, viewed at `any`,
// hands out the function it holds, and a call of that value is checked
// against what the function declares. The last part is a table of
// callbacks declared at `any` and spread into a typed definition that is
// then used at `any` again: a caller passes a result with an empty payload
// and the callback, which reads the member optionally, runs.
interface Payload {
  diff: string;
  path: string;
}
type Show = (payload: Payload) => string;

function loose(payload: any): string {
  return `loose ${JSON.stringify(payload)} diff=${String(payload?.diff)}`;
}

interface Definition {
  name: string;
  show: Show;
}
class Holder {
  show: Show = loose;
}
function make(): Show {
  return loose;
}
function through(show: Show): Show {
  return show;
}

const record: Definition = { name: "record", show: loose };
const list: Show[] = [loose];
const table = new Map<string, Show>();
table.set("k", loose);
const instance = new Holder();

const heldRecord: any = record;
const heldList: any = list;
const heldTable: any = table;
const heldInstance: any = instance;
const heldMake: any = make;
const heldThrough: any = through;

const payloads: [string, any][] = [
  ["matching", { diff: "d", path: "p" }],
  ["lacking a member", {}],
  ["wrong primitive", { diff: 1, path: "p" }],
  ["extra member", { diff: "d", path: "p", more: true }],
  ["undefined", undefined],
];
const holders: [string, (payload: any) => string][] = [
  ["record at any", (payload) => heldRecord.show(payload)],
  ["array at any", (payload) => heldList[0](payload)],
  ["map at any", (payload) => heldTable.get("k")(payload)],
  ["instance at any", (payload) => heldInstance.show(payload)],
  ["result of a function at any", (payload) => heldMake()(payload)],
  ["parameter of a function at any", (payload) => heldThrough(loose)(payload)],
];
for (const [holder, call] of holders) {
  for (const [kind, payload] of payloads) {
    let seen: string;
    try {
      seen = String(call(payload));
    } catch (error) {
      seen = `THROWS ${(error as Error).message}`;
    }
    console.log(`${holder} / ${kind}: ${seen}`);
  }
}
console.log(heldRecord.show === heldList[0], heldTable.get("k") === heldInstance.show);

// A table of callbacks declared apart from the definition that uses them.
interface Outcome<T> {
  text: string;
  detail: T;
}
interface Step<T = unknown> {
  label: string;
  render?: (outcome: Outcome<T>) => string;
  summarize?(outcome: Outcome<T>): string;
}
type Renderers = Pick<Step<any>, "render" | "summarize">;

const renderers: Renderers = {
  render(outcome) {
    const diff = outcome.detail?.diff;
    return typeof diff === "string" ? `diff ${diff}` : `no diff, text ${outcome.text}`;
  },
  summarize(outcome) {
    return `${outcome.text}: ${Object.keys(outcome.detail ?? {}).length} members`;
  },
};

function defineStep(): Step<Payload | undefined> {
  return { label: "step", ...renderers };
}

class Panel {
  private step?: Renderers;
  constructor(step: Renderers | Step<any> | undefined) {
    this.step = step;
  }
  draw(outcome: { text: string; detail?: any }): string {
    const render = this.step?.render;
    const summarize = this.step?.summarize;
    if (!render || !summarize) return "nothing to draw";
    try {
      const given = { text: outcome.text, detail: outcome.detail };
      return `${render(given)} | ${summarize(given)}`;
    } catch (error) {
      return `drawn another way: ${(error as Error).message}`;
    }
  }
}

const panel = new Panel(defineStep());
console.log(panel.draw({ text: "done", detail: { diff: "-a +b", path: "f" } }));
console.log(panel.draw({ text: "no match", detail: {} }));
console.log(panel.draw({ text: "nothing" }));
console.log(panel.draw({ text: "odd", detail: { diff: 7 } }));
