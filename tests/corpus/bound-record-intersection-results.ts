// The result idiom `({ ok: true } & T) | { ok: false; error: E }`: inside a
// generic body instantiated with a record T, `{ ok: true } & T` is the
// combined record; `Record<string, never>` (no value) adds no field.
type Result<T = Record<string, never>, E = string> = ({ok: true} & T) | {ok: false; error: E}

const succeed = <T extends object = Record<string, never>>(value?: T): Result<T, never> =>
  ({ok: true, ...(value ?? ({} as T))})
const fail = <E>(error: E): Result<never, E> => ({ok: false, error})

const write = (n: number): Result<{nwritten: number}> => (n < 0 ? fail('EINVAL') : succeed({nwritten: n}))
const remove = (n: number): Result => (n < 0 ? fail('ENOENT') : succeed())

let total = 0
for (let i = -2; i < 5; i++) {
  const r = write(i)
  if (r.ok) total += r.nwritten
  else total += r.error.length
  if (remove(i).ok) total += 100
}
console.log(total)
