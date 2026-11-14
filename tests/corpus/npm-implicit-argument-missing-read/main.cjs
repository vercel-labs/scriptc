// The undefined a wrapper method answers for a missing read reaches an
// untyped parameter at that widened type, where the callee tests for it.
const { Cursor } = require('scan')
const cursor = new Cursor()
cursor.setInput('ab')
console.log(cursor.isEmptyAt(0), cursor.isEmptyAt(1), cursor.isEmptyAt(2), cursor.isEmptyAt(5))
