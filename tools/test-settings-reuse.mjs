import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../background/service-worker.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('let settingsNavigation = Promise.resolve();'),source.indexOf('chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {'));
function fixture(initial=[]){
 const base='chrome-extension://test/settings.html',tabs=initial.map(t=>({...t})),created=[],updated=[],focused=[];
 let fail=false;
 const context=vm.createContext({URL,Promise,chrome:{runtime:{getURL:p=>'chrome-extension://test/'+p},tabs:{
  query:async spec=>{assert.equal(spec.url,base+'*');if(fail){fail=false;throw Error('临时查询失败');}return tabs.map(t=>({...t}));},
  create:async props=>{await new Promise(r=>setImmediate(r));const tab={id:7,windowId:3,...props};created.push({...props});tabs.push(tab);return tab;},
  update:async(id,props)=>{updated.push({id,...props});Object.assign(tabs.find(t=>t.id===id),props);},
 },windows:{update:async(id,props)=>focused.push({id,...props})}}});
 vm.runInContext(code,context);return{context,tabs,created,updated,focused,fail:()=>{fail=true;}};
}
{
 const f=fixture();await Promise.all([f.context.openSettings('app'),f.context.openSettings('diag'),f.context.openSettings('watch')]);
 assert.equal(f.created.length,1);assert.equal(f.tabs.length,1);assert.equal(f.tabs[0].url,'chrome-extension://test/settings.html#watch');
 assert.equal(f.focused.length,2);console.log('PASS 连续或并发打开设置只创建一个标签，最后定位到对应分区');
}
{
 const f=fixture([{id:4,windowId:9,url:'chrome-extension://test/settings.html#app'}]);await f.context.openSettings('app');
 assert.equal(f.created.length,0);assert.equal(f.updated[0].id,4);assert.equal('url' in f.updated[0],false);assert.equal(f.focused[0].id,9);
 console.log('PASS 其他窗口的设置页直接激活，同分区不重新导航或清空未保存内容');
}
{
 const f=fixture([{id:4,windowId:9,url:'chrome-extension://test/settings.html?updateHealth=fixture#upd'}]);await f.context.openSettings('app');
 assert.equal(f.tabs[0].url,'chrome-extension://test/settings.html?updateHealth=fixture#app');console.log('PASS 切换分区保留设置页现有参数');
}
{
 const f=fixture();f.fail();await assert.rejects(f.context.openSettings('app'),/临时查询失败/);await f.context.openSettings('app');assert.equal(f.created.length,1);
 f.tabs.length=0;await f.context.openSettings('diag');assert.equal(f.created.length,2);console.log('PASS 查询失败不锁死，用户关闭设置页后可重新打开');
}
