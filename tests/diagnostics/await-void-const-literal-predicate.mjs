/**
 * A denylist predicate whose annotation says void. Node calls the arrow and
 * reads the boolean it returns; lowering the literal under the void
 * signature drops that value, so an awaited call would answer undefined and
 * let the request through. The call must refuse until the binding widening
 * carries the value.
 */
/** @type {(req: { path: string }) => void} */
const isBlocked = (req) => {
  return req.path === "/admin";
};

async function main() {
  if (await isBlocked({ path: "/admin" })) {
    console.log("blocked");
  } else {
    console.log("allowed");
  }
}

main();
