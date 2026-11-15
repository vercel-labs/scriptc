// An async function value called with an argument that may be missing at
// run time. A possibly missing argument widens the callee's parameter; the
// callee's own result stays the promise it creates, even when its body
// returns an unchecked element read.

interface Server {
  name: string;
  enabled: boolean;
}

function setup(servers: Server[]): (line: string) => Promise<string> {
  // Annotated result: the payload already admits undefined.
  const pick = async (name: string | undefined, fallback: string): Promise<Server | undefined> => {
    if (name) return servers.find((server) => server.name === name);
    const enabled = servers.filter((server) => server.enabled);
    if (enabled.length === 1) return enabled[0];
    return servers.find((server) => server.name === fallback);
  };
  return async (line) => {
    const parts = line.split(" ");
    const server = await pick(parts[1], "b");
    return server ? server.name : "none";
  };
}

const run = setup([
  { name: "a", enabled: false },
  { name: "b", enabled: true },
  { name: "c", enabled: false },
]);
console.log(await run("use a"), await run("use"), await run("use zz"));

// Inferred result, a required parameter the caller may leave missing.
const words = ["zero", "one", "two"];
const nth = async (index: number) => words[index];
const lengths = [2, 0];
console.log(await nth(lengths[1]), await nth(lengths[0]));

// The promise is a value like any other: stored, chained and awaited later.
const upper = async (text: string): Promise<string> => {
  const pieces = text.split("-");
  return pieces[0].toUpperCase();
};
const tags = ["ab-cd", "ef"];
const pending = [upper(tags[0]), upper(tags[1])];
console.log((await Promise.all(pending)).join(","));
upper(tags[1]).then((text) => console.log("then", text));

// A synchronous function value keeps widening its own result.
const second = (text: string) => text.split("/")[1];
const paths = ["x/y", "z/w"];
console.log(second(paths[0]), second(paths[1]));
