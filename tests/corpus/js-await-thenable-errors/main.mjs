async function main() {
  const throwing = { then() { throw new Error("then boom"); } };
  try {
    await throwing;
  } catch (error) {
    console.log("caught", error.message);
  }

  const nested = { then(resolve) { resolve({ then(r) { r("nested"); } }); } };
  console.log(await nested);

  const multi = { then(resolve) { resolve("first"); resolve("second"); } };
  console.log(await multi);
}

main();
