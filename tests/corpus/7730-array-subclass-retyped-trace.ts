// A cycle-capable class that extends Array (its elements and its own field
// can close a cycle) whose map results take other element types: the
// collector traces and tears down each instance by the elements it holds.
// Garbage cycles make the collector run while the results are alive.
class Holder {
  group: Group | null = null;
}

class Group extends Array<Holder | null> {
  owner: Holder | null = null;
}

function churn(rounds: number): number {
  let made = 0;
  for (let i = 0; i < rounds; i++) {
    const holder = new Holder();
    const group = new Group();
    group.owner = holder;
    holder.group = group;
    group.push(holder);
    made++;
  }
  return made;
}

const groups = new Group();
groups.push(new Holder(), null, new Holder());
const numbers = groups.map((_, i) => i * 1.5 + 1e6);
const labels = groups.map((_, i) => `label-${i}`);
console.log(churn(20000));
console.log(numbers instanceof Group, numbers.length, numbers.join(","));
console.log(labels instanceof Group, labels.join(","));
console.log(churn(20000), numbers[2], labels[1]);
