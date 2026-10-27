// A plain-JavaScript package typed by an @types twin that says `max:
// number` and `mean: number`; the project's type patches (keyed by the
// runtime package and its installed version) make them `number |
// undefined` and `number | null`.
import { totals } from "tallyjs";

for (const values of [[3, 9, 4], []]) {
  const t = totals(values);
  console.log(t.count, t.sum, t.max ?? "no max", t.mean === null ? "no mean" : t.mean.toFixed(2));
  console.log(JSON.stringify(t), Object.keys(t).join("|"));
}
