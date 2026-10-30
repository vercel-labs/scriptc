// An Error asserted to an interface that extends Error keeps the error
// itself: the extra fields live on the error object, and identity survives the
// conversion in both directions.
interface HttpError extends Error {
  status: number | undefined;
  body: string;
}

function httpError(label: string, status: number, body: string): HttpError {
  const error = new Error(label + " failed") as HttpError;
  error.status = status;
  error.body = body;
  return error;
}

const failure = httpError("GET", 500, "nope");
console.log(failure.message, failure.name, failure.status, failure.body);
console.log(failure instanceof Error);
console.log(typeof failure.stack);

function timeout(): HttpError {
  const error = new Error("timed out") as HttpError;
  error.name = "TimeoutError";
  error.status = undefined;
  error.body = "";
  return error;
}
const late = timeout();
console.log(late.message, late.name, late.status, late.body === "");

// Passing the error through a function returns the same object.
function same(error: HttpError): HttpError {
  return error;
}
const original = new Error("x") as HttpError;
original.status = 1;
original.body = "b";
console.log(same(original) === original, original.status, original.body);

// The error crosses out to unknown and back, still the same object.
const widened: unknown = failure;
console.log((widened as HttpError) === failure);
