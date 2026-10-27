// Holey arrays reached through `unknown` print their holes as Node does:
// runs of holes as `<n empty items>` entries, which count toward the
// 100-entry limit, inside nested values too.
function show(label: string, value: unknown): void {
  console.log(label, value);
}
const a: number[] = [];
a[2] = 1;
show("lead", a);
const t: string[] = ["x"];
t[4] = "y";
t.length = 7;
show("runs", t);
const one: number[] = [1];
one[2] = 3;
show("single", one);
const wide: number[] = [];
for (let i = 0; i < 150; i += 2) wide[i] = i;
show("wide", wide);
const dense: number[] = [];
for (let i = 0; i < 120; i++) dense[i] = i;
dense[130] = 1;
show("dense", dense);
show("nested", { rows: [a, one] });
const made: unknown = new Array<number>(3);
show("ctor", made);
const holes: number[] = [];
holes.length = 3;
show("length", holes);
