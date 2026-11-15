// A module-level binding whose asserted type only adds an optional member to
// the record it stores: the binding keeps that stored layout, and the added
// member answers from the layout's kept source.
interface Base {
  name: string;
}

const item = JSON.parse('{"name":"n","icons":["a"],"other":7}') as Base;
const none = JSON.parse('{"name":"b"}') as Base;
export const view = item as Base & { icons?: unknown };
export const bare = none as Base & { icons?: unknown };
