// The es-define-property index.js shape: a capability probe selects
// Object.defineProperty or falls back to false, and the whole export is
// that binding, copied at the export statement.
'use strict';

/** @type {import('.')} */
var $defineProperty = Object.defineProperty || false;
if ($defineProperty) {
	try {
		$defineProperty({}, 'a', { value: 1 });
	} catch (e) {
		// IE 8 has a broken defineProperty
		$defineProperty = false;
	}
}

module.exports = $defineProperty;
