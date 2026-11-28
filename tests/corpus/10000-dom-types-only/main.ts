// DOM types are part of the type world a project gets from its tsconfig,
// but not of the runtime: type-only uses compile (Node erases them too),
// while a value use of a DOM global throws at run time as it does in Node.
type MaybeElement = HTMLElement | null
type MaybeDocument = Document | undefined

const element: MaybeElement = null
const document_: MaybeDocument = undefined

export const nothingThere: boolean = element === null && document_ === undefined
console.log(nothingThere ? "dom-types-only" : "unexpected")
