// @exit: 1
// The runner publishes Node's `tracing:node.test` channel events: a suite's
// start when its body is collected, a test's start before its body and end
// when its run finishes, an error for a thrown value (before the end), and
// start/end for skipped, todo and fn-less tests too. Each message carries
// the name, the nesting level, the entry file's path and "test" or "suite".
// Start and end share one context object per test (Node publishes the same
// object), while an error event is a shallow copy of it: fields a start
// subscriber attached are carried over. The
// implicit root reports its own start and end once the tests finish (after
// this fixture's last test, so it is not part of the checked sequence).
import { tracingChannel } from "node:diagnostics_channel";
import { describe, it, test } from "node:test";

interface TraceContext {
  readonly name: string;
  readonly nesting: number;
  readonly file: string | undefined;
  readonly type: string;
  readonly error?: Error;
}

/* The payloads are stored as unknown (checked-dynamic) values: a record
 * conversion would copy them, and this fixture checks that start and end
 * share one object. */
const events: string[] = [];
const starts = new Map<string, object>();
const ends = new Map<string, object>();
const errors = new Map<string, object>();
const nameOf = (value: object): string => (value as TraceContext).name;
const label = (value: object): string => {
  const ctx = value as TraceContext;
  return `${ctx.type}:${ctx.nesting}:${ctx.name}:${typeof ctx.file}:${(ctx.file ?? "").endsWith("tracing-channels.ts")}`;
};
const channel = tracingChannel("node.test");
channel.subscribe({
  start(ctx: object) {
    (ctx as any).tag = "attached";
    starts.set(nameOf(ctx), ctx);
    events.push(`start ${label(ctx)}`);
  },
  end(ctx: object) {
    ends.set(nameOf(ctx), ctx);
    events.push(`end ${label(ctx)}`);
  },
  error(ctx: object) {
    errors.set(nameOf(ctx), ctx);
    events.push(`error ${label(ctx)} ${(ctx as TraceContext).error?.message ?? ""}`);
  },
});

describe("suite", () => {
  it("inner", () => {});
});
test("pass", () => {});
test("fail", () => {
  throw new Error("boom");
});
test.skip("skipped", () => {});
test.todo("todo", () => {});
test("empty");
test.todo("pending");
test("parent", async (t) => {
  await t.test("sub", () => {});
});
test("check", () => {
  const expected = [
    "start suite:0:suite:string:true",
    "start test:1:inner:string:true",
    "end test:1:inner:string:true",
    "end suite:0:suite:string:true",
    "start test:0:pass:string:true",
    "end test:0:pass:string:true",
    "start test:0:fail:string:true",
    "error test:0:fail:string:true boom",
    "end test:0:fail:string:true",
    "start test:0:skipped:string:true",
    "end test:0:skipped:string:true",
    "start test:0:todo:string:true",
    "end test:0:todo:string:true",
    "start test:0:empty:string:true",
    "end test:0:empty:string:true",
    "start test:0:pending:string:true",
    "end test:0:pending:string:true",
    "start test:0:parent:string:true",
    "start test:1:sub:string:true",
    "end test:1:sub:string:true",
    "end test:0:parent:string:true",
    "start test:0:check:string:true",
  ];
  if (events.join("\n") !== expected.join("\n")) {
    throw new Error(`events:\n${events.join("\n")}`);
  }
  for (const [name, ctx] of starts) {
    const end = ends.get(name);
    if (name === "check") continue; // its end comes after this test
    if (end !== ctx) throw new Error(`end context of ${name} is not the start context`);
  }
  if (errors.get("fail") === starts.get("fail")) {
    throw new Error("the error event should carry a fresh context object");
  }
  const errorCtx = errors.get("fail") as any;
  if (errorCtx === undefined || errorCtx.tag !== "attached") {
    throw new Error("the error event lost the metadata a start subscriber attached");
  }
});
