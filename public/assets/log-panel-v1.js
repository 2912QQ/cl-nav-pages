// 后台「日志」面板：查看谁、什么时间、什么 IP、做了什么修改
const $tok = () => localStorage.getItem('token');

async function api(method, qs = '') {
  const r = await fetch('/api/logs' + qs, { method, cache: 'no-store', headers: { Authorization: 'Bearer ' + $tok() } });
  let d = null; try { d = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((d && (d.error || d.message)) || '请求失败（HTTP ' + r.status + '）');
  return d;
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 北京时间
const fmt = ts => new Date(ts + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

const CSS = `
.lgp-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:12px}
.lgp{background:#fff;color:#222;border-radius:12px;width:min(1000px,100%);max-height:92vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.25);font-size:14px;line-height:1.5}
.lgp-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #eee}
.lgp-hd b{font-size:17px}.lgp-x{cursor:pointer;font-size:22px;line-height:1;border:0;background:none;color:#888}
.lgp-tb{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 18px}
.lgp-tb input{border:1px solid #d5d9e0;border-radius:6px;padding:7px 9px;font-size:14px;color:#222;background:#fff;min-width:0;flex:1;max-width:320px;box-sizing:border-box}
.lgp-b{border:1px solid #2566d8;background:#2566d8;color:#fff;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:14px;white-space:nowrap}
.lgp-b.o{background:#fff;color:#2566d8}.lgp-b.r{border-color:#d93025;color:#d93025;background:#fff}.lgp-b:disabled{opacity:.5;cursor:default}
.lgp-bd{padding:0 18px 8px;overflow:auto;flex:1}
.lgp table{width:100%;border-collapse:collapse;font-size:13px}
.lgp th,.lgp td{padding:7px 6px;border-bottom:1px solid #f0f0f0;text-align:left;vertical-align:top}
.lgp th{position:sticky;top:0;background:#f6f8fb;color:#555;font-weight:600;white-space:nowrap}
.lgp td.t,.lgp td.i{white-space:nowrap}.lgp td.d{word-break:break-all;color:#444;min-width:200px}
.lgp .bad{color:#d93025}.lgp .empty{text-align:center;color:#999;padding:30px 0}
.lgp-ft{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:10px 18px;border-top:1px solid #eee;font-size:13px;color:#666}
.lgp-msg{margin:0 18px 6px;padding:8px 10px;border-radius:6px;font-size:13px;background:#fce8e6}
`;

export async function openLogs() {
  if (document.querySelector('.lgp-mask')) return;
  if (!document.getElementById('lgp-css')) {
    const st = document.createElement('style'); st.id = 'lgp-css'; st.textContent = CSS; document.head.appendChild(st);
  }
  const mask = document.createElement('div');
  mask.className = 'lgp-mask';
  mask.innerHTML = `<div class="lgp">
    <div class="lgp-hd"><b>操作日志</b><button class="lgp-x" data-a="close" title="关闭">×</button></div>
    <div class="lgp-tb">
      <input type="text" id="lg-q" placeholder="搜索用户 / IP / 操作 / 详情" maxlength="60">
      <button class="lgp-b" data-a="search">搜索</button>
      <button class="lgp-b o" data-a="refresh">刷新</button>
      <button class="lgp-b r" data-a="clear" style="margin-left:auto">清空日志</button>
    </div>
    <div id="lg-msg"></div>
    <div class="lgp-bd"><table><thead><tr><th>时间（北京时间）</th><th>用户</th><th>IP</th><th>操作</th><th>详情</th></tr></thead><tbody id="lg-body"><tr><td colspan="5" class="empty">加载中…</td></tr></tbody></table></div>
    <div class="lgp-ft"><span id="lg-info"></span><span><button class="lgp-b o" data-a="prev">上一页</button> <button class="lgp-b o" data-a="next">下一页</button></span></div>
  </div>`;
  document.body.appendChild(mask);

  const $ = id => mask.querySelector('#' + id);
  let page = 1, pages = 1, q = '';
  const SIZE = 20;
  const msg = t => { $('lg-msg').innerHTML = t ? `<div class="lgp-msg">${esc(t)}</div>` : ''; };

  async function load() {
    msg('');
    try {
      const d = await api('GET', `?page=${page}&pageSize=${SIZE}&q=${encodeURIComponent(q)}`);
      pages = Math.max(1, Math.ceil(d.total / SIZE));
      if (page > pages) { page = pages; return load(); }
      $('lg-body').innerHTML = d.data.length
        ? d.data.map(r => `<tr><td class="t">${esc(fmt(r.ts))}</td><td>${esc(r.username) || '—'}</td><td class="i">${esc(r.ip) || '—'}</td><td class="${/失败/.test(r.action) ? 'bad' : ''}">${esc(r.action)}</td><td class="d">${esc(r.detail)}</td></tr>`).join('')
        : '<tr><td colspan="5" class="empty">暂无日志</td></tr>';
      $('lg-info').textContent = `共 ${d.total} 条，第 ${page} / ${pages} 页（仅保留最近约 5000 条）`;
      mask.querySelector('[data-a=prev]').disabled = page <= 1;
      mask.querySelector('[data-a=next]').disabled = page >= pages;
    } catch (e) { $('lg-body').innerHTML = ''; msg(e.message); }
  }

  const close = () => mask.remove();
  mask.addEventListener('mousedown', e => { mask._down = e.target === mask; });
  mask.addEventListener('click', async e => {
    if (e.target === mask && mask._down) return close();
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'close') return close();
    if (a === 'search') { q = $('lg-q').value.trim(); page = 1; return load(); }
    if (a === 'refresh') return load();
    if (a === 'prev' && page > 1) { page--; return load(); }
    if (a === 'next' && page < pages) { page++; return load(); }
    if (a === 'clear') {
      if (!confirm('确定清空全部操作日志吗？此操作不可恢复。')) return;
      try { await api('DELETE'); page = 1; q = ''; $('lg-q').value = ''; await load(); } catch (err) { msg(err.message); }
    }
  });
  $('lg-q').addEventListener('keydown', e => { if (e.key === 'Enter') { q = $('lg-q').value.trim(); page = 1; load(); } });
  load();
}
