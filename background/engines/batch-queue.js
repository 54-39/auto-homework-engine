/* 最多两个批次并行；单次作答直接采用，不再把同一批题重复问一遍
   （题目相同模型必然给相同答案，复核没有区分度；用户 2026-11-09 要求去掉）。
   只在模型漏题/空答时补问缺的题。 */
export function startBatchQueue(items, request, isCurrent = () => true, concurrency = 2) {
  const batches = [];
  for (let i = 0; i < items.length; i += 5) batches.push(items.slice(i, i + 5));
  const deferred = new Map(items.map(item => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return [item.id, { promise, resolve }];
  }));
  let next = 0;
  let stopped = false;
  const active = () => !stopped && isCurrent();
  async function process(batch) {
    let first;
    try {
      if (!active()) throw new Error('答题已取消');
      first = await request(batch);
      if (!active()) throw new Error('答题已取消');
      /* 模型漏题/个别空答时，只把缺的题补问一次（2026-11-06 概率论实测：
         直接猜选的题全错，补问比猜选准得多）；补不到仍按无答案走兜底。 */
      const missing = batch.filter(item => !first.answers.get(item.id));
      if (missing.length) {
        try {
          const refill = await request(missing);
          for (const item of missing) {
            const again = refill.answers.get(item.id);
            if (again) {
              first.answers.set(item.id, again);
              if (refill.raw) first.raw = (first.raw || '') + '\n补答：' + refill.raw;
            }
          }
        } catch { /* 补问失败不拖垮已拿到的答案；缺的题仍按无答案走兜底 */ }
        if (!active()) throw new Error('答题已取消');
      }
      for (const item of batch) {
        const answer = first.answers.get(item.id);
        let error;
        if (!answer) {
          const calcError = first.answers.calculationErrors?.get(item.id);
          error = new Error(calcError || 'AI 未返回有效答案');
          error.code = 'HW_ANSWER_UNAVAILABLE';
          error.answerPreview = '初答：' + (first.raw || '');
        }
        deferred.get(item.id).resolve(error ? { error } : { answer, verified: true, note: 'AI 单次作答，请核对',
          reasoning: batch.length === 1 ? (first.reasoning || '') : '' }); // 批量回复只有一段思考，不重复贴给每道题
      }
    } catch (error) {
      for (const item of batch) {
        const answer = first?.answers.get(item.id);
        const itemError = new Error(String(error?.message || error));
        if (error?.status) itemError.status = error.status;
        if (error?.code) itemError.code = error.code;
        if (answer) itemError.candidateAnswer = answer;
        if (first?.raw) itemError.answerPreview = '初答：' + first.raw;
        deferred.get(item.id).resolve({ error: itemError });
      }
    }
  }
  async function worker() {
    while (next < batches.length && active()) {
      const batch = batches[next++];
      await process(batch);
    }
  }
  for (let i = 0; i < Math.max(1, Math.min(2, concurrency)); i++) void worker();
  return { get(id) { return deferred.get(id)?.promise; }, stop() { stopped = true; } };
}
