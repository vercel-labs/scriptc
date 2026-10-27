// Groups whose members refer to objects outside them: a long-lived
// registry, strings built along the way, and a parameter's object. The
// arena's drop releases those references; the outside objects stay usable.
class Category {
  members = 0;
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}

class Member {
  next: Member | undefined = undefined;
  category: Category;
  label: string;
  rank: number;
  constructor(category: Category, label: string, rank: number) {
    this.category = category;
    this.label = label;
    this.rank = rank;
    category.members++;
  }
}

function ring(categories: Category[], size: number, seed: number): Member {
  const first = new Member(categories[seed % categories.length]!, `m${seed}`, seed);
  let last = first;
  for (let i = 1; i < size; i++) {
    const member = new Member(categories[(seed + i * 7) % categories.length]!, `m${seed}-${i}`, seed + i);
    last.next = member;
    last = member;
  }
  last.next = first;
  return first;
}

const categories: Category[] = [];
for (let i = 0; i < 5; i++) categories.push(new Category(`cat-${i}`));

let ranks = 0;
let labels = "";
for (let round = 0; round < 200; round++) {
  const r = ring(categories, 30, round);
  ranks += r.next!.rank + r.next!.next!.rank;
  if (round % 50 === 0) labels += `${r.label}:${r.category.name}:${r.next!.label} `;
}
console.log("ranks", ranks);
console.log("labels", labels.trim());
for (const c of categories) console.log(c.name, c.members);
