// Namespace imports of CommonJS modules in JavaScript: member reads, calls,
// constructions and a method read as a value, through a package's ES
// module and directly. Each name is one Node's lexer detects.
import * as table from './table.cjs'
import { connect, describe } from './client/index.mjs'

console.log(table.add(20, 22), table.scale)
const add = table.add
console.log(add(1, 2))

const pool = connect('http://localhost')
console.log(describe(pool))
console.log(describe(pool))
