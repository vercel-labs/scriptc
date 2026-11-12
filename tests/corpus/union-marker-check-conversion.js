// A union of a vector and plain coordinates narrowed by the vector's own
// marker property: the value reaching the vector parameter is a `Vector3` at
// run time and converts to the union the parameter declares, while the branch
// that takes plain numbers keeps its numbers.

class Vector3 {
	constructor( x, y, z ) {
		this.isVector3 = true;
		this.x = x;
		this.y = y;
		this.z = z;
	}

	/** @param {Vector3|undefined} v */
	copy( v ) {
		if ( v !== undefined ) {
			this.x = v.x;
			this.y = v.y;
			this.z = v.z;
		}
		return this;
	}

	/** @param {number} x @param {number} y @param {number} z */
	set( x, y, z ) {
		this.x = x;
		this.y = y;
		this.z = z;
		return this;
	}
}

/** @type {Vector3} */
const target = new Vector3( 0, 0, 0 );

class Camera {
	/**
	 * @param {number|Vector3} x
	 * @param {number} y
	 * @param {number} z
	 */
	lookAt( x, y, z ) {
		if ( x.isVector3 ) {
			target.copy( x );
		} else {
			target.set( x, y, z );
		}
	}
}

new Camera().lookAt( new Vector3( 1, 2, 3 ), 0, 0 );
console.log( target.x, target.y, target.z );

new Camera().lookAt( 4, 5, 6 );
console.log( target.x, target.y, target.z );

const lone = new Vector3( 7, 8, 9 );
new Camera().lookAt( lone, 0, 0 );
console.log( target.x, target.y, target.z, lone.isVector3 );
