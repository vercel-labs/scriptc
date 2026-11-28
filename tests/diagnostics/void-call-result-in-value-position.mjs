/**
 * The result of a void-typed call is read as a value. TypeScript's void
 * says the result is not meant to be used, not that it is undefined: the
 * callee's body returns a boolean, Node answers it, and a void ABI carries
 * none, so the ternary would silently take the wrong arm.
 */
/** @type {(req: { path: string }) => void} */
const isBlocked = (req) => {
  return req.path === "/admin";
};

function check(req) {
  return req.path === "/admin" ? isBlocked(req) : false;
}

async function main() {
  if (await check({ path: "/admin" })) {
    console.log("blocked");
  } else {
    console.log("allowed");
  }
}

main();
