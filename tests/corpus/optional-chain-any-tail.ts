// An optional chain on an `any` value short-circuits only on the guarded
// step: `a?.b.c` is undefined when `a` is nullish and throws when `a` is
// present but `a.b` is undefined, as in Node.
function read(label: string, f: () => unknown): void {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, "threw", (e as Error).message);
  }
}

const present: any = JSON.parse('{"b":{"c":{"d":1}},"k":{"method":null}}');
const empty: any = JSON.parse('{"b":{}}');
const none: any = null;

read("present", () => present?.b.c.d);
read("missing tail", () => empty?.b.c.d);
read("nullish root", () => none?.b.c.d);
read("second guard", () => empty?.b.c?.d);
read("element", () => present?.["k"].method);
read("call on nullish", () => none?.["k"].method?.());
read("nested guard", () => empty.x?.b.c);
