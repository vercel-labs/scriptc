// @requires-libnode
// Asynchronous calls into Node.js: results of promises cross when they
// settle, rejections reject, and synchronous calls work while asynchronous
// ones are outstanding and from promise reactions.
import { call, callSync } from "@scriptc/node";

interface Weather {
  city: string;
  temperature: number;
  tags: string[];
}

async function main(): Promise<void> {
  console.log("start");
  const weather = await call<Weather>("./service.mjs", "weather", "Berlin");
  console.log(weather.city, weather.temperature, weather.tags.join("+"));
  console.log(await call<string>("./service.mjs", "slow", 20));
  const doubled: number[] = await Promise.all([
    call<number>("./service.mjs", "double", 1),
    call<number>("./service.mjs", "double", 2),
    call<number>("./service.mjs", "double", 3),
  ]);
  console.log(doubled.join(" "));
  const pending = call<string>("./service.mjs", "slow", 30);
  console.log("meanwhile", callSync<number>("./service.mjs", "plain", 7));
  console.log(await pending);
  await call<number>("./service.mjs", "double", 21).then((n) => {
    console.log("then", n, callSync<number>("./service.mjs", "plain", n));
  });
  try {
    await call("./service.mjs", "fails", "on purpose");
  } catch (e) {
    if (e instanceof Error)
      console.log("rejected", e.name, e.message, (e as NodeJS.ErrnoException).code ?? "-");
  }
  try {
    await call("./service.mjs", "missing");
  } catch (e) {
    if (e instanceof Error) console.log("rejected", e.name, e.message);
  }
  const nothing = await call<undefined>("./service.mjs", "nothing");
  console.log(nothing === undefined);
  // Node's own pending work keeps the program alive after main returns.
  callSync("./service.mjs", "later", 15);
  console.log("end");
}

main();
