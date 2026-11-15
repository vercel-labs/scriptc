// util.isDeepStrictEqual over an array that crossed into checked-dynamic code
// as a live typed view. A getter the comparison runs can define a property on
// the opposite array, which refreshes that value's property table between two
// key reads. Node's key check reads each side's properties as they stand at
// every Get, so the walk continues through the refreshed table: a key the
// refresh kept still compares, a key the getter deleted is missing, and a
// value the getter changed answers the comparison.
import { isDeepStrictEqual } from "node:util";

function triple(): number[] {
  return [1, 2, 3];
}

const invoke: any = triple;

const accessor = (target: any, key: string, read: () => any): void => {
  Object.defineProperty(target, key, { enumerable: true, configurable: true, get: read });
};

const field = (target: any, key: string, value: any): void => {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
};

// The getter rematerializes the view while the comparison is reading keys;
// the refreshed table keeps the properties the view already owned.
{
  const mine: any = invoke();
  const plain: any = [1, 2, 3];
  accessor(mine, "k", () => "A");
  accessor(plain, "k", () => {
    field(mine, "m", 7);
    return "A";
  });
  accessor(mine, "m", () => 7);
  accessor(plain, "m", () => 7);
  console.log("refresh keeps", isDeepStrictEqual(mine, plain));
}

// The same refresh deletes a key the walk has not reached yet: the live table
// no longer has it, so the two arrays differ.
{
  const mine: any = invoke();
  const plain: any = [1, 2, 3];
  accessor(mine, "drop", () => 1);
  accessor(mine, "k", () => "A");
  accessor(plain, "k", () => {
    delete mine.drop;
    field(mine, "touch", 0);
    return "A";
  });
  accessor(plain, "drop", () => 1);
  console.log("refresh removes", isDeepStrictEqual(mine, plain));
}

// The refreshed table still names the key, but the getter answers a value the
// other side does not have.
{
  const mine: any = invoke();
  const plain: any = [1, 2, 3];
  accessor(mine, "k", () => "A");
  accessor(plain, "k", () => {
    field(mine, "m", 7);
    return "B";
  });
  accessor(mine, "m", () => 7);
  accessor(plain, "m", () => 7);
  console.log("refresh differs", isDeepStrictEqual(mine, plain));
}

// A view whose accessors never rematerialize takes the same path without the
// refresh.
{
  const mine: any = invoke();
  const plain: any = [1, 2, 3];
  accessor(mine, "k", () => "A");
  accessor(plain, "k", () => "A");
  console.log("no refresh", isDeepStrictEqual(mine, plain));
}
