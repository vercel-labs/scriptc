// The element-access spelling of a presence probe through an assertion, and
// `in` through an assertion over a union that carries an undefined arm and an
// index-signature arm. Node erases the assertion for a probe: the stored
// value answers, and only a real use keeps the checked extraction.
interface Streams {
  stream: () => string;
  fetch?: () => string;
}
type Api = "alpha" | "beta";
interface Options {
  name: string;
  api?: Streams | Partial<Record<Api, Streams>>;
}

function typeofProbe(input: Options): string {
  return typeof (input.api as Streams)["stream"];
}
function undefinedProbe(input: Options): boolean {
  return (input.api as Streams)["fetch"] !== undefined;
}
function inProbe(input: Options): boolean {
  return "stream" in (input.api as Streams);
}
function realUse(input: Options): string {
  try {
    return (input.api as Streams)["stream"]();
  } catch (err) {
    return err instanceof TypeError ? "TypeError" : "other";
  }
}

const one: Streams = { stream: () => "one" };
const registry: Partial<Record<Api, Streams>> = { alpha: one };
for (const [label, api] of [
  ["one", one],
  ["registry", registry],
] as const) {
  const input: Options = { name: label, api };
  console.log(label, typeofProbe(input), undefinedProbe(input), inProbe(input), realUse(input));
}
try {
  inProbe({ name: "none" });
} catch (err) {
  console.log("none threw", err instanceof TypeError ? "TypeError" : "other");
}
try {
  typeofProbe({ name: "none" });
} catch (err) {
  console.log("none read threw", err instanceof TypeError ? "TypeError" : "other");
}
