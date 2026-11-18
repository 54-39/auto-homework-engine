/* 更新内容按版本分组：
   PENDING_RELEASES 放两次 Edge 上架之间的 GitHub 小版本，功能和修复标注加入时的版本号
   （如 1.2.3），并一直保持；最终上架 Edge 时，把这里所有条目合并成一个大版本（如 1.3.0），
   移到 EDGE_RELEASES 最前面并清空。
   EDGE_RELEASES 放已经上架 Edge 的大版本，最新在前。
   展示规则：功能取最近 3 个版本，Bug 修复只取最新 1 个版本。 */
export const PENDING_RELEASES = [];

export const EDGE_RELEASES = [
  {
    version: '1.0.2.0',
    features: [
      '面板新增单题解析：选一道题单独查看参考答案，不填写页面',
      '免费模式新增 DeepSeek 网页版：无需 API Key，可在设置里与豆包切换',
      '支持优课（yooc.me）等通用站点：显示悬浮面板，AI 识题后直接填写',
    ],
    fixes: [
      '修复页面结构导出只查找超星标签页、其他站点无法导出的问题',
    ],
  },
  {
    version: '1.0.1.2',
    features: [],
    fixes: [
      '修复 AI 答案带选项字母（如 A. 192.168.10.1）时被误判为选项不匹配的问题',
      '修复长题干只发送前 300 字，多小问题目答成无意义值的问题',
    ],
  },
  {
    version: '1.0.1.0',
    features: [
      '批量答题：最多 5 题一批、两批并行，题图随题目上传',
      'DeepSeek 模型下拉：flash / chat / reasoner，reasoner 可查看思考过程',
      '答题记忆按模型区分；单题重问前先确认',
    ],
    fixes: [],
  },
];
