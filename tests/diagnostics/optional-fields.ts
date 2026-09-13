// The fences around optional fields. Optional fields themselves compile —
// record fields AND class fields (undefined-armed union slots; corpus 967
// and 2047) — and `{a: string}` values COERCE into `{a?: string}` slots
// (the width-copy field lift). The string | undefined root compiles now
// (corpus 2788); number | undefined remains a BARE undefined-armed union
// with no root stringify lowering. Record FIELDS get Node's drop treatment;
// the CAST direction compiles — the checked-dynamic tree holds first-class undefined.

function mkMaybe(): number | undefined {
  return undefined;
}
const stringifyBare = JSON.stringify(mkMaybe());
