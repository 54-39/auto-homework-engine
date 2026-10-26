import assert from 'node:assert/strict';
import { openBridgeSplit, openBridgeView, requestWithBridge } from '../background/engines/bridge-engine.js';
const source=(extra={})=>({id:10,windowId:1,index:2,groupId:-1,pinned:false,splitViewId:-1,url:'https://mooc1.chaoxing.com/work',...extra});
const doubao=(extra={})=>({id:20,windowId:1,index:5,groupId:-1,pinned:false,splitViewId:-1,url:'https://www.doubao.com/chat/',...extra});
function fixture(list){
  const tabs=new Map(list.map(t=>[t.id,{...t}])),calls=[],sent=[];
  const move=async(id,props)=>{
    const tab=tabs.get(id),old={...tab};
    for(const t of tabs.values())if(t.id!==id&&t.windowId===old.windowId&&t.index>old.index)t.index--;
    for(const t of tabs.values())if(t.id!==id&&t.windowId===props.windowId&&t.index>=props.index)t.index++;
    Object.assign(tab,props);calls.push(['move',id,props]);return {...tab};
  };
  globalThis.chrome={notifications:{clear:async id=>{calls.push(['clear-notification',id]);return true;}},windows:{
    get:async id=>({id,tabs:[...tabs.values()].filter(t=>t.windowId===id)}),
    create:async props=>{calls.push(['window',props]);const tab=props.tabId?tabs.get(props.tabId):doubao({id:100});tab.windowId=3;tabs.set(tab.id,tab);return{id:3,tabs:[{...tab}]};},
  },tabs:{
    get:async id=>({...tabs.get(id)}),query:async()=>[...tabs.values()].filter(t=>t.url.includes('doubao.com')).map(t=>({...t})),
    create:async props=>{const tab=doubao({id:100,...props,groupId:-1,splitViewId:-1});tabs.set(tab.id,tab);calls.push(['create',tab.id]);return {...tab};},
    update:async(id,props)=>{Object.assign(tabs.get(id),props);calls.push(['update',id,props]);return {...tabs.get(id)};},
    move,group:async({tabIds,groupId})=>{assert.equal(tabs.get(tabIds).windowId,tabs.get(10).windowId);tabs.get(tabIds).groupId=groupId;calls.push(['group',tabIds]);},
    ungroup:async id=>{tabs.get(id).groupId=-1;calls.push(['ungroup',id]);},
    createSplit:async ids=>{
      const [left,right]=ids.map(id=>tabs.get(id));
      assert.equal(right.index,left.index+1,'两页必须相邻');
      for(const key of ['windowId','groupId','pinned'])assert.equal(left[key],right[key],key);
      assert.ok(left.splitViewId<0&&right.splitViewId<0);left.splitViewId=right.splitViewId=88;calls.push(['split',ids]);return 88;
    },
    unsplit:async id=>{for(const t of tabs.values())if(t.splitViewId===id)t.splitViewId=-1;calls.push(['unsplit',id]);},
    sendMessage:async(id,msg,opts)=>{sent.push({id,type:msg.type,frameId:opts.frameId});return msg.type==='BRIDGE_PING'?{ok:true,ready:true}:{ok:true,text:'测试答案'};},
  }};
  return{tabs,calls,sent};
}
{
  const f=fixture([source()]);delete chrome.tabs.createSplit;
  await assert.rejects(openBridgeSplit(10),/工具栏.*分屏/);assert.equal(f.calls.length,0);
  console.log('PASS 不支持原生接口时明确提示手动分屏，不开新页或窗口');
}
{
  const f=fixture([source()]);const result=await openBridgeSplit(10);
  assert.equal(result.reused,false);assert.equal(f.tabs.get(100).splitViewId,88);
  assert.equal(f.sent.length,0);console.log('PASS 无豆包页时创建并原生分屏，不发送题目');
}
for(const index of [0,5]){
  const f=fixture([source(),doubao({index})]);const result=await openBridgeSplit(10);
  assert.equal(result.reused,true);assert.ok(!f.calls.some(c=>c[0]==='create'));
  console.log('PASS 复用并正确排列位于作业'+(index===0?'左':'右')+'侧的豆包标签');
}
{
  const f=fixture([source({groupId:7}),doubao({windowId:2,groupId:9,pinned:true})]);
  await openBridgeSplit(10);assert.equal(f.tabs.get(20).groupId,7);assert.equal(f.tabs.get(20).pinned,false);
  console.log('PASS 跨窗口复用时先移入当前窗口，再对齐标签组与固定状态');
}
{
  const f=fixture([source({splitViewId:9}),doubao({splitViewId:9})]);
  await openBridgeSplit(10);await openBridgeSplit(10);assert.ok(!f.calls.some(c=>c[0]==='create'||c[0]==='split'));
  console.log('PASS 已与豆包分屏时重复点击直接复用，不拆分或重复开页');
}
{
  const f=fixture([source({splitViewId:9}),doubao()]);
  await assert.rejects(openBridgeSplit(10),/已与其他网页分屏/);assert.equal(f.calls.length,0);
  console.log('PASS 当前页已有其他分屏时明确提示，保留原布局');
}
{
  const f=fixture([source(),doubao({splitViewId:7})]);
  await openBridgeSplit(10);assert.equal(f.tabs.get(20).splitViewId,7);assert.equal(f.tabs.get(100).splitViewId,88);
  console.log('PASS 不拆其他正在使用的豆包分屏');
}
{
  const f=fixture([source(),doubao({id:5,windowId:2,splitViewId:7}),doubao()]);
  await openBridgeSplit(10);await requestWithBridge([{role:'user',content:'测试题'}],{});
  assert.deepEqual(f.sent.map(s=>[s.id,s.frameId]),[[20,0],[20,0]]);
  console.log('PASS 后续桥接使用刚打开的豆包分屏，不误发给其他豆包页');
}
{
  const f=fixture([source()]);
  assert.equal((await openBridgeView(10,{})).mode,'split');
  assert.ok(f.calls.some(c=>c[0]==='split'));
  console.log('PASS 默认开始时自动分屏');
}
{
  const f=fixture([source()]);
  const first=await openBridgeView(10,{viewMode:'window'});
  assert.equal(first.mode,'window');await openBridgeView(10,{viewMode:'window'});
  assert.equal(f.calls.filter(c=>c[0]==='window').length,1);
  assert.equal(f.calls.find(c=>c[0]==='window')[1].focused,false);
  assert.ok(!f.calls.some(c=>c[0]==='split'));
  await requestWithBridge([{role:'user',content:'新窗口测试'}],{});
  assert.deepEqual(f.sent.map(s=>s.id),[100,100]);
  console.log('PASS 新窗口模式不抢焦，重复开始复用窗口并向该窗口发题');
}
{
  const f=fixture([source(),doubao()]);
  await openBridgeView(10,{viewMode:'window'});
  assert.equal(f.tabs.get(20).windowId,3);assert.equal(f.tabs.size,2);
  console.log('PASS 同窗口已有豆包时移入新窗口，不重开网页');
}
{
  const f=fixture([source({splitViewId:9}),doubao({splitViewId:9})]);
  await openBridgeView(10,{viewMode:'window'});
  assert.equal(f.tabs.get(10).splitViewId,-1);assert.equal(f.tabs.get(20).windowId,3);
  await openBridgeView(10,{viewMode:'split'});
  assert.equal(f.tabs.get(20).windowId,1);assert.equal(f.tabs.size,2);
  console.log('PASS 分屏和新窗口可以切换，复用同一个豆包页面');
}
{
  const f=fixture([source(),doubao({splitViewId:7})]);delete chrome.tabs.createSplit;
  assert.equal((await openBridgeView(10,{})).mode,'window');
  assert.equal(f.tabs.get(20).splitViewId,7);assert.equal(f.tabs.get(100).windowId,3);
  console.log('PASS 不支持自动分屏时回退新窗口，不拆其他分屏');
}
{
  const f=fixture([source(),doubao()]);
  const send=chrome.tabs.sendMessage;
  chrome.tabs.sendMessage=async()=>({ok:false,attention:true,error:'豆包需要安全验证'});
  await assert.rejects(requestWithBridge([{role:'user',content:'真实验证'}],{}),/安全验证/);
  assert.ok(!f.calls.some(c=>c[0]==='clear-notification'));
  chrome.tabs.sendMessage=send;
  await requestWithBridge([{role:'user',content:'验证解除'}],{});
  assert.ok(f.calls.some(c=>c[0]==='clear-notification'&&c[1]==='hw-doubao-attention'));
  console.log('PASS 真实验证立即返回且保留通知，恢复就绪后清除旧提醒并正常答题');
}
