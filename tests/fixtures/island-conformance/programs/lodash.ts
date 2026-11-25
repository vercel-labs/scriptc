import _ from "lodash";

interface Row {
  team: string;
  score: number;
  name: string;
}
const rows: Row[] = [];
for (let i = 0; i < 5000; i++) rows.push({ team: "t" + (i % 7), score: (i * 37) % 101, name: "p" + i });
const grouped = _.groupBy(rows, (r) => r.team);
const summary = _.mapValues(grouped, (rs) => _.round(_.meanBy(rs, "score"), 2));
console.log(JSON.stringify(summary));
console.log(_.chunk(_.range(10), 3).map((c) => c.join("")).join("|"), _.uniq(rows.map((r) => r.score)).length);
console.log(_.sortBy(rows, ["score", "name"]).slice(0, 3).map((r) => r.name).join(","), _.camelCase("hello big-world"), _.get({ a: { b: [1, 2] } }, "a.b[1]"));
const merged = _.merge({ a: { x: 1 } }, { a: { y: 2 }, b: 3 });
console.log(JSON.stringify(merged), _.debounce(() => 1, 10) instanceof Function);
