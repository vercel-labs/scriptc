// The tail of an optional chain read where its absence matters: compared,
// defaulted or tested. `a?.b.c` reads nothing when `a` is undefined, so the
// comparison sees undefined and does not read `.c` off the missing `a?.b`.
class Settings {
  flag?: boolean;
  label?: string;
  constructor(flag?: boolean) {
    if (flag !== undefined) this.flag = flag;
  }
}

class Holder {
  settings: Settings;
  constructor(settings: Settings) {
    this.settings = settings;
  }
}

let holder: Holder | undefined;
const state: { holder?: Holder; maybe: Holder | null } = { maybe: null };

function report(when: string): void {
  console.log(
    when,
    holder?.settings.flag !== false,
    holder?.settings.flag === true,
    holder?.settings.flag === undefined,
    holder?.settings.flag == null,
    holder?.settings.flag ?? "default",
    holder?.settings.flag || "other",
    holder?.settings.flag ? "yes" : "no",
    holder?.settings.label ?? "unnamed",
    holder?.settings["flag"] !== false,
  );
  console.log(
    when,
    state.holder?.settings.flag !== false,
    state.maybe?.settings.flag ?? "default",
    state.maybe?.settings.flag === true,
  );
}

// The first statement of an async function, as a guard.
async function guarded(): Promise<string> {
  if (holder?.settings.flag !== false) return "returned";
  await Promise.resolve();
  return "went on";
}

async function main(): Promise<void> {
  report("unset");
  console.log(await guarded());
  for (const flag of [undefined, true, false]) {
    holder = new Holder(new Settings(flag));
    state.holder = holder;
    state.maybe = holder;
    report(String(flag));
    console.log(await guarded());
  }
  holder = undefined;
  delete state.holder;
  state.maybe = null;
  report("cleared");
  console.log(await guarded());
}

void main();
