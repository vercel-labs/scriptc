// The rest binding outside a `const`: the destructuring ASSIGNMENT
// (`({ a, ...rest } = src)`) and a UNION source with a hybrid arm. Both
// build the same fresh rest object the declaration form does.
interface Cfg {
  a?: string;
  b?: number;
  [key: string]: unknown;
}

interface Left {
  kind: "left";
  a?: string;
  [key: string]: unknown;
}

interface Right {
  kind: "right";
  b?: number;
}

function assignmentForm(): void {
  const table: Record<string, string> = { y: "1", z: "2" };
  let all: Record<string, string>;
  ({ ...all } = table);
  console.log("assign all:", JSON.stringify(all), Object.keys(all).join(","));
  all.w = "9";
  console.log("assign fresh:", table.w === undefined);

  const cfg: Cfg = { a: "s", x: 1 };
  let a: string | undefined;
  let cfgRest: Cfg;
  ({ a, ...cfgRest } = cfg);
  console.log("assign hybrid:", a, JSON.stringify(cfgRest), Object.keys(cfgRest).join(","));
}

function unionSource(u: Left | Right): void {
  const { kind, ...rest } = u;
  console.log("union:", kind, JSON.stringify(rest));
}

assignmentForm();
unionSource({ kind: "left", a: "s", x: 1 });
unionSource({ kind: "right", b: 7 });
