// An array literal that holds an optional member read: the property may be
// missing, so the element is a present undefined and Node prints null in
// JSON and undefined in the direct form. Every element keeps its position,
// the literal's length counts it, and a present member keeps its value.
interface Creds {
  user?: string;
  realm: string;
}

class Box {
  label?: string;
  tag: string = "t";
}

const creds: Creds = { realm: "r" };
const box = new Box();
const fromMember = [creds.user, creds.realm];
console.log(JSON.stringify(fromMember), fromMember.length, fromMember[0] === undefined);
console.log(fromMember);

function pick(c: Creds): string | undefined {
  return c.user;
}
const fromCall = [pick(creds), "z"];
console.log(JSON.stringify(fromCall), fromCall[0] === undefined);

// A class instance's optional field reads the same way.
console.log(JSON.stringify([box.label, box.tag]), box.label === undefined);

// A present member stores its value in the same slot.
const present: Creds = { user: "ann", realm: "r" };
const both = [present.user, present.realm];
console.log(JSON.stringify(both), both[0]);

// The inferred element type is (string | undefined)[]: a read back out is
// the undefined the slot kept, and a defined element stays a string.
const readBack: string | undefined = fromMember[1];
console.log(readBack, typeof fromMember[1]);

// JSON keeps null for the missing member alone, and for the whole array.
console.log(JSON.stringify(creds.user), JSON.stringify([present.user]));
