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
// 这条规则是**线上验过**的（2026-10-24 直接打网关）：
//   - 只有 system 的请求 → 2013 chat content is empty；
//   - 只有 assistant 的请求 → **200，被接受**（所以本平台没有把
//     「最后一条必须是 user」当成规则 —— 那只是 MiniMax 文档里写的
//     另一种接口的约束）。
//
// ⚠️ 但**本平台自己的判据比这个假 fetch 严**：usableMessages 只认
// user/assistant，role 是 tool/developer 的消息在**离开本平台之前**就被剔掉了。
//
// 而 **role 这一维上，网关的态度我们没有验过**（验过的只有两档：只有
// system ⇒ 2013；只有 assistant ⇒ 200 被接受）。MiniMax 文档说 tool/developer
// 会回 2013 `invalid role`，但那是另一种接口的约束 —— 不能当成实测结论。
// 所以：
//   - 本平台**从严**（只认 user/assistant），这个选择不依赖网关的未验行为；
//   - 这个假 fetch 的 role 维度是**宽松**的 ⇒ 它**不会**替我们抓「发出去
//     才发现网关不认 tool」这一类回归。要抓那个，靠的是**边界断言**：
//     发出去的请求体里只允许出现 system/user/assistant 三种 role
//     （见 tests/api.chat.test.js「tool / developer 消息被剔掉」那条）。
//
// 写测试时别把两件事混成一句话（曾经混过：测试名说「网关会回 2013」，
// 实际那个 400 是本平台自己给的）。
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
