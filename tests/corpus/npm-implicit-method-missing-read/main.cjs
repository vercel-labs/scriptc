// A method instance answers the missing indexed read its body returns, so
// the call past the end prints undefined instead of throwing.
const { Cursor } = require('scan')
const cursor = new Cursor()
cursor.setInput('ab')
console.log(cursor.charAfter(0), cursor.charAfter(5))
console.log(cursor.startsWithDash())
cursor.setInput('-x')
console.log(cursor.startsWithDash(), cursor.charAfter(3))
