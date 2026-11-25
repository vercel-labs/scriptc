// A member write through a type assertion on a caught value: the assertion is
// erased, so the write lands on the runtime object's own properties. The
// asserted member type is a class (`Headers`), which the structural view
// cannot represent; the write still addresses the receiver's dynamic node.
class HttpError extends Error {
  status = 500;
}

interface RetryHeaders {
  retryAfter?: number;
}

function normalize(error: unknown): void {
  if (!(error instanceof Error)) return;
  if (!Object.prototype.hasOwnProperty.call(error, "headers")) {
    (error as { headers?: Headers }).headers = undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(error, "retryHeaders")) {
    (error as { retryHeaders?: RetryHeaders }).retryHeaders = { retryAfter: 3 };
  }
}

try {
  throw new HttpError("boom");
} catch (error) {
  normalize(error);
  const e = error as HttpError;
  console.log(
    "normalized",
    e.message,
    e.status,
    Object.prototype.hasOwnProperty.call(e, "headers"),
    Object.prototype.hasOwnProperty.call(e, "retryHeaders"),
    JSON.stringify(e),
  );
}
