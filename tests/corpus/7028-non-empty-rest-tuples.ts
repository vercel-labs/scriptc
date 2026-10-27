// Tuples of required positions followed by a rest element of the same
// type (`[string, ...string[]]`, the non-empty list) behave as arrays of
// that type.
type Hosts = [string, ...string[]];
const LOCAL_HOSTS: Hosts = ["127.0.0.1", "::1", "localhost"];
const single: [string, ...string[]] = ["only"];
const pair: readonly [number, number, ...number[]] = [1, 2];

function first(hosts: Hosts): string {
  return hosts[0];
}
function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.includes(host);
}
console.log(first(LOCAL_HOSTS), first(single), LOCAL_HOSTS.length, single.length);
console.log(isLocalHost("::1"), isLocalHost("10.0.0.1"), LOCAL_HOSTS.indexOf("localhost"));
console.log(LOCAL_HOSTS.slice(1).join(","), LOCAL_HOSTS.map((h) => h.length));
for (const host of LOCAL_HOSTS) console.log(host);
const [head, ...rest] = LOCAL_HOSTS;
console.log(head, rest, JSON.stringify(LOCAL_HOSTS));
single.push("more");
console.log(single, single[1], pair[0] + pair[1], pair.length);

function hostsFrom(text: string): Hosts {
  const parts = text.split(",");
  const out: Hosts = [parts[0]!];
  for (const part of parts.slice(1)) out.push(part);
  return out;
}
const parsed = hostsFrom("a,b,c");
console.log(parsed, parsed.length, `${parsed}`);

function join(...names: [string, ...string[]]): string {
  return names.join("+");
}
console.log(join("x"), join("x", "y", "z"), join(...LOCAL_HOSTS));
const lists: Hosts[] = [LOCAL_HOSTS, single];
console.log(lists.map((l) => l[0]).join(" "));
