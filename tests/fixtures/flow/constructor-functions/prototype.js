// @flow
// A constructor function that main.mjs reaches through this module's
// exports taken as a whole, and whose prototype it gives a field there.

type Named = {name: string, title?: string};

export function NamedThing(this: $FlowFixMe, name: string) {
  this.name = name;
}

export function make(name: string): Named {
  const thing: Named = new (NamedThing: any)(name);
  return thing;
}
