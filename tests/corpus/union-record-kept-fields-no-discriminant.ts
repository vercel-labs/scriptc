// A record flowing into a union without a discriminant where one record arm
// holds it by dropping fields and another keeps every field but declares an
// optional field the record lacks. The record converts into the arm that
// keeps its fields, and the optional field stays absent.

type Loc = { file: string; start: number };

type Slot =
  | { type: number; loc: Loc }
  | {
      fnName: string;
      captures: string[];
      adapts?: true;
      type: number;
      loc: Loc;
    };

const loc: Loc = { file: "a.ts", start: 3 };

function slotOf(name: string): Slot {
  const slot = { fnName: name, captures: [], type: 1, loc };
  return slot;
}

const slot = slotOf("stored");
console.log("fnName" in slot, "adapts" in slot, JSON.stringify(slot));
if ("fnName" in slot)
  console.log(slot.fnName, slot.adapts, slot.captures.length);

function describe(value: Slot): string {
  return "fnName" in value
    ? `${value.fnName}/${value.captures.length}`
    : `type ${value.type}`;
}

const inner = { fnName: "inner", captures: ["x"], type: 2, loc };
const slots: Slot[] = [slot, { type: 7, loc }];
slots.push(inner);
console.log(slots.map(describe).join(", "), JSON.stringify(slots[2]));
