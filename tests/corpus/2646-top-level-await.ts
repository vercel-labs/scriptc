console.log("start");

const immediate = await Promise.resolve(40);
console.log("immediate", immediate + 2);

const delayed = await new Promise<number>((resolve) => {
  setTimeout(() => resolve(7), 1);
});
console.log("delayed", delayed);

await null;
console.log("done");

export {};
