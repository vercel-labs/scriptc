// An object of methods written for two label records is stored where its
// interface is instantiated with four (TypeScript admits it: method
// parameters are bivariant), so its methods receive parcels whose label was
// built as one of the other two records. The records have only optional
// members: such a value fits every arm at once, and the properties it has
// decide which arm the method reads it as.
interface Fragile {
  cushion?: boolean;
  note?: string;
  tier?: string;
}
interface Cold {
  degrees?: number;
  note?: string;
  ice?: number;
}
interface Customs {
  form?: number;
  note?: string;
  cushion?: boolean;
  ice?: number;
}
// Every member of Fragile, and one of Cold's.
interface Gift {
  cushion?: boolean;
  note?: string;
  tier?: string;
  ice?: number;
}
type AnyLabel = Fragile | Cold | Customs | Gift;

interface Parcel<L> {
  code: string;
  label?: L;
}
interface Desk<L> {
  name: string;
  stamp(parcel: Parcel<L>): string;
  weigh?(parcel: Parcel<L>, grams: number): string;
}

function facts(label: Fragile | Cold | undefined): string {
  if (label === undefined) return "unlabelled";
  let text = "cushion" in label ? `cushion:${label.cushion}` : "degrees" in label ? `degrees:${label.degrees}` : "plain";
  if ("ice" in label) text += ` ice:${label.ice}`;
  if ("tier" in label) text += ` tier:${label.tier}`;
  return `${text} note:${label.note ?? "-"} keys:${Object.keys(label).join(",")} ${JSON.stringify(label)}`;
}

const fragileAndCold: Desk<Fragile | Cold> = {
  name: "front",
  stamp(parcel) {
    return `${parcel.code} ${facts(parcel.label)}`;
  },
  weigh(parcel, grams) {
    return `${parcel.code} ${grams}g ${facts(parcel.label)}`;
  },
};

const coldOnly: Desk<Cold> = {
  name: "cellar",
  stamp(parcel) {
    const label = parcel.label;
    if (label === undefined) return `${parcel.code} unlabelled`;
    return `${parcel.code} degrees:${label.degrees} ice:${label.ice} note:${label.note} ${JSON.stringify(label)}`;
  },
};

const desks: Desk<AnyLabel>[] = [fragileAndCold, coldOnly];

function customs(code: string, label?: Customs): Parcel<AnyLabel> {
  return { code, label };
}
function gift(code: string, label?: Gift): Parcel<AnyLabel> {
  return { code, label };
}

const wrapped: Fragile = { cushion: true, tier: "top" };
const chilled: Cold = { degrees: -4, note: "keep shut" };
const parcels: Parcel<AnyLabel>[] = [
  { code: "p1", label: wrapped },
  { code: "p2", label: chilled },
  customs("p3"),
  customs("p4", {}),
  customs("p5", { form: 22 }),
  customs("p6", { note: "this way up", cushion: false }),
  customs("p7", { form: 8, ice: 2 }),
  customs("p8", { cushion: undefined }),
  gift("p9", { tier: "low" }),
  gift("p10", { note: "birthday", ice: 1 }),
  gift("p11", {}),
];

const front = desks[0]!;
for (const parcel of parcels) {
  console.log(front.name, front.stamp(parcel));
  if (front.weigh !== undefined) console.log(front.name, front.weigh(parcel, parcel.code.length * 100));
}
// A desk for one record: every other arm has one home, whatever it holds of
// the members that record declares.
const cellar = desks[1]!;
for (const parcel of parcels.slice(1)) console.log(cellar.name, cellar.stamp(parcel), cellar.weigh === undefined);
