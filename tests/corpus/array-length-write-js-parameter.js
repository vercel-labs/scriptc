// Writing `length` on an array that reaches a JavaScript function as a
// checked-dynamic value sets the same length Node sets: shrink drops the
// tail, grow leaves holes, and the array-length rules answer the throws.

/** @param {Array<number>} a */
function clear( a ) {
	a.length = 0;
}

/** @param {Array<number>} a */
function grow( a ) {
	a.length = 4;
}

/** @param {Array<number>} a */
function shrinkTo( a, n ) {
	a.length = n;
}

const list = [ 1, 2, 3 ];
clear( list );
console.log( list.length, list[ 0 ] === undefined );

grow( list );
console.log( list.length, JSON.stringify( list ), JSON.stringify( Object.keys( list ) ) );

const kept = [ 1, 2, 3, 4 ];
shrinkTo( kept, 2 );
console.log( JSON.stringify( kept ) );

const bad = [ 1 ];
try {
	shrinkTo( bad, -1 );
} catch ( error ) {
	console.log( error.constructor.name, error.message );
}

/** @param {Array<number>} a */
function fractional( a ) {
	a.length = 1.5;
}
try {
	fractional( bad );
} catch ( error ) {
	console.log( error.constructor.name, error.message );
}

/** @param {Array<number>} a */
function stringLength( a ) {
	a.length = "2";
}
const coerced = [ 1, 2, 3 ];
stringLength( coerced );
console.log( coerced.length, JSON.stringify( coerced ) );
