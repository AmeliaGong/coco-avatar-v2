import { useState, useEffect } from 'react';
import { adminGetStats } from '../../lib/api';

interface DailyStat {
  date: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  requests: number;
}

interface Stats {
  totals: {
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_tokens: number;
    total_requests: number;
  };
  daily: DailyStat[];
  conversation_count: number;
}

// claude-sonnet-4.6: $3/1M prompt, $15/1M completion
function calcCost(promptTokens: number, completionTokens: number): number {
  return (promptTokens * 3 + completionTokens * 15) / 1_000_000;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function AdminStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminGetStats()
      .then(setStats)
      .catch(e => {
        if ((e as Error).message === 'Unauthorized') {
          sessionStorage.removeItem('admin_token');
          window.location.reload();
        }
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-gray-400">加载中...</p>;
  if (!stats) return <p className="text-gray-400">无法加载统计</p>;

  const maxDailyTokens = Math.max(...stats.daily.map(d => d.total_tokens), 1);
  const totalCost = calcCost(stats.totals.total_prompt_tokens, stats.totals.total_completion_tokens);

  return (
    <div>
      <h2 className="text-lg font-bold text-gray-800 mb-4">统计面板</h2>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="对话总数" value={stats.conversation_count} />
        <StatCard label="请求总数" value={stats.totals.total_requests} />
        <StatCard label="Token 总消耗" value={stats.totals.total_tokens.toLocaleString()} />
        <StatCard label="预估费用 (USD)" value={formatCost(totalCost)} highlight />
      </div>

      <div className="bg-white rounded-xl shadow border border-warm-grey/20 p-4 mb-4">
        <div className="text-xs text-gray-400 mb-1">费用明细</div>
        <div className="text-sm text-gray-600">
          Prompt {stats.totals.total_prompt_tokens.toLocaleString()} tokens × $3/1M
          &nbsp;+&nbsp;
          Completion {stats.totals.total_completion_tokens.toLocaleString()} tokens × $15/1M
          &nbsp;=&nbsp;
          <span className="font-semibold text-gray-800">{formatCost(totalCost)}</span>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow border border-warm-grey/20 p-4">
        <h3 className="font-bold text-gray-700 mb-3 text-sm">每日 Token 消耗（近 30 天）</h3>
        {stats.daily.length === 0 ? (
          <p className="text-gray-400 text-sm">暂无数据</p>
        ) : (
          <div className="space-y-2">
            {stats.daily.map(d => {
              const dayCost = calcCost(d.prompt_tokens, d.completion_tokens);
              return (
                <div key={d.date} className="flex items-center gap-3 text-sm">
                  <span className="w-24 text-gray-500 shrink-0">{d.date}</span>
                  <div className="flex-1 bg-gray-100 rounded-full h-5 overflow-hidden">
                    <div className="flex h-full">
                      <div
                        className="bg-blue-400 h-full"
                        style={{ width: `${(d.prompt_tokens / maxDailyTokens) * 100}%` }}
                        title={`Prompt: ${d.prompt_tokens}`}
                      />
                      <div
                        className="bg-green-400 h-full"
                        style={{ width: `${(d.completion_tokens / maxDailyTokens) * 100}%` }}
                        title={`Completion: ${d.completion_tokens}`}
                      />
                    </div>
                  </div>
                  <span className="w-20 text-right text-gray-600 shrink-0">
                    {d.total_tokens.toLocaleString()}
                  </span>
                  <span className="w-16 text-right text-amber-600 shrink-0 font-medium">
                    {formatCost(dayCost)}
                  </span>
                  <span className="w-12 text-right text-gray-400 shrink-0 text-xs">
                    {d.requests} req
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <div className="flex gap-4 mt-3 text-xs text-gray-400">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 bg-blue-400 rounded-sm inline-block" /> Prompt
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 bg-green-400 rounded-sm inline-block" /> Completion
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 bg-amber-400 rounded-sm inline-block" /> 费用 (claude-sonnet-4.6)
          </span>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className={`rounded-xl shadow border p-4 ${highlight ? 'bg-soft-apricot/30 border-warm-grey/40' : 'bg-white border-warm-grey/20'}`}>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-xl font-bold ${highlight ? 'text-olive-green' : 'text-gray-800'}`}>{value}</div>
    </div>
  );
}
