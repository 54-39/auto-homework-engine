import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(process.env.FONT_SOURCE||new URL('../content/homework/font-decoder.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('  async function prepareDoc('),source.indexOf('  const ready ='));
function fixture(){
 let calls=0,mode='fail',src='url(data:font/ttf;base64,AA==)',deferred;
 const states=new WeakMap(),doc={};
 const context=vm.createContext({states,source:()=>src,Map,Uint8Array,atob:s=>Buffer.from(s,'base64').toString('binary'),
  glyphs:()=>new Map([['x',new Uint8Array([1])]]),crypto:{subtle:{digest:async()=>new Uint8Array([1,2,3]).buffer}},
  chrome:{runtime:{sendMessage:async()=>{calls++;if(mode==='fail')throw Error('后台暂时不可用');if(mode==='defer')return await new Promise((resolve,reject)=>{deferred={resolve,reject};});return{ok:true,map:{'010203':'甲'}};}}}});
 vm.runInContext(code,context);return{run:()=>context.prepareDoc(doc),states,doc,calls:()=>calls,setMode:value=>{mode=value;},setSource:value=>{src=value;},deferred:()=>deferred};
}
{
 const f=fixture();await assert.rejects(f.run(),/后台暂时不可用/);f.setMode('ok');await f.run();assert.equal(f.calls(),2);assert.equal(f.states.get(f.doc).map.get('x'),'甲');
 console.log('PASS 字体索引请求暂时失败后，同页再次读取可以恢复，不永久缓存失败');
}
{
 const f=fixture();f.setMode('ok');await Promise.all([f.run(),f.run()]);assert.equal(f.calls(),1);await f.run();assert.equal(f.calls(),1);
 console.log('PASS 并发和已成功的相同字体仍复用一次请求');
}
{
 const f=fixture();f.setMode('defer');const old=f.run();await Promise.resolve();await Promise.resolve();
 while(!f.deferred())await Promise.resolve();
 f.setMode('ok');f.setSource('url(data:font/ttf;base64,AQ==)');await f.run();const current=f.states.get(f.doc);
 f.deferred().reject(Error('旧请求失败'));await assert.rejects(old,/旧请求失败/);assert.equal(f.states.get(f.doc),current);assert.equal(current.map.get('x'),'甲');
 console.log('PASS 旧字体请求迟到失败不会删除新字体的成功状态');
}
