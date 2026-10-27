// `'key' in err` on Error values of every receiver form, and
// Object.assign onto a fresh Error.
class HttpError extends Error {
  status = 404;
  get retryable(): boolean {
    return this.status >= 500;
  }
  describe(): string {
    return `${this.status}`;
  }
}

// A receiver narrowed from unknown by instanceof.
function statusOf(value: unknown): unknown {
  if (value instanceof Error) {
    return "status" in value ? value.status : "none";
  }
  return "not an error";
}
console.log(statusOf(new HttpError("not found")), statusOf(new Error("plain")), statusOf("text"));

// Parameters, call results and caught values; members a subclass declares
// as fields, accessors and methods; Error.prototype's own members.
function keys(err: Error): string {
  return [
    "status" in err,
    "retryable" in err,
    "describe" in err,
    "toString" in err,
    "missing" in err,
    "message" in err,
  ].join(" ");
}
console.log(keys(new HttpError("h")));
console.log(keys(new Error("e")));
console.log(keys(new TypeError("t")));
function latest(): Error {
  return new HttpError("latest");
}
console.log("status" in latest(), "message" in latest());
function caught(fn: () => void): string {
  try {
    fn();
    return "ok";
  } catch (e) {
    if (e instanceof Error && "status" in e) return `status ${String(e.status)}`;
    return "plain";
  }
}
console.log(
  caught(() => {
    throw new HttpError("t");
  }),
  caught(() => {
    throw new Error("u");
  }),
);

// Properties set at runtime are own properties too.
const expando = new Error("x");
(expando as unknown as { status: number }).status = 1;
console.log(keys(expando));

// Object.assign copies the source's own properties onto the error and
// answers the error itself.
interface ErrorLike {
  message: string;
  status?: number;
  code?: string;
}
function toError(error: ErrorLike | string): Error {
  return typeof error === "string"
    ? new Error(error)
    : Object.assign(new Error(error.message), error);
}
const assigned = toError({ message: "boom", status: 500, code: "EBOOM" });
console.log(assigned.message, (assigned as Error & { code?: string }).code, "status" in assigned);
console.log(statusOf(assigned), assigned instanceof Error, keys(assigned));
const renamed = toError({ message: "renamed" });
console.log(renamed.message, "status" in renamed, toError("text").message);
const fresh = new Error("before");
console.log(Object.assign(fresh, { message: "after" }) === fresh, fresh.message);

// An Error intersection carrying extra fields: Object.assign's result,
// read and written through its declared members.
interface ApiErrorFields {
  status: number;
  action: string | undefined;
  code: string | undefined;
  link: string | undefined;
}
function apiError(message: string, fields: ApiErrorFields) {
  const error = Object.assign(new Error(message), fields);
  return error;
}
const gateway = apiError("bad gateway", { status: 502, action: undefined, code: "E502", link: "https://example.com" });
console.log(gateway.message, gateway.status, gateway.code, gateway.link, "action" in gateway, gateway.action);
gateway.status = 503;
console.log(gateway.status, gateway instanceof Error);
Object.assign(gateway, { status: 504, code: "E504" });
console.log(gateway.status, gateway.code);
function describeApiError(error: Error & { status?: number }): string {
  return `${error.message}:${error.status ?? "none"}`;
}
console.log(describeApiError(gateway), describeApiError(new Error("plain")));

// Object.assign into a record whose fields are wider than the source's.
interface BuildFailure {
  message: string;
  bail?: boolean;
  code?: string;
}
function failure(message: string, bail: boolean): BuildFailure {
  const err: BuildFailure = { message };
  if (bail) Object.assign(err, { bail: true });
  return Object.assign(err, { code: "E_BUILD" });
}
for (const f of [failure("stop", true), failure("go", false)])
  console.log(f.message, f.bail, f.code);

// A record given a member its type lacks and thrown at once.
interface FailureRecord {
  from: string;
  isGraceful: boolean;
  errorValue: unknown;
}
function classifyFailure(err: unknown, from: string): FailureRecord {
  return { from, isGraceful: from === "user", errorValue: err };
}
function handleFailure(err: unknown, from: string): string {
  const failure = classifyFailure(err, from);
  if (failure.from === "build") {
    throw Object.assign(failure, { bail: true });
  }
  return `${failure.from} ${failure.isGraceful}`;
}
for (const from of ["build", "user"]) {
  try {
    console.log("handled", handleFailure(new Error("x"), from));
  } catch (e) {
    const thrownRecord = e as { from: string; bail?: boolean; isGraceful: boolean };
    console.log("thrown", thrownRecord.from, thrownRecord.bail, thrownRecord.isGraceful);
  }
}
