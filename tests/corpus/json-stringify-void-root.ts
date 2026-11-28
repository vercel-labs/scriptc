function g(): undefined {
  return undefined;
}
const shown = (v: string | undefined): string => (v === undefined ? "<undefined>" : v);
console.log("plain", shown(JSON.stringify(g())));
console.log("space", shown(JSON.stringify(g(), null, 2)));
let calls = 0;
console.log("effects", shown(JSON.stringify((calls++, g()))), calls);
console.log("literal", shown(JSON.stringify(undefined)));
