// A call through an OPTIONAL function member inside a generic function whose
// parameter may be absent and whose type parameter is bound to a union of
// records. Every arm declares the member with one type, the checker narrows
// it to the function at the call, and the call reads the member from
// whichever arm the value holds.
interface Oven {
  celsius: number;
  adjust?: (minutes: number) => number;
  remark?: (dish: string) => string;
}

interface Grill {
  flame: "low" | "high";
  adjust?: (minutes: number) => number;
  remark?: (dish: string) => string;
}

interface Steamer {
  litres: number;
  baskets: number;
  adjust?: (minutes: number) => number;
  remark?: (dish: string) => string;
}

type Appliance = Oven | Grill | Steamer;

interface Hooks {
  adjust?: (minutes: number) => number;
  remark?: (dish: string) => string;
}

// Narrowed by an `if` on the optional chain.
function cookTime<A extends Hooks>(appliance: A | undefined, minutes: number): number {
  if (appliance?.adjust) return appliance.adjust(minutes);
  return minutes;
}

// Narrowed by a comparison in a conditional, on an optional parameter.
function comment<A extends Hooks>(dish: string, appliance?: A): string {
  return appliance?.remark !== undefined ? appliance.remark(dish) : `${dish}: no remark`;
}

// Narrowed by `&&`, with the call's result used as an argument.
function rounded<A extends Hooks>(appliance: A | undefined, minutes: number): string {
  return String(appliance && appliance.adjust && Math.round(appliance.adjust(minutes)));
}

// Narrowed inside a loop, where the call's result feeds the next call.
function twice<A extends Hooks>(appliance: A | undefined, minutes: number): number {
  let total = minutes;
  for (let pass = 0; pass < 2; pass++) {
    if (appliance !== undefined && appliance.adjust !== undefined) total = appliance.adjust(total);
  }
  return total;
}

let calls = 0;
const fanOven: Oven = {
  celsius: 180,
  adjust: (minutes) => {
    calls++;
    return minutes * 0.8;
  },
};
const grill: Grill = { flame: "high", remark: (dish) => `${dish}: turn once` };
const steamer: Steamer = {
  litres: 2,
  baskets: 3,
  adjust: (minutes) => minutes + 4.4,
  remark: (dish) => dish.toUpperCase(),
};
const bare: Oven = { celsius: 220 };

// Each call binds the type parameter to the whole union.
const kitchen: Appliance[] = [fanOven, grill, steamer, bare];
for (const appliance of kitchen) {
  console.log(cookTime(appliance, 30), comment("leeks", appliance), rounded(appliance, 11), twice(appliance, 50));
}
const nothing: Appliance | undefined = kitchen[kitchen.length];
console.log(cookTime(nothing, 30), comment("rice", nothing), rounded(nothing, 11), twice(nothing, 50), calls);

// The member assigned after the value entered the union.
grill.adjust = (minutes) => minutes / 2;
console.log(cookTime(kitchen[1], 30), twice(kitchen[1], 30));
