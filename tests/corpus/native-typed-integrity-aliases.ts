"use strict";

const freeze = Object.freeze;
const seal = Object.seal;
const preventExtensions = Object.preventExtensions;
const isFrozen = Object.isFrozen;
const isSealed = Object.isSealed;
const isExtensible = Object.isExtensible;

const record = { count: 1 };
console.log("freeze alias", freeze(record) === record, isFrozen(record));
try { record.count = 2; }
catch (error) { console.log("alias write", (error as Error).name); }

const sealed = { count: 1 };
console.log("seal alias", seal(sealed) === sealed, isSealed(sealed));
sealed.count = 2;
console.log("sealed write", sealed.count, isFrozen(sealed));

const fixed = { count: 1 };
console.log("prevent alias", preventExtensions(fixed) === fixed, isExtensible(fixed));

function localFreeze(value: { count: number }): { count: number } {
  const local = Object.freeze;
  return local(value);
}
const local = { count: 3 };
console.log("local alias", localFreeze(local) === local, Object.isFrozen(local));
