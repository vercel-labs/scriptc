// A dictionary type is one type however it is spelled. In each block an
// existing record enters a dictionary under one spelling and is written
// through it, then passes into a slot of the same type spelled another way:
// it is still that record, so a write through the second name reaches the
// first and the original. Each block has a value type of its own.
function show(same: boolean, held: object, source: object, value: unknown): void {
  console.log(same, Object.keys(held).join(","), Object.keys(source).join(","), JSON.stringify(value));
}

// The control: one alias in both places.
type ControlValue = { control: number };
type Control = { [key: string]: ControlValue };
const controlSource = { first: { control: 1 } };
const controlHeld: Control = controlSource;
controlHeld.second = { control: 2 };
const controlAgain: Control = controlHeld;
controlAgain.third = { control: 3 };
show(controlAgain === controlHeld, controlHeld, controlSource, controlAgain);

// Written inline twice.
const inlineSource = { first: { inline: 1 } };
const inlineHeld: { [key: string]: { inline: number } } = inlineSource;
inlineHeld.second = { inline: 2 };
const inlineAgain: { [key: string]: { inline: number } } = inlineHeld;
inlineAgain.third = { inline: 3 };
show(inlineAgain === inlineHeld, inlineHeld, inlineSource, inlineAgain);

// Inline, and through an alias.
type Aliased = { [key: string]: { aliased: number } };
const aliasedSource = { first: { aliased: 1 } };
const aliasedHeld: { [key: string]: { aliased: number } } = aliasedSource;
aliasedHeld.second = { aliased: 2 };
const aliasedAgain: Aliased = aliasedHeld;
aliasedAgain.third = { aliased: 3 };
show(aliasedAgain === aliasedHeld, aliasedHeld, aliasedSource, aliasedAgain);

// A generic alias instantiated, and inline.
type Dict<T> = { [key: string]: T };
const genericSource = { first: { generic: 1 } };
const genericHeld: Dict<{ generic: number }> = genericSource;
genericHeld.second = { generic: 2 };
const genericAgain: { [key: string]: { generic: number } } = genericHeld;
genericAgain.third = { generic: 3 };
show(genericAgain === genericHeld, genericHeld, genericSource, genericAgain);

// Record<string, V>, and the index signature.
const utilitySource = { first: { utility: 1 } };
const utilityHeld: Record<string, { utility: number }> = utilitySource;
utilityHeld.second = { utility: 2 };
const utilityAgain: { [key: string]: { utility: number } } = utilityHeld;
utilityAgain.third = { utility: 3 };
show(utilityAgain === utilityHeld, utilityHeld, utilitySource, utilityAgain);

// The value type through an alias, and inline.
type NamedValue = { named: number };
const namedSource = { first: { named: 1 } };
const namedHeld: { [key: string]: NamedValue } = namedSource;
namedHeld.second = { named: 2 };
const namedAgain: { [key: string]: { named: number } } = namedHeld;
namedAgain.third = { named: 3 };
show(namedAgain === namedHeld, namedHeld, namedSource, namedAgain);

// Interfaces for the dictionary and its value, and a type literal.
interface DeclaredValue {
  declared: number;
}
interface Declared {
  [key: string]: DeclaredValue;
}
const declaredSource = { first: { declared: 1 } };
const declaredHeld: Declared = declaredSource;
declaredHeld.second = { declared: 2 };
const declaredAgain: { [key: string]: { declared: number } } = declaredHeld;
declaredAgain.third = { declared: 3 };
show(declaredAgain === declaredHeld, declaredHeld, declaredSource, declaredAgain);

// Another name for the key.
const keySource = { first: { keyed: 1 } };
const keyHeld: { [key: string]: { keyed: number } } = keySource;
keyHeld.second = { keyed: 2 };
const keyAgain: { [name: string]: { keyed: number } } = keyHeld;
keyAgain.third = { keyed: 3 };
show(keyAgain === keyHeld, keyHeld, keySource, keyAgain);
