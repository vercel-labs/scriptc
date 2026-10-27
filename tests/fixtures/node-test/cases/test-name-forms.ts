// The (name?, options?, fn?) forms of test, it, describe and t.test, and
// Node's default names: a missing or empty name takes the function's name,
// or "<anonymous>". A helper may register tests with computed names and
// functions it receives as parameters. With both skip and todo, skip wins, in either order and
// against the todo method twins.
import { describe, it, test } from "node:test";

function declaredTest(): void {}
const boundArrow = (): void => {};
const emptyName = process.argv.length > 99 ? "never" : "";

// A helper that registers tests for its callers: the name is computed and
// the function arrives as a parameter.
function registerCase(label: string, body: () => void): void {
  test(`case ${label}`, body);
}
registerCase("one", () => {});
registerCase("two", declaredTest);

test(function namedExpression() {});
test(() => {});
test(declaredTest);
test(boundArrow);
test("", boundArrow);
test(emptyName, declaredTest);
test({ skip: "options first" }, () => {});
test({ todo: true });
test();
test("name and options", { skip: true });

describe(function namedSuite() {
  it(() => {});
  it({ todo: "later" }, function insideTodo() {});
});
describe({ skip: "whole suite" }, () => {
  it("not run", () => {});
});

test("subtests", async (t) => {
  await t.test(function namedSub() {});
  await t.test(() => {});
  await t.test({ skip: true }, () => {});
});

test("skip then todo", { skip: "skip message", todo: "todo message" }, () => {});
test("todo then skip", { todo: "todo message", skip: true }, () => {});
test.todo("todo twin with skip", { skip: true }, () => {});
it.skip("skip twin with todo", { todo: true }, () => {});
// The twins override the option of the same name, and the message is the
// skip string, else the todo string.
test.skip("skip twin with a skip message", { skip: "option message" }, () => {});
it.todo("todo twin with a todo message", { todo: "option message" }, () => {});
it.skip("skip twin with a todo message", { todo: "todo message" }, () => {});
test.todo("todo twin with a skip message", { skip: "skip message" }, () => {});
test("skip false with a todo message", { skip: false, todo: "todo message" }, () => {});
