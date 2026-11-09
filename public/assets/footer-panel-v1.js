// 后台「页脚」面板：自定义首页底部版权文字、链接文字与链接 URL
const $tok = () => localStorage.getItem('token');

async function api(method, body) {
  const r = await fetch('/api/footer', {
    method,
    cache: 'no-store',
    headers: { Authorization: 'Bearer ' + $tok(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let d = null; try { d = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((d && (d.error || d.message)) || '请求失败（HTTP ' + r.status + '）');
  return d;
}

const CSS = `
.ftp-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:12px}
.ftp{background:#fff;color:#222;border-radius:12px;width:min(520px,100%);max-height:92vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,.25);font-size:14px;line-height:1.5}
.ftp-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #eee}
.ftp-hd b{font-size:17px}.ftp-x{cursor:pointer;font-size:22px;line-height:1;border:0;background:none;color:#888}
.ftp-bd{padding:8px 18px 14px}
.ftp label.f{display:flex;flex-direction:column;gap:3px;font-size:12px;color:#666;margin:10px 0}
.ftp input[type=text]{border:1px solid #d5d9e0;border-radius:6px;padding:7px 9px;font-size:14px;color:#222;background:#fff;width:100%;box-sizing:border-box}
.ftp small{color:#888;font-size:12px}
.ftp-pv{margin:12px 0 4px;padding:14px 10px;border-radius:8px;background:#222;color:#fff;text-align:center;font-size:14px;white-space:pre-wrap;word-break:break-all}
.ftp-pv a{color:#fff;text-decoration:underline}
.ftp-msg{margin:8px 0;padding:8px 10px;border-radius:6px;font-size:13px;word-break:break-all}.ftp-msg.ok{background:#e6f4ea}.ftp-msg.bad{background:#fce8e6}
.ftp-ft{display:flex;gap:8px;justify-content:space-between;padding:12px 18px;border-top:1px solid #eee}
.ftp-b{border:1px solid #2566d8;background:#2566d8;color:#fff;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:14px;white-space:nowrap}
.ftp-b.o{background:#fff;color:#2566d8}.ftp-b:disabled{opacity:.5;cursor:wait}
`;

export async function openFooter() {
  if (document.querySelector('.ftp-mask')) return;
  if (!document.getElementById('ftp-css')) {
    const st = document.createElement('style'); st.id = 'ftp-css'; st.textContent = CSS; document.head.appendChild(st);
  }
  const mask = document.createElement('div');
  mask.className = 'ftp-mask';
  mask.innerHTML = `<div class="ftp">
    <div class="ftp-hd"><b>自定义页脚</b><button class="ftp-x" data-a="close" title="关闭">×</button></div>
    <div class="ftp-bd">
      <div id="ft-msg"></div>
      <label class="f">版权文字（链接前面的部分，可留空）
        <input type="text" id="ft-text" maxlength="200" placeholder="Copyright © 2026  |  ">
      </label>
      <label class="f">链接文字（留空则不显示链接）
        <input type="text" id="ft-link-text" maxlength="100" placeholder="龍哥博客">
      </label>
      <label class="f">链接 URL（http:// 或 https:// 开头；留空则链接文字仅作普通文字显示）
        <input type="text" id="ft-url" maxlength="500" placeholder="https://example.com/">
      </label>
      <small>预览：</small>
      <div class="ftp-pv" id="ft-pv"></div>
    </div>
    <div class="ftp-ft">
      <button class="ftp-b o" data-a="reset">恢复默认</button>
      <div style="display:flex;gap:8px"><button class="ftp-b o" data-a="close">关闭</button><button class="ftp-b" data-a="save">保存</button></div>
    </div>
  </div>`;
  document.body.appendChild(mask);

  const $ = id => mask.querySelector('#' + id);
  const msg = (t, ok = true) => { const m = $('ft-msg'); m.innerHTML = ''; if (!t) return; const d = document.createElement('div'); d.className = 'ftp-msg ' + (ok ? 'ok' : 'bad'); d.textContent = t; m.appendChild(d); };
  const close = () => mask.remove();
  const get = () => ({ text: $('ft-text').value, link_text: $('ft-link-text').value.trim(), url: $('ft-url').value.trim() });
  const fill = f => { $('ft-text').value = f.text || ''; $('ft-link-text').value = f.link_text || ''; $('ft-url').value = f.url || ''; preview(); };
  function preview() {
    const f = get(), pv = $('ft-pv');
    pv.textContent = f.text;
    if (f.link_text) {
      if (f.url && /^https?:\/\//i.test(f.url)) { const a = document.createElement('a'); a.href = f.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = f.link_text; pv.appendChild(a); }
      else pv.appendChild(document.createTextNode(f.link_text));
    }
  }
  const sync = f => { try { localStorage.setItem('nav-footer', JSON.stringify(f)); } catch (e) {} };
  async function guard(btn, fn) {
    btn.disabled = true;
    try { await fn(); } catch (e) { msg(e.message, false); } finally { btn.disabled = false; }
  }

  mask.addEventListener('input', preview);
  mask.addEventListener('mousedown', e => { mask._down = e.target === mask; });
  mask.addEventListener('click', e => {
    if (e.target === mask && mask._down) return close();
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'close') return close();
    if (a === 'save') return guard(b, async () => { const f = await api('PUT', get()); sync(f); fill(f); msg('已保存，刷新首页即可看到新的页脚'); });
    if (a === 'reset') return guard(b, async () => {
      if (!confirm('确定恢复为默认页脚吗？')) return;
      const f = await api('DELETE'); sync(f); fill(f); msg('已恢复默认');
    });
  });

  try { fill(await (await fetch('/api/footer', { cache: 'no-store' })).json()); } catch (e) { msg('读取当前设置失败：' + e.message, false); }
}
