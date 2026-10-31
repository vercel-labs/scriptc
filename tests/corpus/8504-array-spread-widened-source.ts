// Array spreads of sources the checker types wider than the iterable they
// hold: a `string | undefined` indexed read, and an untyped value. Node
// iterates whatever the value is; each element validates into the literal's
// element slot.
function expand(hex: string): string[] {
  const digit: string | undefined = hex[1];
  return [...digit];
}
console.log(JSON.stringify(expand("#0f0")));
console.log(JSON.stringify(expand("#abcdef")));

function doubled(hex: string): string {
  const digits = [...hex[1]].map((digit) => digit + digit).join("");
  return digits;
}
console.log(doubled("#0f0"));

interface Item {
  api: string;
  id: number;
}
function collect(source: any): Item[] {
  return [...source];
}
console.log(JSON.stringify(collect([{ api: "a", id: 1 }, { api: "b", id: 2 }])));

function pushAll(target: Item[], source: any): number {
  return target.push(...source);
}
const items: Item[] = [{ api: "seed", id: 0 }];
console.log(pushAll(items, [{ api: "c", id: 3 }]), JSON.stringify(items));

function collectStrings(provider: any): string[] {
  const triggerCharacters: string[] = [];
  triggerCharacters.push(...(provider.triggerCharacters ?? []));
  return triggerCharacters;
}
console.log(JSON.stringify(collectStrings({ triggerCharacters: ["@", "#"] })));
console.log(JSON.stringify(collectStrings({})));
