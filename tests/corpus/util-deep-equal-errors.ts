// util.isDeepStrictEqual over errors: two errors match when their name and
// message match, their `cause` is present on both or neither and matches
// deeply, AggregateError's `errors` lists match in order, and their own
// enumerable properties match. The stack never takes part.
import { isDeepStrictEqual as equal } from "node:util";

const show = (label: string, value: boolean): void => {
  console.log(`${label}: ${value}`);
};

const plain = (): any => {
  const error: any = new Error("boom");
  error.stack = "";
  return error;
};
const named = (name: string, message: string): any => {
  const error: any = new Error(message);
  error.name = name;
  error.stack = "";
  return error;
};

show("errors", equal(plain(), plain()));
show("messages", equal(plain(), named("Error", "other")));
show("names", equal(named("Error", "boom"), named("Custom", "boom")));

const withCode = (code: string): any => {
  const error: any = plain();
  error.code = code;
  return error;
};
show("extra property", equal(withCode("E"), withCode("E")));
show("extra property differ", equal(withCode("E"), withCode("F")));
show("extra property missing", equal(withCode("E"), plain()));

const withCause = (cause: any): any => {
  const error: any = new Error("boom", { cause });
  error.stack = "";
  return error;
};
show("cause", equal(withCause({ code: "E" }), withCause({ code: "E" })));
show("cause differ", equal(withCause({ code: "E" }), withCause({ code: "F" })));
show("cause presence", equal(withCause(undefined), plain()));

const causeCycle = (): any => {
  const error: any = new Error("boom");
  error.stack = "";
  error.cause = error;
  return error;
};
show("cause cycle", equal(causeCycle(), causeCycle()));

class Fatal extends Error {
  code = "FATAL";
}
const fatal = (): Fatal => {
  const error = new Fatal("boom");
  error.stack = "";
  return error;
};
show("subclass", equal(fatal(), fatal()));
show("subclass vs base", equal(fatal(), plain()));

const aggregate = (values: any[]): any => {
  return new AggregateError(values, "many");
};
show("aggregate", equal(aggregate([1, 2]), aggregate([1, 2])));
show("aggregate order", equal(aggregate([1, 2]), aggregate([2, 1])));
show("aggregate length", equal(aggregate([1, 2]), aggregate([1])));
show("aggregate vs error", equal(aggregate([1]), plain()));

show("error in array", equal([plain()], [plain()]));
show("error in map", equal(new Map([["e", plain()]]), new Map([["e", plain()]])));

const typed: Error = new Error("boom");
typed.stack = "";
show("typed error", equal(typed as any, plain()));
show("typed error differ", equal(typed as any, named("Error", "other")));

console.log("done");
