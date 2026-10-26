import assert from 'node:assert/strict';
import { answerWithAPI } from '../background/engines/api-engine.js';

const originalFetch = globalThis.fetch, originalChrome = globalThis.chrome;
const cfg = { iface: 'openai', baseURL: 'https://example.invalid/v1', model: 'fixture', apiKey: 'fixture-key' };
const options = [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }];
globalThis.chrome = { permissions: { contains: async () => true }, storage: { local: { get: async () => ({}), set: async () => {} } } };
let calls;
function replies(values) {
  calls = 0;
  globalThis.fetch = async () => {
    const value = values[calls++];
    if (value instanceof Error) throw value;
    if (typeof value === 'number') return { ok: false, status: value, text: async () => 'fixture error' };
    return { ok: true, json: async () => ({ choices: [{ message: { content: value } }] }) };
  };
}
try {
  for (const [type, values] of [
    ['choice', ['{"answers":[]}']],
    ['multi', ['{"answers":["甲","乙"]}', '{"answers":["甲"]}']],
    ['judge', ['{"answers":["正确"]}', '{"answers":["错误"]}']],
    ['multi', ['{"answers":["甲","乙"]}', '{"answers":[]}']],
  ]) {
    replies(values);
    await assert.rejects(answerWithAPI({ type, stem: '独立核对题目', options }, cfg), e => e.code === 'HW_ANSWER_UNAVAILABLE' && !!e.answerPreview && (type === 'choice' || !!e.candidateAnswer));
    assert.equal(calls, values.length, '无法确认时自动重试了模型');
    console.log('PASS 空答案或复核冲突明确不可确认，保留原始回执：' + type);
  }
  for (const failure of [401, 429, Error('network offline')]) {
    replies(['{"answers":["甲","乙"]}', failure]);
    await assert.rejects(answerWithAPI({ type: 'multi', stem: '网络或权限异常', options }, cfg), e => e.code !== 'HW_ANSWER_UNAVAILABLE');
    assert.equal(calls, 2);
    console.log('PASS 复核鉴权、限流或网络错误保留整轮暂停语义：' + failure);
  }
  for (const failure of [429, 503, Error('network offline')]) {
    replies(['{"answers":["甲","乙"]}', failure]);
    await assert.rejects(answerWithAPI({ type:'multi',stem:'刷课复核暂时失败',options },cfg,{auto:true}),e=>e.code==='HW_ANSWER_UNAVAILABLE'&&e.candidateAnswer==='AB');
    assert.equal(calls,2,'采用初答不应再次请求模型');
    console.log('PASS 刷课复核普通故障保留有效初答，可未确认填写后继续：'+failure);
  }
  for(const failure of [401,403]){
    replies(['{"answers":["甲","乙"]}',failure]);
    await assert.rejects(answerWithAPI({type:'multi',stem:'刷课复核鉴权失败',options},cfg,{auto:true}),e=>e.code!=='HW_ANSWER_UNAVAILABLE'&&e.status===failure);
    assert.equal(calls,2);console.log('PASS 刷课复核鉴权失败仍保留暂停：'+failure);
  }
  for(const thinking of [false,true]){
    const bodies=[];
    globalThis.fetch=async(_,request)=>{bodies.push(JSON.parse(request.body));return bodies.length===1?
      {ok:false,status:400,text:async()=>thinking?'unsupported key: thinking':'invalid model'}:
      {ok:true,json:async()=>({choices:[{message:{content:'{"answers":["甲"]}'}}]})};};
    const task=answerWithAPI({type:'choice',stem:'火山参数拒绝',options},{...cfg,baseURL:'https://ark.cn-beijing.volces.com/api/v3'});
    if(thinking){assert.equal((await task).answer,'A');assert.equal(bodies.length,2);assert.ok(!bodies[1].thinking);}
    else{await assert.rejects(task,/invalid model/);assert.equal(bodies.length,1);}
    console.log('PASS 火山仅对明确不支持thinking的400移除参数一次：'+thinking);
  }
  replies(['{"answers":["甲","乙"]}', '{"answers":["甲","乙"]}']);
  const agreed = await answerWithAPI({ type: 'multi', stem: '一致的答案', options }, cfg);
  assert.equal(agreed.answer, 'AB'); assert.match(agreed.note, /已二次复核确认/); assert.equal(calls, 2);
  console.log('PASS 两次一致正常采用，保持原有二次复核');
  replies(['{"answers":["甲","乙"]}']);
  assert.equal((await answerWithAPI({ type: 'multi', stem: '用户关闭复核', options }, cfg, { verify2: false })).answer, 'AB');
  assert.equal(calls, 1);
  console.log('PASS 用户关闭复核时仍按其设置调用一次');
} finally { globalThis.fetch = originalFetch; globalThis.chrome = originalChrome; }
