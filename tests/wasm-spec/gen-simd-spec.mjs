// Run official SIMD assertions inside Wasm, so vector values never cross JS.
// Usage: node gen-simd-spec.mjs <spec checkout> <wat2wasm executable>
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const [spec,wat2wasm]=process.argv.slice(2);
if(!spec||!wat2wasm)throw Error('expected spec checkout and wat2wasm');
const sha=execFileSync('git',['-C',spec,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
function parse(text){
 let i=0;
 const space=()=>{for(;;){while(/\s/.test(text[i]??'')&&i<text.length)i++;if(text.slice(i,i+2)===';;'){while(i<text.length&&text[i]!=='\n')i++;}else if(text.slice(i,i+2)==='(;'){i+=2;let n=1;while(n&&i<text.length){if(text.slice(i,i+2)==='(;'){n++;i+=2;}else if(text.slice(i,i+2)===';)'){n--;i+=2;}else i++;}}else return;}};
 const expr=()=>{space();if(text[i]==='('){i++;let a=[];space();while(text[i]!==')'){if(i>=text.length)throw Error('unterminated list');a.push(expr());space();}i++;return a;}let start=i;if(text[i]==='"'){i++;while(i<text.length){if(text[i]==='\\'){i+=2;continue;}if(text[i++]==='"')break;}}else while(i<text.length&&!/[\s()]/.test(text[i]))i++;return text.slice(start,i);};
 let out=[];space();while(i<text.length){out.push(expr());space();}return out;
}
const print=x=>Array.isArray(x)?'('+x.map(print).join(' ')+')':x;
const head=(x,h)=>Array.isArray(x)&&x[0]===h;
const temp=mkdtempSync(join(tmpdir(),'simd-spec-'));
const groups={simd:[], 'relaxed-simd':[]};
const stats={assertions:0,traps:0,invalid:0,skipped:[]};
const invalid=[];
function compare(expected, local){
 if(head(expected,'either'))return expected.slice(1).map(e=>compare(e,local)).reduce((a,b)=>`(i32.or ${a} ${b})`);
 if(!Array.isArray(expected))throw Error('bad expected');
 if(expected[0]==='v128.const'){
  const shape=expected[1], values=expected.slice(2), floating=shape[0]==='f';
  if(!floating||!values.some(v=>v==='nan:canonical'||v==='nan:arithmetic'))return `(i32.eqz (v128.any_true (v128.xor (local.get ${local}) ${print(expected)})))`;
  const bits=shape.startsWith('f32')?32:64, it='i'+bits;
  const conditions=values.map((v,i)=>{
   const lane=`(i${bits}x${128/bits}.extract_lane ${i} (local.get ${local}))`;
   if(v==='nan:canonical')return `(${it}.eq (${it}.and ${lane} (${it}.const ${bits===32?'0x7fffffff':'0x7fffffffffffffff'})) (${it}.const ${bits===32?'0x7fc00000':'0x7ff8000000000000'}))`;
   if(v==='nan:arithmetic')return `(${it}.eq (${it}.and ${lane} (${it}.const ${bits===32?'0x7fc00000':'0x7ff8000000000000'})) (${it}.const ${bits===32?'0x7fc00000':'0x7ff8000000000000'}))`;
   return `(${it}.eq ${lane} (${it}.reinterpret_f${bits} (f${bits}.const ${v})))`;
  });return conditions.reduce((a,b)=>`(i32.and ${a} ${b})`);
 }
 const t=expected[0].split('.')[0],v=expected[1];
 if(t==='f32'||t==='f64'){
  const bits=t.slice(1),it='i'+bits;
  if(v==='nan:canonical'||v==='nan:arithmetic'){
   const value=`(${it}.reinterpret_${t} (local.get ${local}))`;
   const mask=v==='nan:canonical'?(bits==='32'?'0x7fffffff':'0x7fffffffffffffff'):(bits==='32'?'0x7fc00000':'0x7ff8000000000000');
   return `(${it}.eq (${it}.and ${value} (${it}.const ${mask})) (${it}.const ${bits==='32'?'0x7fc00000':'0x7ff8000000000000'}))`;
  }
  return `(${it}.eq (${it}.reinterpret_${t} (local.get ${local})) (${it}.reinterpret_${t} ${print(expected)}))`;
 }
 return `(${t}.eq (local.get ${local}) ${print(expected)})`;
}
function resultType(e){if(head(e,'either'))return resultType(e[1]);if(e[0]==='v128.const')return 'v128';return e[0].split('.')[0];}
function compile(wat,check=true){writeFileSync(join(temp,'x.wat'),wat);execFileSync(wat2wasm,[join(temp,'x.wat'),'--enable-relaxed-simd','--enable-extended-const',...(check?[]:['--no-check']),'-o',join(temp,'x.wasm')],{stdio:'pipe',maxBuffer:1024*1024});return readFileSync(join(temp,'x.wasm')).toString('base64');}
try {
for(const group of Object.keys(groups))for(const file of readdirSync(join(spec,'test/core',group)).filter(f=>f.endsWith('.wast')).sort()){
 const commands=parse(readFileSync(join(spec,'test/core',group,file),'utf8'));
 let mod=null, exports=new Map(), returns=new Map(), tests=[], moduleNumber=0;
 const flush=()=>{if(!mod||!tests.length)return;const fields=mod.slice(1).filter(x=>typeof x!=='string'||!x.startsWith('$'));for(let start=0;start<tests.length;start+=200){const chunk=tests.slice(start,start+200);const wat=print(['module',...fields,...chunk.map(t=>t.wat)]);try{const base64=compile(wat);const instance=new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(base64,'base64')));for(const t of chunk){try{const result=instance.exports[t.name]();if(t.trap||result!==1)throw Error('unexpected '+result);}catch(e){if(!t.trap||!(e instanceof WebAssembly.RuntimeError))throw Error(file+' '+t.name+': '+e.message);}}groups[group].push({file,module:moduleNumber,base64,tests:chunk.map(({name,trap})=>({name,trap}))});}catch(e){throw Error(file+' module '+moduleNumber+': '+e.message);}}tests=[];};
 for(let ci=0;ci<commands.length;ci++){
  const cmd=commands[ci];
  if(head(cmd,'module')){flush();if(cmd[1]==='binary'){
    const bytes=[];for(const string of cmd.slice(2)){const raw=string.slice(1,-1);for(let j=0;j<raw.length;j++){if(raw[j]==='\\'){bytes.push(parseInt(raw.slice(j+1,j+3),16));j+=2;}else bytes.push(raw.charCodeAt(j));}}
    writeFileSync(join(temp,'binary.wasm'),Buffer.from(bytes));
    const wat=execFileSync(join(wat2wasm,'../wasm2wat'),[join(temp,'binary.wasm'),'--enable-relaxed-simd'],{encoding:'utf8'});cmd.splice(0,cmd.length,...parse(wat)[0]);
   }mod=cmd;moduleNumber++;exports=new Map();returns=new Map();let f=0,g=0;for(const field of mod.slice(1)){if(head(field,'func')){returns.set(String(f),field.filter(x=>head(x,'result')).reduce((n,x)=>n+x.length-1,0));for(const item of field)if(head(item,'export'))exports.set(item[1],['call',String(f)]);f++;}else if(head(field,'global')){for(const item of field)if(head(item,'export'))exports.set(item[1],['global.get',String(g)]);g++;}else if(head(field,'export')){const target=field[2];if(!target[1].startsWith('$'))exports.set(field[1],[target[0]==='func'?'call':'global.get',target[1]]);}else if(head(field,'import')&&head(field[3],'func'))f++;}continue;}
  if(head(cmd,'assert_return')||head(cmd,'assert_trap')){
   const action=cmd[1];if(!head(action,'invoke')&&!head(action,'get')){stats.skipped.push(`${group}/${file}:${ci}:action`);continue;}
   let actionIndex=1;if(action[actionIndex]?.startsWith('$')){stats.skipped.push(`${group}/${file}:${ci}:named-module`);continue;}
   const target=exports.get(action[actionIndex]);if(!target){stats.skipped.push(`${group}/${file}:${ci}:export`);continue;}
   const call=[...target,...action.slice(actionIndex+1)];const name='check'+ci, trap=cmd[0]==='assert_trap';
   let wat;
   if(trap){wat=['func',['export',JSON.stringify(name)],['result','i32'],call,...Array.from({length:target[0]==='global.get'?1:returns.get(target[1])??0},()=>['drop']),['i32.const','0']];stats.traps++;}
   else if(cmd.length===2){wat=['func',['export',JSON.stringify(name)],['result','i32'],call,['i32.const','1']];stats.assertions++;}
   else if(cmd.length===3){const t=resultType(cmd[2]);wat=['func',['export',JSON.stringify(name)],['result','i32'],['local',t],['local.set','0',call],parse(compare(cmd[2],'0'))[0]];stats.assertions++;}
   else {stats.skipped.push(`${group}/${file}:${ci}:multivalue`);continue;}
   tests.push({name,trap,wat});
  }else if(head(cmd,'assert_invalid')){
   try{const base64=compile(print(cmd[1]),false);if(WebAssembly.validate(Buffer.from(base64,'base64')))stats.skipped.push(`${group}/${file}:${ci}:V8 accepts invalid assertion`);else{invalid.push({file,command:ci,base64});stats.invalid++;}}
   catch{stats.skipped.push(`${group}/${file}:${ci}:text-only invalid`);}
  }
  else if(!head(cmd,'assert_malformed')&&!head(cmd,'register'))stats.skipped.push(`${group}/${file}:${ci}:${cmd[0]}`);
 }
 flush();
}
const destination=new URL('./corpus/simd-spec.json',import.meta.url);
writeFileSync(destination,JSON.stringify({source:{repository:'WebAssembly/spec',sha,wabt:'1.0.39'},stats,groups:Object.fromEntries(Object.entries(groups).map(([group,modules])=>[group,modules.map(({tests,...module})=>({...module,assertions:tests.length}))])),invalid},null,2)+'\n');
for(const [group,all] of Object.entries(groups))for(let start=0;start<all.length;start+=16){
 const modules=all.slice(start,start+16);
 const part=String(start/16+1).padStart(2,'0');
 const dir=new URL(`../corpus/webassembly-${group}-spec-${part}/`,import.meta.url);mkdirSync(dir,{recursive:true});
 writeFileSync(new URL('main.mjs',dir),`// Generated from WebAssembly/spec ${sha}, Apache-2.0.\nconst modules=${JSON.stringify(modules)};\nlet checked=0;\nfor(const m of modules){\n const x=new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(m.base64,'base64'))).exports;\n for(const t of m.tests){\n  try{const r=x[t.name]();if(t.trap||r!==1)throw Error(m.file+' '+t.name+' result '+r);}\n  catch(e){if(!t.trap||!(e instanceof WebAssembly.RuntimeError))throw e;}\n  checked++;\n }\n}\nconsole.log('official ${group} ${part}',modules.length,checked);\n`);
}
console.log(JSON.stringify({stats,modules:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.length]))}));
}finally{rmSync(temp,{recursive:true,force:true});}
