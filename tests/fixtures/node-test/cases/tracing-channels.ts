// @exit: 1
// The runner publishes Node's `tracing:node.test` channel events: a suite's
// start when its body is collected, a test's start before its body and end
// when its run finishes, an error for a thrown value (before the end), and
// start/end for skipped and todo tests too. Each message carries the name,
// the nesting level, the entry file's path and "test" or "suite". The
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

const events: string[] = [];
const label = (ctx: TraceContext): string =>
  `${ctx.type}:${ctx.nesting}:${ctx.name}:${typeof ctx.file}:${(ctx.file ?? "").endsWith("tracing-channels.ts")}`;
const channel = tracingChannel("node.test");
channel.subscribe({
  start(ctx: TraceContext) {
    events.push(`start ${label(ctx)}`);
  },
  end(ctx: TraceContext) {
    events.push(`end ${label(ctx)}`);
  },
  error(ctx: TraceContext) {
    events.push(`error ${label(ctx)} ${ctx.error?.message ?? ""}`);
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
    "start test:0:parent:string:true",
    "start test:1:sub:string:true",
    "end test:1:sub:string:true",
    "end test:0:parent:string:true",
    "start test:0:check:string:true",
  ];
  if (events.join("\n") !== expected.join("\n")) {
    throw new Error(`events:\n${events.join("\n")}`);
  }
});
