"""运营管理后台（HTML 自包含页面）。

- GET /admin 返回本页 HTML；页面内用原生 JS 调后端接口，不依赖任何前端构建。
- 覆盖全部「需管理员权限」的请求：登录拿 token、待开通凭证列表、核销/驳回、直接开通。
- 页面本身只是静态 HTML，所有写操作都经后端 require_admin 鉴权，无 token 什么都做不了。
"""


def render_admin_page() -> str:
    return """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>经营码核销后台</title>
<style>
  :root{
    --blue:#3B82F6; --blue-d:#2563EB; --ink:#0F172A; --muted:#64748B;
    --line:#E2E8F0; --bg:#F8FAFC; --card:#FFFFFF;
    --amber:#F59E0B; --green:#16A34A; --red:#DC2626; --gray:#94A3B8;
  }
  *{box-sizing:border-box; -webkit-tap-highlight-color:transparent}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background:var(--bg);color:var(--ink);font-size:14px;line-height:1.5}
  .wrap{max-width:760px;margin:0 auto;padding:20px 16px 48px}
  .topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
  .topbar h1{font-size:20px;font-weight:700;margin:0}
  .btn{border:0;border-radius:10px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;
    background:var(--blue);color:#fff;transition:.15s}
  .btn:hover{background:var(--blue-d)} .btn:disabled{opacity:.55;cursor:not-allowed}
  .btn.ghost{background:#fff;color:var(--ink);border:1px solid var(--line)}
  .btn.ok{background:var(--green)} .btn.no{background:#fff;color:var(--red);border:1px solid #FECACA}
  .btn.sm{padding:7px 12px;font-size:13px;border-radius:8px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:14px;
    box-shadow:0 4px 12px rgba(15,23,42,.06)}
  input,select{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;font-size:14px;
    background:#fff;color:var(--ink);outline:none}
  input:focus,select:focus{border-color:var(--blue)}
  label{display:block;font-size:12px;color:var(--muted);margin:0 0 6px}
  .row{display:flex;gap:10px;align-items:center}
  .tabs{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
  .tab{padding:8px 14px;border-radius:999px;border:1px solid var(--line);background:#fff;cursor:pointer;font-size:13px;color:var(--muted)}
  .tab.on{background:var(--blue);color:#fff;border-color:var(--blue)}
  .views{display:flex;gap:8px;margin-bottom:14px}
  .view{padding:8px 16px;border-radius:10px;border:1px solid var(--line);background:#fff;cursor:pointer;font-size:13px;color:var(--muted);font-weight:600}
  .view.on{background:var(--blue);color:#fff;border-color:var(--blue)}
  .badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600}
  .b-pending{background:#FEF3C7;color:#B45309}
  .b-approved{background:#DCFCE7;color:#15803D}
  .b-rejected{background:#F1F5F9;color:#64748B}
  .b-handled{background:#DCFCE7;color:#15803D}
  .item{display:flex;flex-direction:column;gap:8px}
  .item .meta{display:flex;flex-wrap:wrap;gap:10px 16px;font-size:13px;color:var(--muted)}
  .item .meta b{color:var(--ink);font-weight:600}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
  .acts{display:flex;gap:8px;margin-top:4px}
  .empty{text-align:center;color:var(--muted);padding:30px 0}
  .hint{font-size:12px;color:var(--muted);margin-top:6px;line-height:1.6}
  .err{color:var(--red);font-size:13px;margin-top:8px;min-height:16px}
  #login{max-width:360px;margin:12vh auto 0}
  .hidden{display:none}
</style>
</head>
<body>
<div class="wrap">

  <!-- 登录 -->
  <div id="login" class="card hidden">
    <h1 style="margin:0 0 16px">经营码核销后台</h1>
    <label>管理员账号</label>
    <input id="acc" placeholder="管理员账号" autocomplete="username" />
    <label style="margin-top:12px">密码</label>
    <input id="pwd" type="password" placeholder="密码" autocomplete="current-password" />
    <button id="loginBtn" class="btn" style="width:100%;margin-top:18px">登录</button>
    <div id="loginErr" class="err"></div>
  </div>

  <!-- 后台 -->
  <div id="dash" class="hidden">
    <div class="topbar">
      <h1>经营码核销后台</h1>
      <button id="logoutBtn" class="btn ghost sm">退出</button>
    </div>

    <div class="views" id="views">
      <span class="view on" data-v="proofs">凭证核销</span>
      <span class="view" data-v="feedback">用户反馈</span>
    </div>

    <div id="proofsView">
    <div class="tabs" id="tabs">
      <span class="tab on" data-s="pending">待核销</span>
      <span class="tab" data-s="approved">已通过</span>
      <span class="tab" data-s="rejected">已驳回</span>
      <span class="tab" data-s="all">全部</span>
    </div>

    <div id="list" class="card"></div>

    <div class="card">
      <h3 style="margin:0 0 12px;font-size:15px">直接开通（客户付了但没传凭证时）</h3>
      <label>subject（device:&lt;备注码&gt; 或 user:&lt;id&gt;）</label>
      <input id="gSubject" placeholder="device:abc123 或 user:xxxx" />
      <label style="margin-top:12px">方案</label>
      <select id="gPlan">
        <option value="monthly">月付</option>
        <option value="yearly">年付</option>
      </select>
      <button id="grantBtn" class="btn" style="width:100%;margin-top:16px">开通会员</button>
      <div id="grantErr" class="err"></div>
    </div>
    </div><!-- /proofsView -->

    <div id="feedbackView" class="hidden">
      <div class="card">
        <h3 style="margin:0 0 12px;font-size:15px">用户反馈</h3>
        <div id="feedbackList"></div>
      </div>
    </div>
  </div>

</div>

<script>
const API = location.origin + '/api/v1';
let TOKEN = localStorage.getItem('admin_token') || '';
let curFilter = 'pending';

async function api(path, opts){
  opts = opts || {};
  opts.headers = Object.assign({'Content-Type':'application/json'}, opts.headers || {});
  if (TOKEN) opts.headers['Authorization'] = 'Bearer ' + TOKEN;
  const res = await fetch(API + path, opts);
  let data = null;
  try { data = await res.json(); } catch(e){}
  return { ok: res.ok, status: res.status, data };
}

function fmtTime(s){
  if (!s) return '-';
  return s.replace('T',' ').replace('Z','').slice(0,16);
}
function esc(x){ return (x==null?'':String(x)).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function showDash(){ document.getElementById('login').classList.add('hidden'); document.getElementById('dash').classList.remove('hidden'); showView(curView); }
function showLogin(){ document.getElementById('dash').classList.add('hidden'); document.getElementById('login').classList.remove('hidden'); }

let curView = 'proofs';
function showView(v){
  curView = v;
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('on', x.dataset.v === v));
  document.getElementById('proofsView').classList.toggle('hidden', v !== 'proofs');
  document.getElementById('feedbackView').classList.toggle('hidden', v !== 'feedback');
  if (v === 'proofs') load(); else loadFeedback();
}

async function login(){
  const acc = document.getElementById('acc').value.trim();
  const pwd = document.getElementById('pwd').value;
  document.getElementById('loginErr').textContent = '';
  if (!acc || !pwd){ document.getElementById('loginErr').textContent = '请填写账号和密码'; return; }
  const r = await api('/auth/login', { method:'POST', body: JSON.stringify({ account:acc, password:pwd }) });
  if (r.ok && r.data && r.data.access_token){
    TOKEN = r.data.access_token; localStorage.setItem('admin_token', TOKEN); showDash();
  } else {
    document.getElementById('loginErr').textContent = '登录失败：' + (r.data && r.data.detail ? r.data.detail : r.status);
  }
}

function logout(){ TOKEN=''; localStorage.removeItem('admin_token'); showLogin(); }

async function load(){
  const q = (curFilter && curFilter !== 'all') ? '?status=' + curFilter : '';
  const r = await api('/billing/admin/proofs' + q);
  const box = document.getElementById('list');
  if (r.status === 401 || r.status === 403){
    box.innerHTML = '<div class="empty">登录已失效，请重新登录</div>'; logout(); return;
  }
  const items = (r.data && r.data.items) || [];
  if (!items.length){ box.innerHTML = '<div class="empty">暂无' + (curFilter==='all'?'凭证':curFilter==='pending'?'待核销':'记录') + '</div>'; return; }
  box.innerHTML = items.map(it => {
    const actions = it.status === 'pending'
      ? '<div class="acts"><button class="btn ok sm" data-act="approve" data-id="'+esc(it.id)+'">通过并开通</button>'
        + '<button class="btn no sm" data-act="reject" data-id="'+esc(it.id)+'">驳回</button></div>'
      : '';
    return '<div class="item" style="padding:14px 0;border-bottom:1px solid var(--line)">'
      + '<div class="meta"><b>时间</b> '+esc(fmtTime(it.created_at))+'</div>'
      + '<div class="meta"><b>主体</b> <span class="mono">'+esc(it.subject)+'</span></div>'
      + '<div class="meta"><b>方案</b> '+esc(it.plan)+' &nbsp; <b>金额</b> '+(it.amount!=null?'¥'+it.amount:'-')+'</div>'
      + '<div class="meta"><b>订单号/备注</b> <span class="mono">'+esc(it.proof_ref||'-')+'</span></div>'
      + '<div class="meta"><span class="badge b-'+esc(it.status)+'">'+esc(it.status)+'</span>'
        + (it.reviewer?' <b>核销人</b> '+esc(it.reviewer):'')+'</div>'
      + actions
      + '</div>';
  }).join('');
}

async function act(id, action){
  const r = await api('/billing/admin/proofs/' + id + '/' + action, { method:'POST' });
  if (r.ok){ load(); }
  else { alert((action==='approve'?'通过':'驳回')+'失败：' + (r.data && r.data.detail ? r.data.detail : r.status)); }
}

async function loadFeedback(){
  const r = await api('/feedback/admin/feedbacks');
  const box = document.getElementById('feedbackList');
  if (r.status === 401 || r.status === 403){
    box.innerHTML = '<div class="empty">登录已失效，请重新登录</div>'; logout(); return;
  }
  const items = (r.data && r.data.items) || [];
  if (!items.length){ box.innerHTML = '<div class="empty">暂无反馈</div>'; return; }
  box.innerHTML = items.map(it => {
    const actions = it.status === 'pending'
      ? '<div class="acts"><button class="btn ok sm" data-fb="'+esc(it.id)+'">标记已处理</button></div>'
      : '';
    return '<div class="item" style="padding:14px 0;border-bottom:1px solid var(--line)">'
      + '<div class="meta"><b>时间</b> '+esc(fmtTime(it.created_at))+'</div>'
      + '<div class="meta"><b>主体</b> <span class="mono">'+esc(it.subject)+'</span></div>'
      + (it.contact ? '<div class="meta"><b>联系方式</b> '+esc(it.contact)+'</div>' : '')
      + '<div style="white-space:pre-wrap;font-size:14px;color:var(--ink);line-height:1.6;margin:4px 0">'+esc(it.content)+'</div>'
      + '<div class="meta"><span class="badge b-'+esc(it.status)+'">'+esc(it.status==='pending'?'待处理':'已处理')+'</span>'
        + (it.handler ? ' <b>处理人</b> '+esc(it.handler) : '')+'</div>'
      + actions
      + '</div>';
  }).join('');
}

async function handleFeedback(id){
  const r = await api('/feedback/admin/feedbacks/' + id + '/handle', { method:'POST' });
  if (r.ok){ loadFeedback(); }
  else { alert('处理失败：' + (r.data && r.data.detail ? r.data.detail : r.status)); }
}

async function grant(){
  const subject = document.getElementById('gSubject').value.trim();
  const plan = document.getElementById('gPlan').value;
  const err = document.getElementById('grantErr');
  err.textContent = '';
  if (!subject){ err.textContent = '请填写 subject（device:<备注码> 或 user:<id>）'; return; }
  const r = await api('/billing/admin/grant', { method:'POST', body: JSON.stringify({ subject, plan }) });
  if (r.ok){ err.style.color = 'var(--green)'; err.textContent = '已开通：' + subject; document.getElementById('gSubject').value=''; load(); }
  else { err.style.color = 'var(--red)'; err.textContent = '开通失败：' + (r.data && r.data.detail ? r.data.detail : r.status); }
}

// 事件
document.getElementById('loginBtn').addEventListener('click', login);
document.getElementById('pwd').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
document.getElementById('logoutBtn').addEventListener('click', logout);
document.getElementById('grantBtn').addEventListener('click', grant);
document.getElementById('views').addEventListener('click', e => {
  const v = e.target.closest('.view'); if (!v) return;
  showView(v.dataset.v);
});
document.getElementById('feedbackList').addEventListener('click', e => {
  const b = e.target.closest('button[data-fb]'); if (!b) return;
  if (!confirm('确认标记为已处理？')) return;
  handleFeedback(b.dataset.fb);
});
document.getElementById('tabs').addEventListener('click', e => {
  const t = e.target.closest('.tab'); if (!t) return;
  document.querySelectorAll('#tabs .tab').forEach(x => x.classList.remove('on'));
  t.classList.add('on'); curFilter = t.dataset.s; load();
});
document.getElementById('list').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  if (!confirm(b.dataset.act === 'approve' ? '确认通过该凭证并开通会员？' : '确认驳回该凭证？')) return;
  act(b.dataset.id, b.dataset.act);
});

// 启动
if (TOKEN){ showDash(); } else { showLogin(); }
</script>
</body>
</html>
"""
