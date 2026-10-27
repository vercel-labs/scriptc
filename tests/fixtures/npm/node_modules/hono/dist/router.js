//#region src/router.ts
/**
* @module
* This module provides types definitions and variables for the routers.
*/
/**
* Constant representing all HTTP methods in uppercase.
*/
const METHOD_NAME_ALL = "ALL";
/**
* Constant representing all HTTP methods in lowercase.
*/
const METHOD_NAME_ALL_LOWERCASE = "all";
/**
* Array of supported HTTP methods.
*/
const METHODS = [
	"get",
	"post",
	"put",
	"delete",
	"options",
	"patch",
	"query"
];
/**
* Error message indicating that a route cannot be added because the matcher is already built.
*/
const MESSAGE_MATCHER_IS_ALREADY_BUILT = "Can not add a route since the matcher is already built.";
/**
* Error class representing an unsupported path error.
*/
var UnsupportedPathError = class extends Error {};
//#endregion
export { MESSAGE_MATCHER_IS_ALREADY_BUILT, METHODS, METHOD_NAME_ALL, METHOD_NAME_ALL_LOWERCASE, UnsupportedPathError };
