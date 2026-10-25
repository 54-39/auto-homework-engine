import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,process.env.WATCH_SOURCE?'.tmp-quiz-retry-baseline':'.tmp-quiz-retry-tests');fs.mkdirSync(output,{recursive:true});
const profile=fs.mkdtempSync(path.join(output,'edge-'));
const edge=process.env.EDGE_BIN||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let source=fs.readFileSync(process.env.WATCH_SOURCE||path.join(root,'content/course/watch.js'),'utf8');
source=source.replace('await wait(ms);','await wait(Math.min(ms, 20));');
source=source.replace('  HW.Watch = {',`  HW.Watch = { _quizTest:{quizDone,runQuiz,runQuizzes:typeof runQuizzes==='function'?runQuizzes:runQuiz,cardHasNoTasks:typeof cardHasNoTasks==='function'?cardHasNoTasks:()=>false,expandTaskCards:typeof expandTaskCards==='function'?expandTaskCards:async()=>{},openBbsCard,findConfirm,dismiss:typeof dismissQuizRetryNotice==='function'?dismissQuizRetryNotice:()=>false,setOn(v){on=v;}},`);
let receipt='';
const emptyPages=process.env.STALL_RECORD?JSON.parse(fs.readFileSync(process.env.STALL_RECORD,'utf8')).issues
  .filter(issue=>issue.stage==='刷课停滞').flatMap(issue=>(issue.scene?.documents||[]).filter(doc=>doc.path==='top/frame[0]'&&doc.html?.includes('class="nullpage"')).map(doc=>doc.html))
  :['<div id="pageDiv"><div class="nullpage">暂无内容</div></div>'];
if(process.argv[2]){
  const data=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  receipt=data.issues.flatMap(x=>x.scene?.documents||[]).find(d=>d.url?.includes('selectWorkQuestionYiPiYue'))?.html||'';
  assert.ok(receipt.includes('Finalresult'),'输入记录缺少成绩页现场');
}
async function checks(source,receipt,emptyPages){
  const out=[];const ok=(v,message)=>{if(!v)throw Error(message||'assertion failed');};
  const test=async(name,fn)=>{try{await fn();out.push({name,ok:true});}catch(e){out.push({name,ok:false,error:e.stack||e.message});}};
  async function setup(config={}){
    window.HW?.Watch?._quizTest.setOn(false);window.HW={};
    document.body.innerHTML='<div id="coursetree"><div id="cur101" class="posCatalog_select posCatalog_active"><span class="posCatalog_name" onclick="getTeacherAjax(1,2,101)">测验一</span><input class="jobUnfinishCount" value="1"><p>任务点未完成</p></div></div><div id="workpop" style="display:none"><p id="popcontent"></p><a id="popno" href="#">取消</a><a id="popok" href="#">确定</a><a id="popCloseFocus" href="#">关闭</a></div><iframe id="iframe" style="width:700px;height:500px"></iframe>';
    const frame=document.getElementById('iframe');const state={fills:[],redos:0,submits:0,cancels:0,claims:0,issues:[],claimed:!!config.claimed};const claimedQuizzes=new Set();
    const pop=document.getElementById('workpop'),text=document.getElementById('popcontent');
    const hide=e=>{e?.preventDefault();state.cancels++;pop.style.display='none';};
    document.getElementById('popno').onclick=hide;document.getElementById('popCloseFocus').onclick=hide;
    const content=html=>{const d=frame.contentDocument;d.open();d.write('<!doctype html><meta charset="utf-8">'+html);d.close();};
    function grade(score=86,initial=false){
      content(initial&&config.receipt?'<title>查看已批阅作业</title>'+config.receipt:`<title>查看已批阅作业</title><p class="Finalresult">最终成绩 ${score} 分</p><p>本次成绩 ${score} 分 满分: 100</p><a class="jb_btn_bg" href="#">重做 (剩余 ${config.zero?0:30} 次)</a><div class="TiMu"><h3 class="mark_name">成绩页只读题</h3><p>我的答案：B 正确答案：A</p></div>`);
      const redo=frame.contentDocument.querySelector('a.jb_btn_bg');
      if(redo)redo.onclick=e=>{e.preventDefault();state.redos++;pop.style.display='none';form();};
      if(config.required&&score<100){text.textContent='未达到及格线，请重做';pop.style.display=config.hidden?'none':'block';}
      if(score===100)document.querySelector('.jobUnfinishCount').value='0';
    }
    function form(){
      content(`<title>${config.keepGradeTitle?'查看已批阅作业':'答题'}</title><div class="TiMu"><h3>选择正确答案</h3><input type="radio" name="answer1"></div><button>提交</button>`);
      frame.contentDocument.querySelector('button').onclick=()=>{
        pop.style.display='block';text.textContent='确认提交？';
        document.getElementById('popok').onclick=e=>{e.preventDefault();state.submits++;pop.style.display='none';grade(config.failAgain?86:100);};
      };
    }
    window.chrome={runtime:{sendMessage:async message=>{
      if(message.type==='HW_WATCH_QUIZ_RETRY'){state.claims++;const id=message.payload.quizId;const first=!state.claimed&&!claimedQuizzes.has(id);if(id)claimedQuizzes.add(id);else state.claimed=true;if(config.stopOnClaim)HW.Watch._quizTest.setOn(false);return{ok:true,first};}
      if(message.type==='HW_WATCH_OPEN_TOPIC'){state.topics=(state.topics||0)+1;frame.contentDocument.querySelector('.ans-attach-ct').classList.add('ans-job-finished');return{ok:true};}
      if(message.type==='HW_ISSUE_ADD')state.issues.push(message.payload);return{ok:true};
    }},storage:{local:{get:async()=>({}),set:async()=>{}}}};
    await new Promise(resolve=>{frame.onload=resolve;frame.srcdoc='<!doctype html><body></body>';});
    grade(86,true);(0,eval)(source);
    HW.Panel={runHomework:async opts=>{state.fills.push(opts);return'填了 1 题';},reportGrade:()=>{}};
    HW.Watch._quizTest.setOn(true);
    return{state,pop,grade,frame};
  }
  await test('真实成绩页回放：顶层仍有待完成章节时，已批阅页仍识别为已交卷，不再识题',async()=>{
    const f=await setup({receipt});ok(HW.Watch._quizTest.quizDone(),'成绩页被当成待答题');
    await HW.Watch._quizTest.runQuiz();ok(f.state.fills.length===0&&f.state.redos===0,'成绩页重复调用 AI');
  });
  await test('86分且平台没有要求重做时，不推断为不及格，也不重做',async()=>{
    const f=await setup();await HW.Watch._quizTest.runQuiz();ok(f.state.redos===0&&f.state.claims===0);
  });
  await test('未达及格线通知的确定按钮不被当成交卷确认',async()=>{
    await setup({required:true});ok(HW.Watch._quizTest.findConfirm()===null,'误把重做提示当成提交确认');
  });
  await test('平台明确要求重做时只点一次原生入口，重新核对后正常提交',async()=>{
    const f=await setup({required:true});await HW.Watch._quizTest.runQuiz();
    ok(f.state.redos===1&&f.state.submits===1&&f.state.fills.length===1);ok(f.state.fills[0].retry===true,'未要求重新核对');
    ok(document.querySelector('.jobUnfinishCount').value==='0','未得到平台完成回执');
  });
  await test('重做后沿用成绩页标题时，仍以新的提交入口识别答题页',async()=>{
    const f=await setup({required:true,keepGradeTitle:true});await HW.Watch._quizTest.runQuiz();ok(f.state.redos===1&&f.state.submits===1);
  });
  await test('重做后仍失败时记录未完成，关闭提示，不无限重做或伪造完成',async()=>{
    const f=await setup({required:true,failAgain:true});await HW.Watch._quizTest.runQuiz();
    ok(f.state.redos===1&&f.state.submits===1);ok(f.state.issues.some(x=>x.message.includes('本轮已重做一次')));
    ok(document.querySelector('.jobUnfinishCount').value==='1');ok(f.pop.style.display==='none','提示遮罩仍挡住下一节');
  });
  await test('后台已登记本轮重做时，重新进入同一测验也不再重做',async()=>{
    const f=await setup({required:true,claimed:true});await HW.Watch._quizTest.runQuiz();ok(f.state.redos===0&&f.state.issues.length>0);
  });
  await test('重做次数耗尽时记录缺口，继续后续而不乱点入口',async()=>{
    const f=await setup({required:true,zero:true});await HW.Watch._quizTest.runQuiz();ok(f.state.redos===0&&f.state.claims===0&&f.state.issues.length>0);
  });
  await test('隐藏的旧重做提示不触发自动重做',async()=>{
    const f=await setup({required:true,hidden:true});await HW.Watch._quizTest.runQuiz();ok(f.state.redos===0&&f.state.claims===0);
  });
  await test('遗留在后续视频页的及格提示只关闭，不误点确定或重做',async()=>{
    const f=await setup({required:true});const d=f.frame.contentDocument;d.open();d.write('<video controls></video>');d.close();
    ok(HW.Watch._quizTest.dismiss());ok(f.state.cancels===1&&f.state.redos===0&&f.pop.style.display==='none');
  });
  await test('讨论卡内层话题延迟出现时先等加载，再打开一次话题',async()=>{
    const f=await setup();const doc=f.frame.contentDocument;
    doc.open();doc.write('<div class="ans-attach-ct"><iframe id="bbsFrame" src="/ananas/modules/insertbbs/index.html" srcdoc="<body>加载中</body>"></iframe></div>');doc.close();
    const frame=doc.getElementById('bbsFrame');await new Promise(resolve=>frame.onload=resolve);
    setTimeout(()=>{frame.contentDocument.body.innerHTML='<div id="topicMainDiv" data="https://groupweb.chaoxing.com/topic/111"></div>';},100);
    ok(await HW.Watch._quizTest.openBbsCard(),'讨论话题尚未加载就被放弃');ok(f.state.topics===1);
  });
  await test('等待后台登记时用户停止，不再点击重做入口',async()=>{
    const f=await setup({required:true,stopOnClaim:true});await HW.Watch._quizTest.runQuiz();ok(f.state.redos===0&&f.state.fills.length===0);
  });
  await test('用户停止后不再开始重做或调用AI',async()=>{
    const f=await setup({required:true});HW.Watch._quizTest.setOn(false);await HW.Watch._quizTest.runQuiz();ok(f.state.redos===0&&f.state.fills.length===0);
  });
  for (const scenario of ['two','graded-first','failed-first','delayed-second','retry-each','unrelated-confirm']) await test('同页多份测验分别处理并提交：'+scenario,async()=>{
    const f=await setup();const root=f.frame.contentDocument;
    root.open();root.write('<iframe id="work1" src="/ananas/modules/work/index.html" data=\'{"jobid":"work-one"}\'></iframe><iframe id="work2" src="/ananas/modules/work/index.html" data=\'{"jobid":"work-two"}\'></iframe>');root.close();
    const frames=[root.getElementById('work1'),root.getElementById('work2')];
    const states=frames.map(()=>({fills:0,submits:0,redos:0}));let wrong=0;
    const mount=(index,editing=false)=>{
      const doc=frames[index].contentDocument;
      if(scenario==='retry-each'&&!editing){
        doc.open();doc.write('<p class="Finalresult">本次成绩 86 分 满分：100</p><p>未达到及格线，请重做</p><button class="jb_btn_bg">重做（剩余2次）</button>');doc.close();
        doc.querySelector('button').onclick=()=>{states[index].redos++;mount(index,true);};return;
      }
      doc.open();doc.write(index===0&&scenario==='graded-first'?'<div class="TiMu">已交卷</div><p class="Finalresult">本次成绩 100 分 满分：100</p>':`<div class="TiMu"><h3>测验${index+1}</h3><input name="answer${index}" type="radio"></div><button>提交</button><button id="popok" style="display:none">确定</button>`);doc.close();
      const submit=doc.querySelector('button');
      if(submit)submit.onclick=()=>{doc.getElementById('popok').style.display='block';};
      const confirm=doc.getElementById('popok');
      if(confirm)confirm.onclick=()=>{
        states[index].submits++;doc.body.innerHTML='<div class="TiMu">已交卷</div><p class="Finalresult">本次成绩 100 分 满分：100</p>';
        if(index===0&&scenario==='unrelated-confirm'){const peer=doc.createElement('button');peer.id='popok';peer.textContent='确认';peer.onclick=()=>{wrong++;};doc.body.append(peer);}
      };
    };
    for(let i=0;i<frames.length;i++){
      await new Promise(resolve=>{frames[i].onload=resolve;frames[i].srcdoc='<body>加载中</body>';});
      if(i===1&&scenario==='delayed-second')setTimeout(()=>mount(i),350);else mount(i);
    }
    HW.Panel.runHomework=async()=>{
      const doc=HW.Watch.quizDocument(),index=frames.findIndex(frame=>frame.contentDocument===doc);
      ok(index>=0,'没有绑定当前测验文档');states[index].fills++;
      if(index===0&&scenario==='failed-first')throw Error('第一份读取失败');
      return'填了1题';
    };
    await HW.Watch._quizTest.runQuizzes();
    ok(states[1].fills===1&&states[1].submits===1,'第二份测验漏处理或提交串到了第一份');
    ok(states[0].fills===(scenario==='graded-first'?0:1),'第一份处理次数错误');
    ok(states[0].submits===(['graded-first','failed-first'].includes(scenario)?0:1),'第一份错误交卷或重复交卷');
    ok(wrong===0,'第二份提交误点了另一份测验的确认按钮');
    if(scenario==='retry-each')ok(states.every(state=>state.redos===1)&&f.state.claims===2,'两份测验没有各自登记和重做一次');
  });
  await test('折叠任务先展开再识别，已展开任务和普通按钮不被误点',async()=>{
    const f=await setup(),doc=f.frame.contentDocument;
    doc.open();doc.write('<div class="blockquote-wrap"><button class="ans-blockquote-handle">展开学习任务</button><div class="cmd-autoblockquote"></div></div><div class="blockquote-wrap open"><button class="ans-blockquote-handle">收起学习任务</button><div class="cmd-autoblockquote">已展开正文</div></div><button id="ordinary">下一章</button>');doc.close();
    let opened=0,wrong=0;const card=doc.querySelector('.blockquote-wrap');
    card.querySelector('button').onclick=()=>{opened++;card.classList.add('open');setTimeout(()=>{const frame=doc.createElement('iframe');frame.srcdoc='<div class="TiMu"><h3>展开后出现的测验</h3><input name="answer1" type="radio"></div><button>提交</button>';card.querySelector('.cmd-autoblockquote').append(frame);},60);};
    doc.querySelector('.open button').onclick=()=>{wrong++;};doc.getElementById('ordinary').onclick=()=>{wrong++;};
    await HW.Watch._quizTest.expandTaskCards();await new Promise(r=>setTimeout(r,100));
    ok(opened===1&&wrong===0,'折叠任务未展开或误点其他按钮');
    ok(HW.Watch.quizDocument()?.body.innerText.includes('展开后出现的测验'),'展开后的题目未进入测验读取范围');
    await HW.Watch._quizTest.expandTaskCards();ok(opened===1,'已展开的任务被重复点击');
  });
  await test('异常现场中的暂无内容页可明确识别，不把正常任务或隐藏模板当空页',async()=>{
    const f=await setup(),doc=f.frame.contentDocument;
    for(const html of emptyPages){doc.open();doc.write(html);doc.close();ok(HW.Watch._quizTest.cardHasNoTasks(),'未识别平台暂无内容页');}
    for(const html of ['<div id="pageDiv"><div class="nullpage" style="display:none">暂无内容</div><p>真实正文</p></div>','<div id="pageDiv"><div class="nullpage">暂无内容</div><iframe srcdoc="真实任务"></iframe></div>']){
      doc.open();doc.write(html);doc.close();ok(!HW.Watch._quizTest.cardHasNoTasks(),'隐藏模板或实际任务被当成空页');
    }
  });
  return out;
}
const server=http.createServer((req,res)=>res.end('<!doctype html><meta charset="utf-8"><body>fixture</body>'));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const child=spawn(edge,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
let ws;
try{
  let port;for(let i=0;i<150;i++){const file=path.join(profile,'DevToolsActivePort');if(fs.existsSync(file)){port=Number(fs.readFileSync(file,'utf8').split('\n')[0]);break;}await pause(100);}assert.ok(port);
  const tab=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
  ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});let seq=0;const pending=new Map();
  ws.onmessage=({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error(method+' timeout')),45000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
  await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/mycourse/studentstudy?courseId=1&clazzid=2`});await pause(150);
  await call('Network.enable');await call('Network.setBlockedURLs',{urls:['https://*','http://*']});
  const result=await call('Runtime.evaluate',{expression:`(${checks.toString()})(${JSON.stringify(source)},${JSON.stringify(receipt)},${JSON.stringify(emptyPages)})`,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
  const rows=result.result.value;for(const row of rows)console.log(row.ok?'PASS':'FAIL',row.name,row.error||'');
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(rows,null,2));assert.ok(rows.every(r=>r.ok),'存在未通过的测验重做检查');
  console.log(rows.length+' quiz retry browser groups passed (offline).');
  await call('Browser.close').catch(()=>{});
}finally{
  ws?.close();child.kill();server.closeAllConnections();server.close();await pause(200);
  const relative=path.relative(output,profile);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
  try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:4,retryDelay:100});}catch{}
}
