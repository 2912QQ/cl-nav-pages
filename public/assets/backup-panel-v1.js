// 后台「备份」面板：本地备份 / WebDAV / 站内存档 / 自动备份（时间可自定义）
const $tok = () => localStorage.getItem('token');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtT = ts => (ts ? new Date(ts + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '—');
const fmtS = n => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(1) + ' KB' : (n || 0) + ' B');
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const TG = { webdav: 'WebDAV', kv: '站内存档' };

async function api(path, opt = {}) {
  const r = await fetch(path, { ...opt, headers: { Authorization: 'Bearer ' + $tok(), ...(opt.body ? { 'Content-Type': 'application/json' } : {}) } });
  let d = null; try { d = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((d && (d.error || d.message)) || '请求失败（HTTP ' + r.status + '）');
  return d;
}
async function saveBlob(path, fallbackName) {
  const r = await fetch(path, { headers: { Authorization: 'Bearer ' + $tok() } });
  if (!r.ok) { let m = '下载失败（HTTP ' + r.status + '）'; try { m = (await r.json()).error || m; } catch (e) {} throw new Error(m); }
  const cd = r.headers.get('Content-Disposition') || '', fn = (/filename="?([^";]+)"?/.exec(cd) || [])[1] || fallbackName;
  const url = URL.createObjectURL(await r.blob()), a = document.createElement('a');
  a.href = url; a.download = fn; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const CSS = `
.bkp-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:12px}
.bkp{background:#fff;color:#222;border-radius:12px;width:min(780px,100%);max-height:92vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,.25);font-size:14px;line-height:1.5}
.bkp-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #eee;position:sticky;top:0;background:#fff;z-index:1}
.bkp-hd b{font-size:17px}.bkp-x{cursor:pointer;font-size:22px;line-height:1;border:0;background:none;color:#888}
.bkp-bd{padding:6px 18px 14px}.bkp h4{margin:16px 0 8px;font-size:15px;color:#2566d8;border-left:3px solid #2566d8;padding-left:8px}
.bkp-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}
.bkp-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px}@media(max-width:600px){.bkp-grid{grid-template-columns:1fr}}
.bkp label.f{display:flex;flex-direction:column;gap:3px;font-size:12px;color:#666}
.bkp input[type=text],.bkp input[type=password],.bkp input[type=number],.bkp input[type=time],.bkp select{border:1px solid #d5d9e0;border-radius:6px;padding:7px 9px;font-size:14px;color:#222;background:#fff;min-width:0;width:100%;box-sizing:border-box}
.bkp-b{border:1px solid #2566d8;background:#2566d8;color:#fff;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:14px;white-space:nowrap}
.bkp-b.o{background:#fff;color:#2566d8}.bkp-b.r{border-color:#d93025;color:#d93025;background:#fff}.bkp-b:disabled{opacity:.5;cursor:wait}
.bkp-b.s{padding:3px 9px;font-size:12px}
.bkp small,.bkp .tip{color:#888;font-size:12px}.bkp .tip{background:#f6f8fb;border-radius:6px;padding:7px 10px;margin:6px 0}
.bkp table{width:100%;border-collapse:collapse;font-size:13px}.bkp td,.bkp th{padding:6px 4px;border-bottom:1px solid #f0f0f0;text-align:left}
.bkp .ok{color:#188038}.bkp .bad{color:#d93025}
.bkp-tabs{display:flex;gap:6px;margin-bottom:6px}.bkp-tabs .bkp-b{padding:4px 12px}
.bkp-msg{margin:8px 0;padding:8px 10px;border-radius:6px;font-size:13px;word-break:break-all}.bkp-msg.ok{background:#e6f4ea}.bkp-msg.bad{background:#fce8e6}
.bkp code{background:#f1f3f4;padding:1px 5px;border-radius:4px;word-break:break-all;font-size:12px}
.bkp-ft{display:flex;gap:8px;justify-content:flex-end;padding:12px 18px;border-top:1px solid #eee;position:sticky;bottom:0;background:#fff}
`;

export async function openBackup() {
  if (document.querySelector('.bkp-mask')) return;
  if (!document.getElementById('bkp-css')) { const st = document.createElement('style'); st.id = 'bkp-css'; st.textContent = CSS; document.head.appendChild(st); }
  const mask = document.createElement('div');
  mask.className = 'bkp-mask';
  mask.innerHTML = `<div class="bkp"><div class="bkp-hd"><b>备份与恢复</b><button class="bkp-x" data-a="close" title="关闭">×</button></div>
  <div class="bkp-bd">
    <div id="bk-msg"></div>

    <h4>① 本地备份</h4>
    <div class="bkp-row">
      <label><input type="checkbox" id="bk-limg"> 同时打包图片（自定义图标 / 壁纸，文件会变大）</label>
    </div>
    <div class="bkp-row">
      <button class="bkp-b" data-a="download">下载备份到本地</button>
      <button class="bkp-b o" data-a="upload">从本地文件恢复</button>
      <small>备份内容：栏目、子栏目、卡片、广告、友链、壁纸设置（不含登录账号）</small>
    </div>

    <h4>② WebDAV 备份</h4>
    <div class="bkp-grid">
      <label class="f">WebDAV 地址<input type="text" id="wd-url" placeholder="https://dav.jianguoyun.com/dav/" autocomplete="off"></label>
      <label class="f">保存目录（不存在会自动创建）<input type="text" id="wd-dir" placeholder="nav-backup" autocomplete="off"></label>
      <label class="f">用户名<input type="text" id="wd-user" autocomplete="off"></label>
      <label class="f">密码 / 应用密码<input type="password" id="wd-pw" autocomplete="new-password" placeholder=""></label>
    </div>
    <div class="bkp-row">
      <button class="bkp-b o" data-a="wd-test">测试连接</button>
      <button class="bkp-b" data-a="wd-run">立即备份到 WebDAV</button>
      <small>密码加密后保存在数据库中</small>
    </div>

    <h4>③ 自动备份</h4>
    <div class="bkp-row"><label><input type="checkbox" id="au-on"> <b>启用自动备份</b></label></div>
    <div class="bkp-grid">
      <label class="f">备份周期
        <select id="au-mode"><option value="daily">每天定时</option><option value="weekly">每周定时</option><option value="interval">每隔 N 小时</option></select></label>
      <label class="f" id="au-w-time">执行时间（北京时间）<input type="time" id="au-time" value="03:00"></label>
      <label class="f" id="au-w-wd">星期<select id="au-wd">${WD.map((n, i) => `<option value="${i}">${n}</option>`).join('')}</select></label>
      <label class="f" id="au-w-int">间隔小时数（1–720）<input type="number" id="au-int" min="1" max="720" value="24"></label>
      <label class="f">每个位置最多保留份数（0 = 不限）<input type="number" id="au-keep" min="0" max="200" value="7"></label>
    </div>
    <div class="bkp-row">
      <span>保存到：</span>
      <label><input type="checkbox" id="au-t-webdav"> WebDAV</label>
      <label><input type="checkbox" id="au-t-kv"> 站内存档（KV）</label>
      <label><input type="checkbox" id="au-img"> 打包图片</label>
    </div>
    <div class="tip" id="au-status"></div>
    <div class="tip">⚠ Cloudflare Pages 没有内置定时器：到点后的<b>第一次访问</b>（前台或后台均可）会触发备份。想要严格准点，可用 cron-job.org / UptimeRobot 等每 5–10 分钟访问下面的地址（未到点会自动跳过，不会重复备份）：<br><code id="au-cron"></code>
      <button class="bkp-b s o" data-a="cron-copy">复制</button> <button class="bkp-b s o" data-a="cron-regen">重置令牌</button></div>

    <h4>④ 备份文件管理</h4>
    <div class="bkp-tabs"><button class="bkp-b" data-a="tab-kv">站内存档</button><button class="bkp-b o" data-a="tab-webdav">WebDAV</button><button class="bkp-b o s" data-a="refresh">刷新</button></div>
    <div id="bk-list"><small>加载中…</small></div>

    <h4>⑤ 最近记录</h4>
    <div id="bk-hist"><small>—</small></div>
  </div>
  <div class="bkp-ft"><button class="bkp-b o" data-a="close">关闭</button><button class="bkp-b" data-a="save">保存设置</button></div></div>`;
  document.body.appendChild(mask);

  const $ = id => mask.querySelector('#' + id);
  let cfg = null, tab = 'kv', busy = false;
  const msg = (t, ok = true) => { $('bk-msg').innerHTML = t ? `<div class="bkp-msg ${ok ? 'ok' : 'bad'}">${esc(t)}</div>` : ''; $('bk-msg').scrollIntoView({ block: 'nearest' }); };
  const guard = async (btn, fn) => {
    if (busy) return; busy = true; const old = btn && btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
    try { await fn(); } catch (e) { msg(e.message, false); } finally { busy = false; if (btn) { btn.disabled = false; btn.textContent = old; } }
  };
  const modeUi = () => {
    const m = $('au-mode').value;
    $('au-w-time').style.display = m === 'interval' ? 'none' : '';
    $('au-w-wd').style.display = m === 'weekly' ? '' : 'none';
    $('au-w-int').style.display = m === 'interval' ? '' : 'none';
  };
  $('au-mode').onchange = modeUi;

  const fill = () => {
    const w = cfg.webdav, a = cfg.auto;
    $('wd-url').value = w.url || ''; $('wd-dir').value = w.dir || ''; $('wd-user').value = w.username || '';
    $('wd-pw').value = ''; $('wd-pw').placeholder = w.has_password ? '已保存，留空表示不修改' : '';
    $('au-on').checked = !!a.enabled; $('au-mode').value = a.mode; $('au-time').value = a.time; $('au-wd').value = a.weekday;
    $('au-int').value = a.intervalHours; $('au-keep').value = a.keep;
    $('au-t-webdav').checked = a.targets.includes('webdav'); $('au-t-kv').checked = a.targets.includes('kv'); $('au-img').checked = !!a.includeImages;
    if (!cfg.kvBound) { $('au-t-kv').disabled = true; $('au-t-kv').checked = false; }
    $('au-cron').textContent = `${location.origin}/api/backup/cron?token=${cfg.cron_token}`;
    modeUi(); status(); hist();
  };
  const status = () => {
    const s = cfg.state || {}, a = cfg.auto;
    let t = `上次备份成功：${fmtT(s.last_success)}（UTC+8）`;
    if (s.last_ok === false && s.last_msg) t += `　｜　最近一次失败：${s.last_msg}`;
    if (a.enabled && s.next_run) t += `　｜　下次执行：${s.next_run <= cfg.now ? '已到时间，将在下次访问时执行' : fmtT(s.next_run)}`;
    else t += '　｜　自动备份未启用';
    $('au-status').textContent = t;
  };
  const hist = () => {
    const h = (cfg.state && cfg.state.history) || [];
    $('bk-hist').innerHTML = h.length ? `<table>${h.map(x => `<tr><td>${fmtT(x.t)}</td><td>${{ auto: '自动', manual: '手动', restore: '恢复' }[x.trigger] || ''}</td><td class="${x.ok ? 'ok' : 'bad'}">${x.ok ? '成功' : '失败'}</td><td>${esc(x.msg || '')}${x.size ? ` <small>(${fmtS(x.size)})</small>` : ''}</td></tr>`).join('')}</table>` : '<small>暂无记录</small>';
  };
  const collect = () => ({
    webdav: { url: $('wd-url').value.trim(), dir: $('wd-dir').value.trim(), username: $('wd-user').value, password: $('wd-pw').value },
    auto: {
      enabled: $('au-on').checked, mode: $('au-mode').value, time: $('au-time').value || '03:00', weekday: +$('au-wd').value,
      intervalHours: +$('au-int').value || 24, keep: +$('au-keep').value || 0, includeImages: $('au-img').checked,
      targets: ['webdav', 'kv'].filter(k => $('au-t-' + k).checked)
    }
  });
  const load = async () => { cfg = await api('/api/backup/config'); fill(); await list(); };
  const save = async () => { await api('/api/backup/config', { method: 'PUT', body: JSON.stringify(collect()) }); cfg = await api('/api/backup/config'); fill(); };
  const list = async () => {
    const box = $('bk-list'); box.innerHTML = '<small>加载中…</small>';
    mask.querySelectorAll('[data-a^=tab-]').forEach(b => b.classList.toggle('o', b.dataset.a !== 'tab-' + tab));
    try {
      const d = (await api('/api/backup/list?source=' + tab)).data;
      box.innerHTML = d.length ? `<table>${d.map(x => `<tr><td style="word-break:break-all">${esc(x.name)}${x.name.includes('pre-restore') ? ' <small>(恢复前自动存档)</small>' : ''}</td><td>${fmtS(x.size)}</td><td>${fmtT(x.time)}</td>
        <td style="white-space:nowrap"><button class="bkp-b s" data-a="restore" data-n="${esc(x.name)}">恢复</button> <button class="bkp-b s o" data-a="dl" data-n="${esc(x.name)}">下载</button> <button class="bkp-b s r" data-a="del" data-n="${esc(x.name)}">删除</button></td></tr>`).join('')}</table>` : '<small>暂无备份文件</small>';
    } catch (e) { box.innerHTML = `<small class="bad">${esc(e.message)}</small>`; }
  };
  const doRestore = async (payload, label) => {
    if (!confirm(`即将用「${label}」覆盖当前的栏目 / 卡片 / 广告 / 友链 / 壁纸设置（登录账号不受影响）。\n恢复前会自动把当前数据存一份到「站内存档」，可用于回滚。\n\n确定继续吗？`)) return;
    const d = await api('/api/backup/restore', { method: 'POST', body: JSON.stringify(payload) });
    msg(`恢复完成：栏目 ${d.menus}、子栏目 ${d.sub_menus}、卡片 ${d.cards}、广告 ${d.ads}、友链 ${d.friends}、图片 ${d.files}` + (d.skipped ? `，跳过无效记录 ${d.skipped}` : '') + '。页面即将刷新…');
    setTimeout(() => location.reload(), 1800);
  };
  const runNow = async targets => {
    await save();
    const d = await api('/api/backup/run', { method: 'POST', body: JSON.stringify({ targets, images: $('au-img').checked || $('bk-limg').checked }) });
    msg(`${d.ok ? '备份完成' : '备份失败'}：${d.name}（${fmtS(d.size)}）　` + d.results.map(r => `${TG[r.target]}：${r.ok ? '成功' : r.msg}`).join('；'), d.ok);
    cfg = await api('/api/backup/config'); status(); hist(); await list();
  };

  mask.addEventListener('click', e => {
    if (e.target === mask) return;
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a, n = b.dataset.n;
    if (a === 'close') return mask.remove();
    if (a === 'download') return guard(b, async () => { await saveBlob('/api/backup/download?images=' + ($('bk-limg').checked ? 1 : 0), 'nav-backup.json'); msg('备份文件已开始下载'); });
    if (a === 'upload') {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
      inp.onchange = () => { const f = inp.files[0]; if (f) guard(b, async () => { const t = await f.text(); await doRestore({ source: 'upload', content: t }, f.name); }); };
      return inp.click();
    }
    if (a === 'wd-test') return guard(b, async () => { const c = collect(); const d = await api('/api/backup/webdav/test', { method: 'POST', body: JSON.stringify({ webdav: c.webdav }) }); msg(d.message); });
    if (a === 'wd-run') return guard(b, () => runNow(['webdav']));
    if (a === 'save') return guard(b, async () => { await save(); msg('设置已保存'); });
    if (a === 'cron-copy') return navigator.clipboard.writeText($('au-cron').textContent).then(() => msg('已复制 Cron 地址'), () => msg('复制失败，请手动选择复制', false));
    if (a === 'cron-regen') return guard(b, async () => { if (!confirm('重置后旧的 Cron 地址会失效，确定吗？')) return; await api('/api/backup/config', { method: 'PUT', body: JSON.stringify({ regen_token: true }) }); cfg = await api('/api/backup/config'); fill(); msg('令牌已重置，请更新外部定时服务里的地址'); });
    if (a === 'tab-kv' || a === 'tab-webdav') { tab = a.slice(4); return list(); }
    if (a === 'refresh') return guard(b, list);
    if (a === 'restore') return guard(b, () => doRestore({ source: tab, name: n }, n));
    if (a === 'dl') return guard(b, () => saveBlob(`/api/backup/file?source=${tab}&name=${encodeURIComponent(n)}`, n));
    if (a === 'del') return guard(b, async () => { if (!confirm('确定删除备份「' + n + '」吗？')) return; await api(`/api/backup/file?source=${tab}&name=${encodeURIComponent(n)}`, { method: 'DELETE' }); msg('已删除'); await list(); });
  });
  try { await load(); } catch (e) { msg(e.message, false); }
}
