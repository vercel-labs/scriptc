// A call through an optional function member, inside a generic function
// whose type parameter is bound to a union of records, stays refused when
// the arms declare the member at different function types: no one shared
// read serves the call. (Arms that agree on the member
// compile: tests/corpus/union-receiver-optional-callable.ts.)
interface Oven {
  celsius: number;
  adjust?: (minutes: number) => number;
}

interface Grill {
  flame: "low" | "high";
  adjust?: (minutes: number) => number | undefined;
}

type Adjustable = { adjust?: (minutes: number) => number | undefined };

function cookTime<A extends Adjustable>(appliance: A | undefined, minutes: number): number {
  if (appliance?.adjust) return appliance.adjust(minutes) ?? minutes;
  return minutes;
}

function plan(appliance?: Oven | Grill): void {
  console.log(cookTime(appliance, 30));
}

plan({ celsius: 180, adjust: (minutes) => minutes * 0.8 });
plan({ flame: "low", adjust: () => undefined });
