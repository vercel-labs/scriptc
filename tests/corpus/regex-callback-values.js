"use strict";
console.log('ab'.replace(/a/), 'ab'.replaceAll(/a/g));
let calls = [];
console.log('ab ac'.replace(/a(b)?/g, function(...args) { calls.push([this===undefined,args.length,args[1]===undefined,args[2]]); return args[1]===undefined?undefined:42; }));
console.log(JSON.stringify(calls));
console.log('b'.replace(/(?<x>a)|b/, (...args)=> { const groups = args.at(-1); console.log(Object.getPrototypeOf(groups)===null,groups.x===undefined); return {toString(){return 'object';}}; }));
console.log('ab'.replace(/(?:(?<x>a)|(?<x>b))/g, (...args) => args.at(-1).x));
let nested=[];
console.log('aa'.replace(/a/g, ()=>{ nested.push('b'.replace(/b/,(m)=>m.toUpperCase())); return 'outer'; }));
console.log(nested.join(','));

const pattern=/a/g;
console.log('aa'.replace(pattern, () => { pattern.exec('z'); return 'x'; }));
let coercions=[];
try { console.log('aa'.replace(/a/g, () => ({toString(){coercions.push('coerce');throw new Error('conversion');}}))); }
catch(error){console.log(error.message,coercions.join(','));}
