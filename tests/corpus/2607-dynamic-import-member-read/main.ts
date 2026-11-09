// A member read straight off a dynamic import, `(await import("./m")).f`:
// the import evaluates the module (once) before the member is read. The
// modules here are reached through import() alone, so nothing else runs
// their bodies: a default export that is an arrow function, a constant and
// a function that reads one only have their values after that.
async function main(name: string): Promise<number> {
  let func: any;
  switch (name) {
    case "run":
      func = (await import("./command.ts")).default;
      break;
    default:
      func = null;
      break;
  }
  if (!func) {
    console.log("no such command:", name);
    return 1;
  }
  return await func({ name });
}

async function members(): Promise<void> {
  console.log("before the first import");
  console.log("constant:", (await import("./named.ts")).answer);
  console.log("call:", (await import("./named.ts")).describe("member"));
  const describe = (await import("./named.ts")).describe;
  console.log("value:", describe("value"));
  console.log("count:", (await import("./named.ts")).counter.count);
}

main("other")
  .then((code) => {
    console.log("exit", code);
    return main("run");
  })
  .then((code) => {
    console.log("exit", code);
    return main("run");
  })
  .then((code) => {
    console.log("exit", code);
    return members();
  })
  .then(() => {
    console.log("done");
  });
console.log("after the first call of main");
