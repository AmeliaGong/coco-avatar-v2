#!/bin/bash
# Coco Avatar 部署后验证 —— 交付线发布用
# 用法: bash /tmp/verify-release.sh
#
# 判别式（不要只看状态码）:
#   GET /api/internal/ping  部署前 = 200 + text/html（被 SPA catch-all 吃掉）
#                          部署后 = 401 + application/json（真路由）
# 库只做 SELECT COUNT(*) / PRAGMA table_info，不读任何会话正文。
set -uo pipefail

export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897
APP=coco-avatar-icy-sun-5917
URL=https://coco-avatar-icy-sun-5917.fly.dev
WORKDIR=/Users/cocogong/coco-startup/coco-avatar-main

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass+1)); }
bad() { echo "  ❌ $1"; fail=$((fail+1)); }

# ---------- 机器 ----------
echo "=== 1. 机器状态 ==="
flyctl machine list --app $APP --json > /tmp/machines.json 2>/dev/null
read -r MACHINE STATE <<<"$(node -e '
  const m=JSON.parse(require("fs").readFileSync("/tmp/machines.json","utf8"));
  const x=m.find(v=>v.state==="started")||m[0]||{};
  console.log(x.id||"NONE", x.state||"NONE");
')"
IMAGE=$(flyctl status --app $APP 2>/dev/null | grep -i 'Image' | sed 's/.*coco-avatar-icy-sun-5917://; s/[^a-zA-Z0-9-]//g')
echo "  machine=$MACHINE state=$STATE image=$IMAGE"
[ "$STATE" = "started" ] && ok "机器是 started" || bad "机器状态=$STATE"
[ -n "$IMAGE" ] && ok "镜像 $IMAGE" || bad "读不到镜像号"

# ---------- HTTP ----------
echo "=== 2. HTTP 探针 ==="
code()  { curl -sS -m 30 -o /dev/null -w '%{http_code}' "$@"; }
ctype() { curl -sS -m 30 -o /dev/null -w '%{content_type}' "$@"; }

c=$(code "$URL/"); t=$(ctype "$URL/")
[ "$c" = "200" ] && ok "GET / → 200 ($t)" || bad "GET / → $c"
case "$t" in text/html*) ok "GET / 返回 HTML";; *) bad "GET / 返回 ${t}，不是 HTML";; esac

c=$(code "$URL/api/internal/ping"); t=$(ctype "$URL/api/internal/ping")
[ "$c" = "401" ] && ok "ping 无 token → 401" || bad "ping 无 token → ${c}（期望 401）"
case "$t" in application/json*) ok "ping 返回 JSON（真路由，不是 SPA 兜底）";; *) bad "ping 返回 $t —— 还是 SPA catch-all？";; esac

if [ -f "$WORKDIR/.internal-token" ]; then
  TOK=$(cat "$WORKDIR/.internal-token")
  c=$(code -H "Authorization: Bearer $TOK" "$URL/api/internal/ping")
  [ "$c" = "200" ] && ok "ping 带正确 Bearer → 200" || bad "ping 带正确 Bearer → $c"
  c=$(code -H "Authorization: Bearer wrong-not-real" "$URL/api/internal/ping")
  [ "$c" = "401" ] && ok "ping 带错误 Bearer → 401（没 fail-open）" || bad "ping 带错误 Bearer → $c"
  unset TOK
else
  bad "找不到 $WORKDIR/.internal-token，无法测 Bearer"
fi

echo "=== 3. 业务端点冒烟 ==="
c=$(code -m 120 -X POST "$URL/api/chat" -H 'Content-Type: application/json' \
    -d '{"messages":[{"role":"user","content":"ping"}]}')
[ "$c" = "200" ] && ok "POST /api/chat → 200" || bad "POST /api/chat → $c"

# ---------- 库结构 ----------
echo "=== 4. 库结构与计数（只读 COUNT / PRAGMA） ==="
cat > /tmp/schema-probe.js <<'JS'
const D = require('/app/node_modules/better-sqlite3');
const db = new D('/data/coco.db', { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
const cnt = x => { try { return db.prepare('SELECT COUNT(*) c FROM ' + x).get().c; } catch (e) { return 'MISSING'; } };
const cols = x => { try { return db.prepare('PRAGMA table_info(' + x + ')').all().map(r => r.name); } catch (e) { return ['MISSING']; } };
const out = { tables };
for (const x of ['conversations','messages','token_usage','knowledge_entries','prompt_scenarios',
                 'clients','stuck_points','sessions_1v1','plans','practices','evidences','coach_moves','journeys']) {
  out['c_' + x] = cnt(x);
}
out.col_conversations = cols('conversations');
out.col_messages = cols('messages');
out.col_token_usage = cols('token_usage');
console.log(JSON.stringify(out));
JS
B64=$(base64 < /tmp/schema-probe.js | tr -d '\n')
CMD="node -e \"eval(Buffer.from('$B64','base64').toString())\""
flyctl machine exec "$MACHINE" --app $APP "$CMD" 2>/dev/null | tail -1 > /tmp/release-schema.json
if [ -s /tmp/release-schema.json ]; then
  node -e '
    const d=JSON.parse(require("fs").readFileSync("/tmp/release-schema.json","utf8"));
    const tables=d.tables||[];
    for(const t of ["conversations","messages","token_usage","knowledge_entries","prompt_scenarios"]){
      tables.includes(t)?console.log("  ✅ 表 "+t+" 存在"):console.log("  ❌ 缺表 "+t);
    }
    console.log("  --- 交付线表 ---");
    const dl=["clients","stuck_points","sessions_1v1","plans","practices","evidences","coach_moves","journeys"];
    let any=false;
    for(const t of dl){ if(tables.includes(t)){any=true; console.log("  ✅ "+t+"  count="+d["c_"+t]);} }
    if(!any) console.log("  (交付线表尚未出现 —— 底座单独发布时的正常状态)");
    console.log("  --- 计数 ---");
    for(const k of ["c_conversations","c_messages","c_token_usage","c_knowledge_entries","c_prompt_scenarios"])
      console.log("  "+k+" = "+d[k]);
    console.log("  --- 列 ---");
    console.log("  conversations: "+(d.col_conversations||[]).join(","));
    console.log("  messages: "+(d.col_messages||[]).join(","));
    console.log("  token_usage: "+(d.col_token_usage||[]).join(","));
    const cc=d.col_conversations||[], mm=d.col_messages||[], tu=d.col_token_usage||[];
    for(const col of ["client_id","scenario","link_kind"]) cc.includes(col)?console.log("  ✅ conversations."+col):console.log("  ❌ conversations 缺 "+col);
    mm.includes("structured_json")?console.log("  ✅ messages.structured_json"):console.log("  ❌ messages 缺 structured_json");
    for(const col of ["scenario","prompt_version"]) tu.includes(col)?console.log("  ✅ token_usage."+col):console.log("  ❌ token_usage 缺 "+col);
  '
else
  bad "读不到库结构"
fi

# ---------- 日志 ----------
echo "=== 5. 启动日志（找 crash loop / 未捕获异常） ==="
LOGS=$(flyctl logs --app $APP --no-tail 2>/dev/null | tail -60)
if echo "$LOGS" | grep -qiE "unhandledRejection|uncaughtException|MODULE_NOT_FOUND|SqliteError|SyntaxError|TypeError"; then
  echo "$LOGS" | grep -iE "unhandledRejection|uncaughtException|MODULE_NOT_FOUND|SqliteError|SyntaxError|TypeError" | tail -10
  bad "日志里有错误（见上）"
else
  ok "启动日志无异常关键字"
fi
echo "$LOGS" | grep -q "Server running on" && ok "Server running on ..." || bad "没看到 'Server running on'"

echo
echo "=== 结果：$pass 通过 / $fail 失败 ==="
[ $fail -eq 0 ] && echo "可以放行。" || echo "先查失败项，别放行。"
