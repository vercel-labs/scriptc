/**
 * A void-typed predicate reaches a call through wrapper declarations: each
 * wrapper returns the void-typed call's result (directly, and through a
 * logical operand), so the wrapper answers undefined at run time while Node
 * answers the predicate's boolean. The awaited calls must refuse until the
 * wrapper's own body can be proven to carry a value.
 */
/** @type {(req: { path: string }) => void} */
const isBlocked = (req) => {
  return req.path === "/admin";
};

function check(req) {
  return isBlocked(req);
}

function checkOr(req) {
  return isBlocked(req) || false;
}

async function main() {
  if (await check({ path: "/admin" })) {
    console.log("blocked");
  }
  if (await checkOr({ path: "/admin" })) {
    console.log("blocked through the logical wrapper");
  }
}

main();
