async function main() {
  const fn = () => "called";
  fn.then = (resolve) => resolve("function thenable");
  console.log(await fn);
}

main();
