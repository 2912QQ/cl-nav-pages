(function () {
  var API = '/api/wallpaper';

  var CACHE_KEY = 'custom-wallpaper-url';
  var STYLE_ID = 'custom-wallpaper-style';

  function readCache() {
    try { return localStorage.getItem(CACHE_KEY); } catch (e) { return null; }
  }
  function writeCache(url) {
    try { localStorage.setItem(CACHE_KEY, url || ''); } catch (e) {}
  }

  function setStyle(css) {
    var el = document.getElementById(STYLE_ID);
    if (!css) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = css;
  }

  function applyWallpaper(url) {
    writeCache(url);
    if (!url) { setStyle(''); return; }
    setStyle('.home-container{background-image:url("' + url + '")!important;' +
      'background-size:cover!important;background-position:center!important;' +
      'background-repeat:no-repeat!important;}');
  }

  // 脚本在 <head> 同步执行，首次绘制之前就要决定背景：
  //  - 有本地缓存：立刻套用上次的壁纸（空字符串 = 默认图，不干预）
  //  - 没有缓存（首次访问）：先隐藏默认背景，等接口返回后再显示，避免闪现原图
  var cached = readCache();
  if (cached === null) {
    setStyle('.home-container{background-image:none!important;}');
  } else if (cached) {
    applyWallpaper(cached);
  }

  function load() {
    fetch(API, { cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(function (d) { applyWallpaper(d.url || ''); })
      .catch(function () {
        // 请求失败：若只是临时隐藏了默认背景，则恢复默认
        if (readCache() === null) setStyle('');
      });
  }
  load();

  // 在 localStorage/sessionStorage 里找 JWT
  function getToken() {
    var stores = [localStorage, sessionStorage];
    for (var s = 0; s < stores.length; s++) {
      for (var i = 0; i < stores[s].length; i++) {
        var v = stores[s].getItem(stores[s].key(i));
        if (!v) continue;
        v = v.replace(/^"|"$/g, '');
        if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v)) return v;
      }
    }
    return '';
  }

  function request(method, path, body, isForm) {
    var headers = { Authorization: 'Bearer ' + getToken() };
    if (body && !isForm) headers['Content-Type'] = 'application/json';
    return fetch(API + path, {
      method: method,
      headers: headers,
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || '请求失败');
        return d;
      });
    });
  }

  function init() {
    var btn = document.createElement('button');
    btn.textContent = '🖼 更换壁纸';
    btn.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:99999;padding:10px 16px;' +
      'border:none;border-radius:20px;background:#399dff;color:#fff;font-size:14px;cursor:pointer;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.3);display:none;';
    document.body.appendChild(btn);

    var mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);' +
      'display:none;align-items:center;justify-content:center;';
    mask.innerHTML =
      '<div style="background:#fff;color:#222;width:min(420px,92vw);border-radius:12px;padding:20px;font-size:14px;">' +
      '<h3 style="margin:0 0 14px;">更换壁纸</h3>' +
      '<div style="margin-bottom:14px;"><div style="margin-bottom:6px;">上传图片（≤10MB）</div>' +
      '<input type="file" id="wp-file" accept="image/*"> ' +
      '<button id="wp-upload" style="margin-top:6px;padding:6px 12px;">上传并应用</button></div>' +
      '<div style="margin-bottom:14px;"><div style="margin-bottom:6px;">或填写图片 URL</div>' +
      '<input id="wp-url" placeholder="https://..." style="width:100%;box-sizing:border-box;padding:6px;"> ' +
      '<button id="wp-apply" style="margin-top:6px;padding:6px 12px;">应用 URL</button></div>' +
      '<div id="wp-msg" style="min-height:20px;color:#d33;margin-bottom:10px;"></div>' +
      '<div style="display:flex;justify-content:space-between;">' +
      '<button id="wp-reset" style="padding:6px 12px;">恢复默认</button>' +
      '<button id="wp-close" style="padding:6px 12px;">关闭</button></div></div>';
    document.body.appendChild(mask);

    function $(id) { return mask.querySelector(id); }
    function msg(t, ok) { var m = $('#wp-msg'); m.style.color = ok ? '#2a9d3f' : '#d33'; m.textContent = t; }
    function done(d) { applyWallpaper(d.url || ''); msg('已更新', true); }
    function fail(e) { msg(e.message); }

    btn.onclick = function () { msg(''); mask.style.display = 'flex'; };
    $('#wp-close').onclick = function () { mask.style.display = 'none'; };
    mask.onclick = function (e) { if (e.target === mask) mask.style.display = 'none'; };

    $('#wp-upload').onclick = function () {
      var f = $('#wp-file').files[0];
      if (!f) return msg('请先选择图片');
      var fd = new FormData();
      fd.append('wallpaper', f);
      msg('上传中…', true);
      request('POST', '/upload', fd, true).then(done).catch(fail);
    };
    $('#wp-apply').onclick = function () {
      var u = $('#wp-url').value.trim();
      if (!u) return msg('请填写 URL');
      request('POST', '/url', { url: u }).then(done).catch(fail);
    };
    $('#wp-reset').onclick = function () {
      request('DELETE', '', null).then(done).catch(fail);
    };

    // 单页应用切换路由时，按需显示按钮：仅在后台页且已登录时显示
    setInterval(function () {
      var inAdmin = /admin/i.test(location.pathname + location.hash);
      btn.style.display = (inAdmin && getToken()) ? 'block' : 'none';
    }, 800);
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
