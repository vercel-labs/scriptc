async function main() {
  const plain = { then: 1, value: "plain" };
  const got = await plain;
  console.log(got === plain, got.value);

  const thenable = { then(resolve) { resolve("object"); } };
  console.log(await thenable);

  const getter = {};
  Object.defineProperty(getter, "then", {
    get() {
      return (resolve) => resolve("getter");
    },
  });
  console.log(await getter);
}

main();
