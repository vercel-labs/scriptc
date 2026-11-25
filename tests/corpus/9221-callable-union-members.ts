// A union of callable intersections is still the callable: each arm's
// members are own properties of the function object, so a value checked into
// the union keeps its type, reads its members, enumerates them and stays
// callable.
type Greet = (() => string) & { lang: string };
type Shout = (() => string) & { loud: boolean };

const g = Object.assign((): string => "hi", { lang: "en" } as { lang: string });
const s = Object.assign((): string => "hi", { loud: true } as { loud: boolean });

const v: Greet | Shout = g;
console.log(v(), Object.keys(v).join(","), typeof v);

function pick(which: number): Greet | Shout {
  return which === 0 ? g : s;
}

const picked = pick(1);
console.log(picked(), "loud" in picked, "lang" in picked, Object.keys(picked).join(","));
console.log(Object.keys(pick(0)).join(","));
