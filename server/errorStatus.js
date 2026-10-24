// 引擎错误 → HTTP 状态码。
//
// 这是**路由层**的映射（引擎本身不知道 HTTP 的存在）。抽成独立模块的
// 唯一理由是**可测**：每一条映射都有一条测试钉住 —— 否则以后有人往表里
// 加一行、忘了配测试，客户端就会收到一个说不清的 500。
//
//   400 客户端错（请求本身不对）
//   500 我们的配置错（不是用户的错，也不是模型的问题）
//   502 模型侧错（网关挂了、返回了坏响应）
//
// **这张表的定位**：它是「引擎错误码 → HTTP 状态」的**公共契约**，
// 不是「当前这条链路的错误码表」。
//
//   - `/api/chat` 只用到其中**一部分**：它在调引擎之前就把
//     structured_output / history 的非法情形挡掉了（那些错误码走不到），
//     网关侧的错又都被 modelClient 包成 ModelError（→ 502 的另一条路）。
//   - 其余条目是**给第二个调用方预留**的：server/delivery/* 的 BFF 路由
//     与将来的游民纪元小程序 BFF 都会整表用上 —— 它们直接调引擎，
//     引擎的错误会**原样**冒上来，那时就必须有一张完整的映射表。
//
// 所以：表里的条目不要因为「/api/chat 走不到」就删掉 —— 那是把契约砍掉。
//
// 注意：'empty_reply' **不在这张表里** —— 它不是失败，走的是特判分支
// （模型只交付了结构化块 → 回 200，照常落库记账）。把它列进表里会误导
// 读者以为 empty_reply 映射到 502。
export const ENGINE_ERROR_STATUS = {
  // 请求本身不合法：structured_output 不是字符串 / 是空串。
  // 当前路由在调引擎**之前**就用白名单挡掉了（400），所以这条是**第二道
  // 防线** —— 引擎被别的调用方直接用时才会走到。
  invalid_structured_output: 400,
  // 未知的结构化输出类型。同样被路由的白名单挡在前面。
  unknown_structured_output: 400,
  // history 不是消息数组。路由已经保证了 messages 是数组（否则 400），
  // 所以从 /api/chat 走不到这里。
  invalid_history: 400,
  // 引擎构造参数不对（编程错误）。构造发生在模块加载时 —— 真出错了
  // 进程根本起不来，不会有请求跑到这里。
  invalid_config: 500,
  // schemas 里的 schema / notes 写坏了（配置错）。
  // 当前注入的 schemas 来自 server/structuredTypes.js（模块级常量），
  // 写坏的话是编程错误；从别的调用方注入坏 schema 时才会走到。
  invalid_schema: 500,
  // 模型没返回任何内容。
  // 当前**到不了**：modelClient 拿到空内容时先抛 ModelError（→ 502），
  // 引擎这段检查只在注入别的 callModel 时才会命中。
  empty_content: 502,
  // 模型返回的内容不是字符串。
  // **这条是可达的**：modelClient 不做类型强制 ——
  // `data?.choices?.[0]?.message?.content || ''` 里的 `|| ''` 只挡**假值**，
  // 真值非字符串（网关返回 content: 123 或一个对象）会原样穿过 modelClient，
  // 于是引擎抛的就是这个 code。映射到 502 是对的（是模型侧返回了坏东西）。
  invalid_content_type: 502,
};

// 一个错误该回什么状态码。
//
// 输入是「引擎抛出来的那个错」：CbtEngineError（带 code）、网关的
// ModelError（带 name）、或者任何别的东西（→ 500）。
export function statusForEngineError(error) {
  if (!error || typeof error !== 'object') return 500;
  // 网关错（ModelError）→ 502：不是我们的问题，也别报成 500。
  // 用 name 判而不是 instanceof：跨模块边界时同一个类可能是不同的
  // 构造函数实例（也便于测试里造一个同形的错）。
  if (error.name === 'ModelError') return 502;
  const code = typeof error.code === 'string' ? error.code : null;
  return (code && ENGINE_ERROR_STATUS[code]) || 500;
}

// 状态码 → 给客户端的文案。
//
// 500 / 502 **不带** error.message —— 那是内部细节（堆栈、SQL、路径、
// 网关返回的原始报文），对客户端没有意义。排障看服务端日志。
// 400 可以带：那是请求本身的问题，说清楚对调用方有用。
export function errorBodyForStatus(status, error) {
  if (status === 400) {
    return { error: (error && error.message) || 'Bad request' };
  }
  if (status === 502) {
    return { error: 'AI Gateway error' };
  }
  return { error: 'Internal server error' };
}
