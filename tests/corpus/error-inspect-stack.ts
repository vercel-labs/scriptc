// util.format, util.inspect and console.log print an Error's stack, as
// Node's formatError does: the frames under the error's "Name: message"
// heading, a stack without a frame line in the bracket form
// (`[custom stack]`), and the slots' `[Name: message]` when the stack is
// empty. improveStack names a subclass's header the way Node does
// (`Plain [Error]: m`). Live frames differ between the runtimes (Node adds
// file:line:column and internal frames), so a live stack is compared by its
// first line; an assigned stack makes the whole rendering comparable,
// including the own properties formatError appends after the last frame.
import * as util from "node:util";

function firstLine(text: string): string {
  return JSON.stringify(text.split("\n")[0]);
}

function lines(text: string): string[] {
  return text.split("\n");
}

// A live error is created in a function so both runtimes give it at least
// one frame line: a compiled top-level error has none, and a stack without
// frames brackets.
function makeError(): Error {
  return new Error("boom");
}
function makeTypeError(): TypeError {
  return new TypeError("bad type");
}
function makeRangeError(): RangeError {
  return new RangeError();
}
function makeCodedError(): Error {
  return new Error("coded");
}

const live = makeError();
console.log("inspect is the stack", util.inspect(live) === live.stack);
console.log("format is the stack", util.format(live) === live.stack);
console.log("format %%s is the stack", util.format("%s", live) === live.stack);
console.log("format %%O is the stack", util.format("%O", live) === live.stack);
console.log("format after a literal", util.format("x", live) === `x ${live.stack}`);
console.log("first line", firstLine(util.inspect(live)));
console.log("has frames", lines(util.inspect(live)).length > 1);

const liveType = makeTypeError();
console.log("type first line", firstLine(util.inspect(liveType)));
console.log("type is the stack", util.inspect(liveType) === liveType.stack);
console.log("empty message first line", firstLine(util.inspect(makeRangeError())));

// A nested error carries the property's indentation into its frames.
const nested = util.inspect({ wrapped: live });
const nestedLines = lines(nested);
console.log("nested first line", JSON.stringify(nestedLines[1]?.slice(0, 24)));
console.log(
  "nested frames indented",
  nestedLines.slice(2, -1).every((line) => line.startsWith("      at ")),
);
console.log("nested closes", JSON.stringify(nestedLines[nestedLines.length - 1]));

// An own property follows the last frame line, at the stack's level.
const liveCode = makeCodedError();
(liveCode as Error & { code?: string }).code = "E_LIVE";
const liveLines = lines(util.inspect(liveCode));
console.log("live tail", JSON.stringify(liveLines.slice(-2)));
console.log("live tail opens", liveLines[liveLines.length - 3]?.endsWith(" {"));

// A stack without a frame line brackets, and an empty stack falls back to
// the slots' form.
const custom = new Error("custom");
custom.stack = "stack without frames";
console.log("custom", JSON.stringify(util.inspect(custom)));
const cleared = new Error("cleared");
cleared.stack = "";
console.log("cleared", JSON.stringify(util.inspect(cleared)));

// An assigned stack renders exactly, frames included.
const assigned = new Error("assigned");
assigned.stack = "Error: assigned\n    at fake (file.ts:3:7)";
console.log("assigned", JSON.stringify(util.inspect(assigned)));
console.log("assigned format", JSON.stringify(util.format(assigned)));
console.log("assigned nested", JSON.stringify(util.inspect({ e: assigned })));
(assigned as Error & { code?: string }).code = "E_ASSIGNED";
console.log("assigned with code", JSON.stringify(util.inspect(assigned)));
console.log("assigned in an array", JSON.stringify(util.inspect([assigned])));

// improveStack: the constructor name and the error's name differ, so the
// header names both — applied to the stack's first line.
class Plain extends Error {}
class Deeper extends Plain {}
class FetchFailedError extends Error {}
class NamedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NamedError";
  }
}
class Renamed extends Error {
  override name = "RenamedError";
}
class Typed extends TypeError {}

// Live instances, created in functions so their stacks carry a frame line.
function makePlain(message: string): Plain {
  return new Plain(message);
}
function makeDeeper(message: string): Deeper {
  return new Deeper(message);
}
function makeFetchFailed(message: string): FetchFailedError {
  return new FetchFailedError(message);
}
function makeNamed(message: string): NamedError {
  return new NamedError(message);
}
function makeRenamed(message: string): Renamed {
  return new Renamed(message);
}
function makeTyped(message: string): Typed {
  return new Typed(message);
}

console.log("plain first line", firstLine(util.inspect(makePlain("p"))));
console.log("deeper first line", firstLine(util.inspect(makeDeeper("d"))));
console.log("fetch first line", firstLine(util.inspect(makeFetchFailed("f"))));
console.log("named first line", firstLine(util.inspect(makeNamed("n"))));
console.log("renamed first line", firstLine(util.inspect(makeRenamed("r"))));
console.log("typed first line", firstLine(util.inspect(makeTyped("t"))));

const plainAssigned = new Plain("p");
plainAssigned.stack = "Error: p\n    at fake (file.ts:9:9)";
console.log("subclass assigned", JSON.stringify(util.inspect(plainAssigned)));
const plainCleared = new Plain("p");
plainCleared.stack = "";
console.log("subclass cleared", JSON.stringify(util.inspect(plainCleared)));
const fetchAssigned = new FetchFailedError("not found");
fetchAssigned.stack = "Error: not found";
console.log("fetch assigned", JSON.stringify(util.inspect(fetchAssigned)));
const renamedAssigned = new Renamed("r");
renamedAssigned.stack = "RenamedError: r\n    at fake (file.ts:10:10)";
console.log("renamed assigned", JSON.stringify(util.inspect(renamedAssigned)));

// The same rendering through the checked-dynamic surface.
function dyn(value: unknown): unknown {
  return value;
}
function makeCarried(): unknown {
  return new Error("carried");
}
const carried: unknown = makeCarried();
console.log("carried is the stack", util.inspect(carried) === (carried as Error).stack);
console.log("carried first line", firstLine(util.inspect(carried)));
const carriedSub: unknown = makePlain("dyn");
console.log("carried subclass first line", firstLine(util.inspect(carriedSub)));
const carriedAssigned: unknown = dyn(new Plain("assigned dyn"));
(carriedAssigned as Error).stack = "Error: assigned dyn\n    at fake (file.ts:11:11)";
console.log("carried assigned", JSON.stringify(util.inspect(carriedAssigned)));
const carriedCleared: unknown = new Plain("cleared dyn");
(carriedCleared as Error).stack = "";
console.log("carried cleared", JSON.stringify(util.inspect(carriedCleared)));

// The stack is read first, as formatError does, so a `stack` getter the
// program installed is what renders — through a typed error and through an
// unknown value alike — and the name and message reads that follow see what
// the getter left behind.
function defineStack(target: object, read: () => string | undefined): void {
  Object.defineProperty(target, "stack", { get: read, configurable: true });
}
const replaced = new Error("replaced");
defineStack(replaced, () => "stack from a getter");
console.log("replaced typed", JSON.stringify(util.inspect(replaced)));
const replacedCarried: unknown = replaced;
console.log("replaced unknown", JSON.stringify(util.inspect(replacedCarried)));

// A getter that rewrites the name heads the rendering the way the rewritten
// name does (improveStack reads the new name), and a getter returning no
// stack leaves the slots' form with the new message.
const rewritten = new Error("before");
defineStack(rewritten, () => {
  rewritten.name = "TypeError";
  rewritten.message = "after";
  return "TypeError: after";
});
console.log("rewritten", JSON.stringify(util.inspect(rewritten)));
const rewrittenSlots = new Error("before");
defineStack(rewrittenSlots, () => {
  rewrittenSlots.message = "after";
  return undefined;
});
console.log("rewritten slots", JSON.stringify(util.inspect(rewrittenSlots)));

// console.log renders the value the same way.
console.log("console:", assigned);
