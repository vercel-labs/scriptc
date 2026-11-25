// util.getSystemErrorMap, util.getSystemErrorName and
// util.getSystemErrorMessage: the map's entries and identity, each name and
// message agreeing with the map, and Node's range validation.
import { getSystemErrorMap, getSystemErrorName, getSystemErrorMessage } from "node:util";

const show = (label: string, run: () => unknown): void => {
  try {
    console.log(label, run());
  } catch (e: any) {
    console.log(label, e.name, e.code, e.message);
  }
};

const map = getSystemErrorMap();
console.log(map instanceof Map, map.size > 50);
const codes = Array.from(map.keys()).sort((a, b) => a - b);
console.log(codes.slice(0, 4).join(","), codes.slice(-4).join(","));
let names = 0;
let messages = 0;
for (const code of codes) {
  const entry = map.get(code);
  if (entry === undefined) {
    console.log("missing", code);
    continue;
  }
  const [name, message] = entry;
  if (getSystemErrorName(code) === name) names++;
  if (getSystemErrorMessage(code) === message) messages++;
}
console.log(names === codes.length, messages === codes.length);

for (const code of [-2, -13, -28, -32, -4095, -4094]) {
  show("code " + code, () => getSystemErrorName(code) + "|" + getSystemErrorMessage(code));
}
show("unknown name", () => getSystemErrorName(-2000));
show("unknown message", () => getSystemErrorMessage(-2000));

for (const bad of [0, 2, 1.5, -2.5, NaN, Infinity, -Infinity, "2" as any, null as any, undefined as any, [] as any]) {
  show("name " + String(bad), () => getSystemErrorName(bad));
  show("message " + String(bad), () => getSystemErrorMessage(bad));
}
