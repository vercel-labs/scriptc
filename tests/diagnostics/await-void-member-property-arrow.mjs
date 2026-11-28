/**
 * An awaited call through a member holding a function literal written into a
 * void-typed slot: the literal keeps the slot's void ABI and drops its
 * answer, so the truthiness test would read undefined where Node reads the
 * predicate's boolean. Only a method declaration, whose answer survives, is
 * admitted.
 */
/** @returns {void} */
function isBlocked(route) {
  return route.path === "/admin";
}

const policy = { check: (route) => isBlocked(route) };

async function main() {
  if (await policy.check({ path: "/admin" })) {
    console.log("blocked");
  } else {
    console.log("allowed");
  }
}

main();
