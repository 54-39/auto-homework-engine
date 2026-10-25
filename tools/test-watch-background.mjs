import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(process.env.WATCH_SOURCE||new URL('../content/course/watch.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('  function kick(v)'),source.indexOf('  /* 播放器自己的暂停'))+'\n'+
  source.slice(source.indexOf('  async function watchVideo()'),source.indexOf('  /* 在所有同源文档里按文案找'));
function fixture({recover=0,frame=true,error=false,stop=false,verification=false}={}){
 let now=1000000, reloads=0, clicks=0, current, ctx;const timers=[],messages=[], STOP=Symbol('stop'), VERIFY=Object.assign(Error('验证码'),{code:'HW_VERIFICATION_REQUIRED'});
 const makeVideo=()=>({paused:true,ended:false,isConnected:true,currentTime:0,duration:10,playbackRate:1,error:error?{code:4}:null,
  ownerDocument:{defaultView:{frameElement:frame?module:null}},addEventListener(){},removeEventListener(){},click(){clicks++;maybePlay();}});
 const maybePlay=()=>{if(recover && (recover===1||reloads)){current.error=null;current.paused=false;}};
 const module={isConnected:true,scrollIntoView(){},get src(){return 'https://mooc1.chaoxing.com/ananas/modules/video/index.html?test=1';},set src(value){reloads++;current.isConnected=false;current=makeVideo();}};
 current=makeVideo();
 async function step(ms){now+=ms;for(let i=0;i<timers.length;){if(timers[i].at<=now){const [t]=timers.splice(i,1);t.fn();}else i++;}
  if(stop)throw STOP;if(now>1120000)throw Error('无限等待');
  if(!current.paused){current.currentTime++;if(current.currentTime>=10)current.ended=true;}}
 ctx=vm.createContext({on:true,gen:1,videoFailure:null,videoAttempt:0,VIDEO_WAIT:12000,TICK:500,MAX_KICK_FAIL:2,guard:0,
  Date:{now:()=>now},Set,Error,Math,Number,muted:true,kickFails:0,lastKick:0,lastRateTry:0,menuSupport:null,menuClickedRate:0,rateFixes:0,
  document:{hidden:true},activeChapterId:()=> '1',unfinishedOf:()=>1,pendingVideos:()=>[current],findVideo:ended=>current.ended||ended.has(current)?null:current,
  videoJobsDone:()=>false,videoJobs:()=>[{parentElement:{classList:{contains:()=>false}}}],
  setTimeout:(fn,ms)=>timers.push({fn,at:now+ms}),setInterval:()=>1,clearInterval(){},
  pick:()=>({click(){clicks++;maybePlay();}}),checkVerification(){if(verification)throw VERIFY;},
  live(){},note(){},step,applyRate:async()=>{},fmtRate:String,chrome:{runtime:{sendMessage:async m=>messages.push(m)}}});
 vm.runInContext(code,ctx);
 return {run:()=>ctx.watchVideo(),reloads:()=>reloads,clicks:()=>clicks,elapsed:()=>now-1000000,messages,STOP,VERIFY,stop:()=>{ctx.on=false;},flush:()=>{now+=3000;for(const t of timers.splice(0))t.fn();}};
}
for(const recover of [1,2]){
 const f=fixture({recover});assert.equal(await f.run(),true);assert.equal(f.reloads(),recover===1?0:1);assert.deepEqual(f.messages,[]);
 console.log('PASS '+(recover===1?'后台原生播放恢复成功，不抢焦点':'首次恢复失败后只重载播放器一次并正常播完'));
}
{
 const f=fixture();await assert.rejects(f.run(),/自动恢复仍失败/);assert.equal(f.reloads(),1);assert.ok(f.elapsed()<30000);assert.ok(f.clicks()<=8);assert.deepEqual(f.messages,[]);
 console.log('PASS 持续失败有限自愈后退出，不通知用户后空等十分钟');
}
{
 const f=fixture({frame:false});await assert.rejects(f.run(),/自动恢复仍失败/);assert.equal(f.reloads(),0);console.log('PASS 无法定位原生播放器时不刷新整门课');
}
{
 const f=fixture({error:true});await assert.rejects(f.run(),/重新加载后仍报错/);assert.equal(f.reloads(),1);console.log('PASS 真实媒体错误只恢复一次，不伪报完成');
}
{
 const f=fixture({stop:true});await assert.rejects(f.run(),e=>e===f.STOP);const clicks=f.clicks();f.stop();f.flush();assert.equal(f.clicks(),clicks);assert.equal(f.reloads(),0);console.log('PASS 用户停止后迟到的补点击不再执行');
}
{
 const f=fixture({verification:true});await assert.rejects(f.run(),e=>e===f.VERIFY);assert.equal(f.clicks(),0);assert.equal(f.reloads(),0);console.log('PASS 验证码仍暂停，不能用自动恢复绕过');
}
