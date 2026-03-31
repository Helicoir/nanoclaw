import http from 'node:http';
import { execSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = parseInt(process.env.MONITOR_PORT ?? '3737');

const DB_PATH = join(ROOT, 'store/messages.db');
const LOG_PATH = join(ROOT, 'logs/nanoclaw.log');
const ERR_LOG_PATH = join(ROOT, 'logs/nanoclaw.error.log');
const STUCK_MIN = 10;

type Row = Record<string, unknown>;

function dbQuery<T extends Row>(sql: string): T[] {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

function minutesAgo(ts: string | null | undefined): number {
  if (!ts) return Infinity;
  return (Date.now() - new Date(ts).getTime()) / 60000;
}

function fmtAgo(ts: string | null | undefined): string {
  const m = minutesAgo(ts);
  if (!isFinite(m)) return '—';
  if (m < 1) return 'たった今';
  if (m < 60) return `${Math.floor(m)}分前`;
  if (m < 1440) return `${Math.floor(m / 60)}時間${Math.floor(m % 60)}分前`;
  return `${Math.floor(m / 1440)}日前`;
}

function fmtTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tailFile(path: string, n: number): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

function getContainers(): string[] {
  try {
    return execSync(
      'docker ps --filter "name=nanoclaw" --format "{{.Names}}\t{{.Status}}"',
      {
        encoding: 'utf8',
        timeout: 3000,
      },
    )
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getServiceStatus(): string {
  try {
    const out = execSync('launchctl list com.nanoclaw 2>/dev/null', {
      encoding: 'utf8',
    });
    const pid = out.match(/"PID"\s*=\s*(\d+)/)?.[1];
    return pid ? `稼働中 (PID ${pid})` : '停止中';
  } catch {
    return '停止中';
  }
}

function renderDashboard(): string {
  const groups = dbQuery<{
    jid: string;
    name: string;
    is_main: number;
    last_user_msg: string;
    last_bot_msg: string;
    pending_count: number;
  }>(`
    SELECT rg.jid, rg.name, rg.is_main,
      (SELECT MAX(m.timestamp) FROM messages m WHERE m.chat_jid = rg.jid AND m.is_bot_message = 0) as last_user_msg,
      (SELECT MAX(m.timestamp) FROM messages m WHERE m.chat_jid = rg.jid AND m.is_bot_message = 1) as last_bot_msg,
      (SELECT COUNT(*) FROM messages m WHERE m.chat_jid = rg.jid AND m.is_bot_message = 0
        AND m.timestamp > COALESCE(
          (SELECT MAX(m2.timestamp) FROM messages m2 WHERE m2.chat_jid = rg.jid AND m2.is_bot_message = 1),
          '1970-01-01'
        )
      ) as pending_count
    FROM registered_groups rg
  `);

  const msgs = dbQuery<{
    timestamp: string;
    sender_name: string;
    sender: string;
    content: string;
    is_bot_message: number;
    chat_name: string;
  }>(`
    SELECT m.timestamp, m.sender_name, m.sender, m.content, m.is_bot_message, c.name as chat_name
    FROM messages m JOIN chats c ON m.chat_jid = c.jid
    ORDER BY m.timestamp DESC LIMIT 20
  `);

  const tasks = dbQuery<{
    group_folder: string;
    schedule_type: string;
    schedule_value: string;
    next_run: string;
    minutes_overdue: number;
  }>(`
    SELECT group_folder, schedule_type, schedule_value, next_run,
      CAST((julianday('now') - julianday(next_run)) * 1440 AS INTEGER) as minutes_overdue
    FROM scheduled_tasks WHERE status = 'active' ORDER BY next_run LIMIT 10
  `);

  const ctrs = getContainers();
  const svc = getServiceStatus();
  const svcOk = svc.startsWith('稼働中');
  const logs = tailFile(LOG_PATH, 20).map(stripAnsi);
  const errLogs = tailFile(ERR_LOG_PATH, 15).map(stripAnsi);

  const stuckGroups = groups.filter(
    (g) => g.pending_count > 0 && minutesAgo(g.last_user_msg) > STUCK_MIN,
  );
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  const logRows = logs
    .map((l) => {
      const cls = l.includes('ERROR') ? 'e' : l.includes('WARN') ? 'w' : 'i';
      return `<div class="ll ${cls}">${esc(l)}</div>`;
    })
    .join('');

  const errRows =
    errLogs.length === 0
      ? '<div class="muted">エラーなし</div>'
      : errLogs.map((l) => `<div class="ll e">${esc(l)}</div>`).join('');

  const groupRows = groups
    .map((g) => {
      const stuck =
        g.pending_count > 0 && minutesAgo(g.last_user_msg) > STUCK_MIN;
      return `<tr>
  <td>${esc(g.name)}${g.is_main ? ' <span class="badge b-muted">main</span>' : ''}</td>
  <td class="${stuck ? 'err' : 'muted'}">${fmtAgo(g.last_user_msg)}</td>
  <td class="muted">${fmtAgo(g.last_bot_msg)}</td>
  <td>${g.pending_count > 0 ? `<span class="badge b-warn">${g.pending_count}</span>` : '<span class="muted">—</span>'}</td>
</tr>`;
    })
    .join('');

  const ctrRows =
    ctrs.length === 0
      ? '<div class="muted">実行中なし</div>'
      : `<table><tr><th>名前</th><th>状態</th></tr>${ctrs
          .map((c) => {
            const tab = c.indexOf('\t');
            const name = tab >= 0 ? c.slice(0, tab) : c;
            const status = tab >= 0 ? c.slice(tab + 1) : '';
            return `<tr><td class="ctr">${esc(name.replace('nanoclaw-', ''))}</td><td><span class="badge b-ok">${esc(status)}</span></td></tr>`;
          })
          .join('')}</table>`;

  const msgRows = msgs
    .slice(0, 15)
    .map(
      (m) => `<tr>
  <td class="muted">${fmtTime(m.timestamp)}</td>
  <td class="muted">${esc(m.chat_name)}</td>
  <td class="${m.is_bot_message ? 'msg-bot' : 'msg-user'}">${m.is_bot_message ? 'Bot' : esc(m.sender_name || m.sender)}</td>
  <td class="trunc">${esc((m.content ?? '').substring(0, 100))}</td>
</tr>`,
    )
    .join('');

  const taskRows =
    tasks.length === 0
      ? ''
      : `<div class="card fw">
<h2>スケジュールタスク</h2>
<table>
<tr><th>グループ</th><th>種別</th><th>スケジュール</th><th>次回実行</th><th>状態</th></tr>
${tasks
  .map((t) => {
    const late = t.minutes_overdue > 0;
    return `<tr>
  <td>${esc(t.group_folder)}</td>
  <td>${esc(t.schedule_type)}</td>
  <td class="muted">${esc(t.schedule_value)}</td>
  <td class="${late ? 'warn' : 'muted'}">${fmtTime(t.next_run)}</td>
  <td>${late ? `<span class="badge b-warn">${t.minutes_overdue}分遅延</span>` : '<span class="badge b-ok">正常</span>'}</td>
</tr>`;
  })
  .join('')}
</table>
</div>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="10">
<title>NanoClaw Monitor</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Menlo,Monaco,monospace;background:#0d1117;color:#e6edf3;font-size:13px;padding:16px}
h1{color:#58a6ff;font-size:18px;margin-bottom:3px}
.sub{color:#8b949e;font-size:11px;margin-bottom:14px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px}
.card h2{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}
table{width:100%;border-collapse:collapse}
td,th{padding:4px 8px;border-bottom:1px solid #21262d;text-align:left}
th{color:#8b949e;font-weight:normal;font-size:11px}
.ok{color:#3fb950}.warn{color:#d29922}.err{color:#f85149}.muted{color:#8b949e}
.badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px}
.b-ok{background:#1f4a23;color:#3fb950}
.b-warn{background:#3d2f00;color:#d29922}
.b-err{background:#4a1f1f;color:#f85149}
.b-muted{background:#1c2128;color:#8b949e}
.alert{background:#4a1f1f;border:1px solid #f85149;border-radius:6px;padding:10px 14px;margin-bottom:12px;color:#f85149;font-weight:bold}
.good{background:#1f4a23;border:1px solid #3fb950;border-radius:6px;padding:8px 14px;margin-bottom:12px;color:#3fb950}
.logbox{background:#0d1117;border-radius:4px;padding:8px;font-size:11px;max-height:180px;overflow-y:auto}
.ll{white-space:pre-wrap;word-break:break-all;padding:1px 0}
.ll.e{color:#f85149}.ll.w{color:#d29922}.ll.i{color:#8b949e}
.fw{grid-column:1/-1}
.ctr{font-size:11px}
.msg-user{color:#79c0ff}.msg-bot{color:#56d364}
.trunc{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style>
</head>
<body>
<h1>NanoClaw Monitor</h1>
<div class="sub">
  最終更新: ${now} — 10秒ごとに自動更新 |
  サービス: <span class="${svcOk ? 'ok' : 'err'}">${svc}</span>
</div>

${stuckGroups.length > 0 ? `<div class="alert">&#9888; 応答詰まり検出: ${stuckGroups.map((g) => `${esc(g.name)} (${fmtAgo(g.last_user_msg)}未返答)`).join('、')}</div>` : '<div class="good">&#10003; 全グループ正常動作中</div>'}

<div class="grid">

<div class="card">
<h2>グループ状態</h2>
<table>
<tr><th>グループ</th><th>最終ユーザー</th><th>最終返答</th><th>未処理</th></tr>
${groupRows}
</table>
</div>

<div class="card">
<h2>コンテナ (${ctrs.length})</h2>
${ctrRows}
</div>

<div class="card fw">
<h2>最近のメッセージ</h2>
<table>
<tr><th>時刻</th><th>グループ</th><th>送信者</th><th>内容</th></tr>
${msgRows}
</table>
</div>

<div class="card">
<h2>最近のログ</h2>
<div class="logbox">${logRows}</div>
</div>

<div class="card">
<h2>エラーログ</h2>
<div class="logbox">${errRows}</div>
</div>

${taskRows}

</div>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  try {
    const html = renderDashboard();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Monitor error: ${err}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`NanoClaw Monitor: http://localhost:${PORT}`);
});
