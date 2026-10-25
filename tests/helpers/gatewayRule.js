// 一个**按网关规则行事**的假 fetch。
//
// 为什么需要它：别的测试里的假 fetch 对**任何**请求都回 200 —— 于是
// 「请求体形状不对」这一类 bug 在测试里是**看不见**的（生产上网关会拒）。
//
// 这个坑已经踩过一次：`{"messages":[]}` 在**生产**上是 502（网关回
// 2013，modelClient 把它包成 ModelError），而当时的测试钉的是 200 ——
// 一个把虚构当事实的断言。假 fetch 给什么都回 200，测试就成了自说自话。
//
// 这个假 fetch 按 MiniMax 网关的真实规则回：
//   - 请求里没有任何「非 system 的非空消息」→ 200 + base_resp{status_code:2013}
//     （老接口的形状：业务错误裹在 HTTP 200 里，choices 是空的）
//   - 否则 → 200 + 正常内容
//
// 注意它**不会**替我们把关：请求该被谁挡、挡在哪一层，仍然由被测代码决定。
// 这里只是让「网关会拒」这件事在测试里**可观测**。
export function createGatewayRuleFetch({ content = '好的。' } = {}) {
  const calls = [];

  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);

    // 网关的规则：至少要有一条非 system 的、content 非空的消息。
    const hasContent =
      Array.isArray(body.messages) &&
      body.messages.some(
        m =>
          m &&
          m.role !== 'system' &&
          typeof m.content === 'string' &&
          m.content.trim() !== ''
      );

    if (!hasContent) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            base_resp: {
              status_code: 2013,
              status_msg: 'invalid params, chat content is empty',
            },
            choices: [],
          };
        },
        async text() {
          return '';
        },
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        };
      },
      async text() {
        return '';
      },
    };
  };

  return { fetchImpl, calls };
}
