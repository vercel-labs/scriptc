/** @param {Set} seen */
export function remember( seen, value ) {
	seen.add( value );
	return seen.size;
}

/** @param {Map} counts @param {string} key */
export function bump( counts, key ) {
	counts.set( key, ( counts.get( key ) ?? 0 ) + 1 );
	return counts.size;
}

export class Registry {
	/** @param {Set} ids @param {Map} names */
	register( ids, names, id, name ) {
		ids.add( id );
		names.set( id, name );
		return `${ ids.has( id ) }:${ names.get( id ) }`;
	}
}
