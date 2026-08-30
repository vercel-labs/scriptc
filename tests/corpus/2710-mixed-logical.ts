function getDefault(): string {
  return "default";
}

const a: string | null = null;
const b = a || getDefault();
console.log(b);

const c: string | null = "hello";
const d = c || getDefault();
console.log(d);

const num: number | undefined = undefined;
const e = num ?? 42;
console.log(e);

const num2: number | undefined = 0;
const f = num2 ?? 42;
console.log(f);

const str: string | undefined = "";
const g = str || "fallback";
console.log(g);

const h = str ?? "fallback";
console.log(h);
