// An Array subclass whose elements and fields refer back to the instance:
// the cycles are collected once nothing outside them is reachable, and
// the elements and fields read back as Node reads them.
class Member {
  name: string;
  group: Group | undefined;
  constructor(name: string, group: Group | undefined) {
    this.name = name;
    this.group = group;
  }
}

class Group extends Array<Member> {
  owner: Member | undefined = undefined;

  add(name: string): Member {
    const member = new Member(name, this);
    this.push(member);
    return member;
  }
}

function build(round: number): number {
  const g = new Group();
  const lead = g.add(`lead${round}`);
  g.add(`member${round}`);
  g.owner = lead;
  return g.length + (g[0]!.group === g ? 1 : 0) + (g.owner === lead ? 1 : 0);
}

let total = 0;
for (let i = 0; i < 200; i++) total += build(i);
console.log(total);
const kept = new Group();
kept.add("a").group?.add("b");
console.log(kept.length, kept.map((m) => m.name).join(","), kept[1]!.group === kept);
