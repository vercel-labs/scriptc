// Business-record processing: multi-key sorts with comparator closures,
// group-by into Maps, and reductions over the groups.
interface Employee {
  id: number;
  name: string;
  department: string;
  level: number;
  salary: number;
  startYear: number;
}

let seed = 2024;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}
const departments = ["eng", "sales", "support", "finance", "legal", "design", "ops"];
const first = ["ana", "bo", "cy", "dee", "eli", "fay", "gus", "hal", "ivy", "jon"];
const last = ["smith", "jones", "lee", "khan", "garcia", "chen", "novak", "silva"];

function makeEmployees(count: number): Employee[] {
  const result: Employee[] = [];
  for (let i = 0; i < count; i++) {
    result.push({
      id: i,
      name: first[Math.floor(random() * first.length)]! + " " + last[Math.floor(random() * last.length)]!,
      department: departments[Math.floor(random() * departments.length)]!,
      level: 1 + Math.floor(random() * 7),
      salary: 40000 + Math.floor(random() * 160000),
      startYear: 1995 + Math.floor(random() * 30),
    });
  }
  return result;
}

function compareBy(keys: string[]): (a: Employee, b: Employee) => number {
  return (a, b) => {
    for (const key of keys) {
      let d = 0;
      if (key === "department") d = a.department < b.department ? -1 : a.department > b.department ? 1 : 0;
      else if (key === "level") d = b.level - a.level;
      else if (key === "salary") d = b.salary - a.salary;
      else if (key === "name") d = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      else d = a.id - b.id;
      if (d !== 0) return d;
    }
    return 0;
  };
}

const scale = Number(process.argv[2] ?? "1");
const employees = makeEmployees(Math.floor(60000 * scale));
let checksum = 0;
const orders = [
  ["department", "level", "salary", "id"],
  ["name", "id"],
  ["salary", "id"],
  ["level", "name", "id"],
];
for (const order of orders) {
  const sorted = employees.slice().sort(compareBy(order));
  for (let i = 0; i < sorted.length; i += 997) checksum = (checksum * 31 + sorted[i]!.id) % 1000000007;
}
const groups = new Map<string, Employee[]>();
for (const e of employees) {
  const key = e.department + "/" + e.level;
  const group = groups.get(key);
  if (group === undefined) groups.set(key, [e]);
  else group.push(e);
}
const lines: string[] = [];
for (const [key, group] of groups) {
  const total = group.reduce((sum, e) => sum + e.salary, 0);
  const veterans = group.filter((e) => e.startYear < 2010).length;
  const top = group.reduce((best, e) => (e.salary > best.salary ? e : best), group[0]!);
  lines.push(`${key} n=${group.length} avg=${Math.round(total / group.length)} vets=${veterans} top=${top.id}`);
}
lines.sort();
for (const line of lines.slice(0, 12)) console.log(line);
console.log("groups", lines.length, "checksum", checksum);
