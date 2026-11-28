/** @returns {void} */
function compute() {
  return "named value";
}
const alias = compute;

async function main() {
  console.log(compute() || "fallback compute");
  console.log(alias() && "hit alias");
  console.log((await compute()) || "fallback await");
}

main();
