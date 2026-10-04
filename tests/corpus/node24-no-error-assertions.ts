import assert from "node:assert";
import { doesNotThrow } from "node:assert/strict";

function report(label: string, fn: () => void): void {
  try { fn(); console.log(label, "pass"); }
  catch (error) {
    console.log(label, error instanceof Error ? `${error.name}|${error.message}` : String(error));
  }
}

class AppError extends Error {}
const failure = new RangeError("boom");
const marker = { message: "object failure" };
const fail = (): void => { throw failure; };
report("empty", () => assert.doesNotThrow(() => {}));
report("value", () => doesNotThrow(() => 42));
report("bare", () => assert.doesNotThrow(fail));
report("class-match", () => assert.doesNotThrow(fail, RangeError));
report("class-miss", () => assert.doesNotThrow(fail, TypeError));
report("subclass", () => assert.doesNotThrow(() => { throw new AppError("app"); }, AppError));
report("regex-name", () => assert.doesNotThrow(fail, /^RangeError: boom$/));
report("regex-miss", () => assert.doesNotThrow(fail, /other/));
report("message", () => assert.doesNotThrow(fail, "note"));
report("empty-message", () => assert.doesNotThrow(fail, ""));
report("third-message", () => assert.doesNotThrow(fail, undefined, "note"));
report("string-third", () => assert.doesNotThrow(fail, "first", "ignored"));
report("predicate-true", () => assert.doesNotThrow(fail, (value: unknown): boolean => value === failure));
report("predicate-false", () => assert.doesNotThrow(fail, (): boolean => false));
report("predicate-truthy", () => assert.doesNotThrow(fail, (): number => 1));
report("predicate-throw", () => assert.doesNotThrow(fail, (): boolean => { throw "validator failure"; }));
report("number", () => assert.doesNotThrow(() => { throw 42; }));
report("string", () => assert.doesNotThrow(() => { throw "text"; }, /^text$/));
report("undefined", () => assert.doesNotThrow(() => { throw undefined; }));
report("null", () => assert.doesNotThrow(() => { throw null; }));
report("symbol-error", () => assert.doesNotThrow(() => { throw Symbol("tag"); }, Error));
report("symbol-regex", () => assert.doesNotThrow(() => { throw Symbol("tag"); }, /Symbol\(tag\)/));
report("object", () => assert.doesNotThrow(() => { throw marker; }));
try { assert.doesNotThrow(fail, TypeError); } catch (error) { console.log("same-error", error === failure); }
try { assert.doesNotThrow(() => { throw marker; }, (): boolean => false); } catch (error) { console.log("same-object", error === marker); }

const repeated = /boom/g;
report("global-1", () => assert.doesNotThrow(fail, repeated));
console.log("global-index-1", repeated.lastIndex);
report("global-2", () => assert.doesNotThrow(fail, repeated));
console.log("global-index-2", repeated.lastIndex);

const order: string[] = [];
function receiver(): () => void { order.push("receiver"); return (): void => { order.push("callback"); throw failure; }; }
function expected(): RegExp { order.push("expected"); return /boom/; }
function message(): string { order.push("message"); return "note"; }
report("ordered", () => assert.doesNotThrow(receiver(), expected(), message()));
console.log("order", order.join(","));
order.length = 0;
report("ordered-string", () => assert.doesNotThrow(receiver(), message(), message()));
console.log("order-string", order.join(","));

async function asyncReport(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(label, "pass"); }
  catch (error) { console.log(label, error instanceof Error ? `${error.name}|${error.message}` : String(error)); }
}

async function main(): Promise<void> {
  await asyncReport("fulfilled", () => assert.doesNotReject(Promise.resolve(42)));
  await asyncReport("rejected-bare", () => assert.doesNotReject(Promise.reject(failure)));
  await asyncReport("rejected-regex", () => assert.doesNotReject(Promise.reject(failure), /^RangeError: boom$/));
  await asyncReport("rejected-predicate", () => assert.doesNotReject(Promise.reject(marker), (value: unknown): boolean => value === marker));
  await asyncReport("rejected-truthy", () => assert.doesNotReject(Promise.reject(42), (): number => 1));
  await asyncReport("rejected-null", () => assert.doesNotReject(Promise.reject(null)));
  await asyncReport("rejected-undefined", () => assert.doesNotReject(Promise.reject(undefined)));
  await asyncReport("rejected-number", () => assert.doesNotReject(Promise.reject(42)));
  await asyncReport("rejected-symbol", () => assert.doesNotReject(Promise.reject(Symbol("tag")), Error));
  await asyncReport("rejected-text", () => assert.doesNotReject(Promise.reject("text"), /^text$/));
  await asyncReport("rejected-empty-message", () => assert.doesNotReject(Promise.reject(failure), ""));
  await asyncReport("rejected-string-third", () => assert.doesNotReject(Promise.reject(failure), "first", "ignored"));
  await asyncReport("sync-throw", () => assert.doesNotReject((): Promise<void> => { throw failure; }, RangeError));
  try { await assert.doesNotReject(Promise.reject(marker), (): boolean => false); }
  catch (error) { console.log("same-rejection", error === marker); }
}
void main();
