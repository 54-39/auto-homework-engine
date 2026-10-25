import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=fs.readFileSync(process.env.WATCH_SOURCE||new URL('../content/course/watch.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('  async function watchVideo()'),source.indexOf('  /* 在所有同源文档里按文案找'));
function fixture(initial, stop=false){
  let remaining=initial,ticks=0;
  const STOP=Symbol('stop'), v={ended:false,paused:true,currentTime:52,duration:102,playbackRate:1,ownerDocument:{defaultView:{}},addEventListener(){},removeEventListener(){}};
  const context=vm.createContext({on:true,gen:1,videoFailure:null,videoAttempt:0,VIDEO_WAIT:12000,TICK:500,guard:0,
    document:{hidden:true},activeChapterId:()=> '101',unfinishedOf:()=>remaining,
    pendingVideos:()=>[v],findVideo:()=>v,videoJobsDone:()=>false,videoJobs:()=>[],
    Date,Set,Error,Math,Number,clearInterval(){},setInterval:()=>7,live(){},note(){},
    kickFails:0,lastKick:0,lastRateTry:0,menuSupport:null,menuClickedRate:0,rateFixes:0,lastForegroundAsk:Date.now(),
    chrome:{runtime:{sendMessage:async()=>({ok:true})}},
    step:async()=>{ticks++;if(stop||ticks>1)throw STOP;remaining=0;},
  });
  vm.runInContext(code,context);
  return {run:()=>context.watchVideo(),ticks:()=>ticks,STOP};
}
{
  const f=fixture(0);assert.equal(await f.run(),true);assert.equal(f.ticks(),0);
  console.log('PASS 章节已完成时不再等待后台音频恢复');
}
{
  const f=fixture(1);assert.equal(await f.run(),true);assert.equal(f.ticks(),1);
  console.log('PASS 等待后台播放期间任务归零，立即继续后续章节');
}
{
  const f=fixture(null,true);await assert.rejects(f.run(),e=>e===f.STOP);
  console.log('PASS 未知任务数不当作完成，保留人工停止');
}
