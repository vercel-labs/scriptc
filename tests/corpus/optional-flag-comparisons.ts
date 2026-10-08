// Comparing optional boolean and number fields against literals: absent,
// explicit undefined, true and false each answer like JS, through aliases
// and getters, with left-to-right evaluation.
interface Toggle {
  enabled?: boolean;
  level?: number;
}

function classify(t: Toggle): string {
  return [
    t.enabled === true,
    t.enabled === false,
    t.enabled !== true,
    t.enabled === undefined,
    true === t.enabled,
    t.level === 0,
    t.level !== 2,
    "enabled" in t,
  ].join(",");
}

const absent: Toggle = {};
const cleared: Toggle = { enabled: undefined, level: undefined };
const on: Toggle = { enabled: true, level: 2 };
const off: Toggle = { enabled: false, level: 0 };
console.log(classify(absent));
console.log(classify(cleared));
console.log(classify(on));
console.log(classify(off));

// Mutation through an alias is visible to the next comparison.
const alias: Toggle = on;
alias.enabled = false;
console.log(on.enabled === true, on.enabled === false);
delete alias.enabled;
console.log(on.enabled === false, on.enabled === undefined, "enabled" in on);
alias.enabled = true;
console.log(on.enabled === true);

// Counting in a loop over mixed values.
const toggles: Toggle[] = [absent, cleared, on, off, { enabled: true }];
let count = 0;
for (let round = 0; round < 1000; round++) {
  for (const t of toggles) if (t.enabled === true) count++;
}
console.log(count);

// Getter reads evaluate once, before the literal side.
const order: string[] = [];
const dynamic = {
  get enabled(): boolean | undefined {
    order.push("get");
    return order.length > 1;
  },
};
function literal(): boolean {
  order.push("literal");
  return true;
}
console.log(dynamic.enabled === true, dynamic.enabled === literal(), order.join(","));
