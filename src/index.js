import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';
import bcrypt from 'bcryptjs';

const app = new Hono();
const enc = new TextEncoder();
const n = v => (v === undefined ? null : v);
const body = c => c.req.json().catch(() => ({}));
const stmt = (c, sql, p = []) => c.env.DB.prepare(sql).bind(...p.map(n));
const all = async (c, sql, ...p) => (await stmt(c, sql, p).all()).results;
const first = (c, sql, ...p) => stmt(c, sql, p).first();
const run = (c, sql, ...p) => stmt(c, sql, p).run();
const MAX_IMG = 10 * 1024 * 1024; // KV 单值上限 25MB
const exp2h = () => Math.floor(Date.now() / 1000) + 7200;

app.onError((e, c) => c.json({ error: e.message }, 500));

// ---------- 首次访问自动建表（无需手动执行 SQL） ----------
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS menus (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, "order" INTEGER DEFAULT 0, password_hash TEXT)',
  'CREATE TABLE IF NOT EXISTS sub_menus (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER NOT NULL, name TEXT NOT NULL, "order" INTEGER DEFAULT 0, password_hash TEXT, FOREIGN KEY(parent_id) REFERENCES menus(id) ON DELETE CASCADE)',
  'CREATE TABLE IF NOT EXISTS cards (id INTEGER PRIMARY KEY AUTOINCREMENT, menu_id INTEGER, sub_menu_id INTEGER, title TEXT NOT NULL, url TEXT NOT NULL, logo_url TEXT, custom_logo_path TEXT, "desc" TEXT, "order" INTEGER DEFAULT 0, FOREIGN KEY(menu_id) REFERENCES menus(id) ON DELETE CASCADE, FOREIGN KEY(sub_menu_id) REFERENCES sub_menus(id) ON DELETE CASCADE)',
  'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, last_login_time TEXT, last_login_ip TEXT)',
  'CREATE TABLE IF NOT EXISTS ads (id INTEGER PRIMARY KEY AUTOINCREMENT, position TEXT NOT NULL, img TEXT NOT NULL, url TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS friends (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, url TEXT NOT NULL, logo TEXT)',
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_menus_order ON menus("order")',
  'CREATE INDEX IF NOT EXISTS idx_sub_menus_parent_id ON sub_menus(parent_id)',
  'CREATE INDEX IF NOT EXISTS idx_cards_menu_id ON cards(menu_id)',
  'CREATE INDEX IF NOT EXISTS idx_cards_sub_menu_id ON cards(sub_menu_id)'
];
let ready = null;
function ensure(env) {
  if (!ready) {
    ready = (async () => {
      await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
      if (!(await env.DB.prepare("SELECT 1 AS x FROM settings WHERE key='seeded'").first())) {
        if (!(await env.DB.prepare('SELECT COUNT(*) AS n FROM menus').first()).n)
          await env.DB.prepare('INSERT INTO menus (name,"order") VALUES (?,?)').bind('Home', 1).run();
        await env.DB.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('seeded','1')").run();
      }
    })().catch(e => { ready = null; throw e; });
  }
  return ready;
}
app.use('/api/*', async (c, next) => { await ensure(c.env); await next(); });

// JWT 密钥：优先用环境变量 JWT_SECRET；没设置则自动生成并保存在数据库里
let genSecret = null;
async function jwtSecret(c) {
  if (c.env.JWT_SECRET) return c.env.JWT_SECRET;
  if (genSecret) return genSecret;
  const read = () => first(c, "SELECT value FROM settings WHERE key='jwt_secret'");
  let r = await read();
  if (!r) {
    await run(c, "INSERT OR IGNORE INTO settings (key,value) VALUES ('jwt_secret',?)", b64(crypto.getRandomValues(new Uint8Array(32))));
    r = await read();
  }
  return (genSecret = r.value);
}
const safeEq = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };

// 自检：访问 /api/health 可查看配置是否就绪（不泄露任何密钥）
app.get('/api/health', async c => c.json({
  ok: true,
  kvBound: !!c.env.KV,
  adminPasswordSet: !!c.env.ADMIN_PASSWORD,
  jwtSecretSet: !!c.env.JWT_SECRET,
  users: (await first(c, 'SELECT COUNT(*) AS n FROM users')).n
}));

// ---------- 密码：新格式 PBKDF2（Workers 友好），兼容旧 bcrypt ----------
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));
async function pbkdf2(pw, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
}
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$100000$${b64(salt)}$${b64(await pbkdf2(pw, salt, 100000))}`;
}
async function checkPassword(pw, hash) {
  if (!hash || typeof pw !== 'string') return false;
  if (hash.startsWith('pbkdf2$')) {
    const [, it, s, h] = hash.split('$');
    return b64(await pbkdf2(pw, unb64(s), +it)) === h;
  }
  return bcrypt.compare(pw, hash);
}

// ---------- 鉴权 ----------
const auth = async (c, next) => {
  const h = c.req.header('Authorization') || '';
  if (!h.startsWith('Bearer ')) return c.json({ error: '未授权' }, 401);
  try {
    const p = await verify(h.slice(7), await jwtSecret(c), 'HS256');
    if (p.kind || p.typ) throw new Error('bad');
    c.set('user', p);
  } catch (e) { return c.json({ error: '无效token' }, 401); }
  await next();
};
const unlockSecret = async c => (await jwtSecret(c)) + ':category-unlock';
const signUnlock = async (c, kind, id, ph) => sign({ typ: 'cat-unlock', kind, id: Number(id), ph, exp: exp2h() }, await unlockSecret(c), 'HS256');
async function unlockTokens(c) {
  const out = [];
  for (const t of (c.req.header('x-category-unlock') || '').split(',').map(s => s.trim()).filter(Boolean)) {
    try { const p = await verify(t, await unlockSecret(c), 'HS256'); if (p.typ === 'cat-unlock') out.push(p); } catch (e) {}
  }
  return out;
}
const isUnlocked = (ps, kind, id, hash) => !hash || ps.some(p => p.kind === kind && Number(p.id) === Number(id) && p.ph === hash);

const pub = r => { const { password_hash, ...s } = r; return { ...s, has_password: !!password_hash }; };
async function list(c, table, order = '', map = x => x) {
  const { page, pageSize } = c.req.query();
  if (!page && !pageSize) return c.json((await all(c, `SELECT * FROM ${table} ${order}`)).map(map));
  const num = parseInt(page) || 1, size = parseInt(pageSize) || 10;
  const total = (await first(c, `SELECT COUNT(*) AS total FROM ${table}`)).total;
  const rows = await all(c, `SELECT * FROM ${table} ${order} LIMIT ? OFFSET ?`, size, (num - 1) * size);
  return c.json({ total, page: num, pageSize: size, data: rows.map(map) });
}

// ---------- 登录 / 用户 ----------
app.post('/api/login', async c => {
  const { username, password } = await body(c);
  let seeded = false;
  if (!(await first(c, 'SELECT 1 AS x FROM users LIMIT 1'))) {
    if (!c.env.ADMIN_PASSWORD) return c.json({ error: '服务器未设置 ADMIN_PASSWORD 环境变量' }, 500);
    await run(c, 'INSERT INTO users (username,password) VALUES (?,?)', c.env.ADMIN_USERNAME || 'admin', await hashPassword(String(c.env.ADMIN_PASSWORD)));
    seeded = true;
  }
  const user = await first(c, 'SELECT * FROM users WHERE username=?', username);
  const ok = user && (seeded ? safeEq(String(password || ''), String(c.env.ADMIN_PASSWORD)) : await checkPassword(password, user.password));
  if (!ok) return c.json({ error: '用户名或密码错误' }, 401);
  const now = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
  await run(c, 'UPDATE users SET last_login_time=?, last_login_ip=? WHERE id=?', now, c.req.header('cf-connecting-ip') || '', user.id);
  const token = await sign({ id: user.id, username: user.username, exp: exp2h() }, await jwtSecret(c), 'HS256');
  return c.json({ token, lastLoginTime: user.last_login_time, lastLoginIp: user.last_login_ip });
});
app.get('/api/users/profile', auth, async c => {
  const u = await first(c, 'SELECT id, username FROM users WHERE id=?', c.get('user').id);
  return u ? c.json({ data: u }) : c.json({ message: '用户不存在' }, 404);
});
app.get('/api/users/me', auth, async c => {
  const u = await first(c, 'SELECT last_login_time, last_login_ip FROM users WHERE id=?', c.get('user').id);
  return u ? c.json(u) : c.json({ message: '用户不存在' }, 404);
});
app.put('/api/users/password', auth, async c => {
  const { oldPassword, newPassword } = await body(c);
  if (!oldPassword || !newPassword) return c.json({ message: '请提供旧密码和新密码' }, 400);
  if (newPassword.length < 6) return c.json({ message: '新密码长度至少6位' }, 400);
  const u = await first(c, 'SELECT password FROM users WHERE id=?', c.get('user').id);
  if (!u) return c.json({ message: '用户不存在' }, 404);
  if (!(await checkPassword(oldPassword, u.password))) return c.json({ message: '旧密码错误' }, 400);
  await run(c, 'UPDATE users SET password=? WHERE id=?', await hashPassword(newPassword), c.get('user').id);
  return c.json({ message: '密码修改成功' });
});
app.get('/api/users', auth, async c => {
  const { page, pageSize } = c.req.query();
  if (!page && !pageSize) return c.json({ data: await all(c, 'SELECT id, username FROM users') });
  const num = parseInt(page) || 1, size = parseInt(pageSize) || 10;
  const total = (await first(c, 'SELECT COUNT(*) AS total FROM users')).total;
  return c.json({ total, page: num, pageSize: size, data: await all(c, 'SELECT id, username FROM users LIMIT ? OFFSET ?', size, (num - 1) * size) });
});

// ---------- 菜单 ----------
async function setCatPassword(c, table, notFound) {
  const { password } = await body(c);
  const pw = typeof password === 'string' ? password : '';
  if (pw.length > 200) return c.json({ error: '密码不能超过200个字符' }, 400);
  const hash = pw ? await hashPassword(pw) : null;
  const r = await run(c, `UPDATE ${table} SET password_hash=? WHERE id=?`, hash, c.req.param('id'));
  if (!r.meta.changes) return c.json({ error: notFound }, 404);
  return c.json({ success: true, has_password: !!hash });
}
app.put('/api/menus/:id/password', auth, c => setCatPassword(c, 'menus', '分类不存在'));
app.put('/api/menus/submenus/:id/password', auth, c => setCatPassword(c, 'sub_menus', '子分类不存在'));
app.post('/api/menus/verify-password', async c => {
  const { kind, id, password } = await body(c);
  if (!['menu', 'submenu'].includes(kind) || !/^\d+$/.test(String(id)) || typeof password !== 'string') return c.json({ error: '参数不正确' }, 400);
  const row = await first(c, `SELECT id, password_hash FROM ${kind === 'menu' ? 'menus' : 'sub_menus'} WHERE id=?`, Number(id));
  if (!row) return c.json({ error: '分类不存在' }, 404);
  if (!row.password_hash) return c.json({ success: true, token: null });
  if (!(await checkPassword(password, row.password_hash))) return c.json({ error: '密码错误' }, 401);
  return c.json({ success: true, token: await signUnlock(c, kind, id, row.password_hash) });
});
app.get('/api/menus', async c => {
  const { page, pageSize } = c.req.query();
  if (page || pageSize) return list(c, 'menus', 'ORDER BY "order"', pub);
  const menus = await all(c, 'SELECT * FROM menus ORDER BY "order"');
  const subs = await all(c, 'SELECT * FROM sub_menus ORDER BY "order"');
  return c.json(menus.map(m => ({ ...pub(m), subMenus: subs.filter(s => s.parent_id === m.id).map(pub) })));
});
app.get('/api/menus/:id/submenus', async c =>
  c.json((await all(c, 'SELECT * FROM sub_menus WHERE parent_id=? ORDER BY "order"', c.req.param('id'))).map(pub)));
app.post('/api/menus', auth, async c => {
  const { name, order } = await body(c);
  return c.json({ id: (await run(c, 'INSERT INTO menus (name,"order") VALUES (?,?)', name, order || 0)).meta.last_row_id });
});
app.put('/api/menus/:id', auth, async c => {
  const { name, order } = await body(c);
  return c.json({ changed: (await run(c, 'UPDATE menus SET name=?, "order"=? WHERE id=?', name, order || 0, c.req.param('id'))).meta.changes });
});
app.delete('/api/menus/:id', auth, async c =>
  c.json({ deleted: (await run(c, 'DELETE FROM menus WHERE id=?', c.req.param('id'))).meta.changes }));
app.post('/api/menus/:id/submenus', auth, async c => {
  const { name, order } = await body(c);
  return c.json({ id: (await run(c, 'INSERT INTO sub_menus (parent_id,name,"order") VALUES (?,?,?)', c.req.param('id'), name, order || 0)).meta.last_row_id });
});
app.put('/api/menus/submenus/:id', auth, async c => {
  const { name, order } = await body(c);
  return c.json({ changed: (await run(c, 'UPDATE sub_menus SET name=?, "order"=? WHERE id=?', name, order || 0, c.req.param('id'))).meta.changes });
});
app.delete('/api/menus/submenus/:id', auth, async c =>
  c.json({ deleted: (await run(c, 'DELETE FROM sub_menus WHERE id=?', c.req.param('id'))).meta.changes }));

// ---------- 卡片 ----------
app.get('/api/cards/:menuId', async c => {
  const { subMenuId } = c.req.query();
  const tokens = await unlockTokens(c);
  const locked = () => c.json({ error: '该分类需要密码验证', locked: true }, 403);
  const send = async (sql, id) => {
    const rows = await all(c, sql, id);
    rows.forEach(r => { r.display_logo = r.custom_logo_path ? '/uploads/' + r.custom_logo_path : (r.logo_url || r.url.replace(/\/+$/, '') + '/favicon.ico'); });
    return c.json(rows);
  };
  if (subMenuId) {
    if (!/^\d+$/.test(String(subMenuId))) return c.json({ error: '参数不正确' }, 400);
    const row = await first(c, 'SELECT s.id, s.parent_id, s.password_hash AS sub_hash, m.password_hash AS menu_hash FROM sub_menus s LEFT JOIN menus m ON m.id = s.parent_id WHERE s.id=?', Number(subMenuId));
    if (!row) return c.json({ error: '分类不存在' }, 404);
    if (!isUnlocked(tokens, 'menu', row.parent_id, row.menu_hash) || !isUnlocked(tokens, 'submenu', row.id, row.sub_hash)) return locked();
    return send('SELECT * FROM cards WHERE sub_menu_id=? ORDER BY "order"', row.id);
  }
  const row = await first(c, 'SELECT id, password_hash FROM menus WHERE id=?', Number(c.req.param('menuId')));
  if (!row) return c.json({ error: '分类不存在' }, 404);
  if (!isUnlocked(tokens, 'menu', row.id, row.password_hash)) return locked();
  return send('SELECT * FROM cards WHERE menu_id=? AND sub_menu_id IS NULL ORDER BY "order"', row.id);
});
app.post('/api/cards', auth, async c => {
  const b = await body(c);
  const r = await run(c, 'INSERT INTO cards (menu_id,sub_menu_id,title,url,logo_url,custom_logo_path,"desc","order") VALUES (?,?,?,?,?,?,?,?)',
    b.menu_id, b.sub_menu_id || null, b.title, b.url, b.logo_url, b.custom_logo_path, b.desc, b.order || 0);
  return c.json({ id: r.meta.last_row_id });
});
app.put('/api/cards/:id', auth, async c => {
  const b = await body(c);
  const r = await run(c, 'UPDATE cards SET menu_id=?, sub_menu_id=?, title=?, url=?, logo_url=?, custom_logo_path=?, "desc"=?, "order"=? WHERE id=?',
    b.menu_id, b.sub_menu_id || null, b.title, b.url, b.logo_url, b.custom_logo_path, b.desc, b.order || 0, c.req.param('id'));
  return c.json({ changed: r.meta.changes });
});
app.delete('/api/cards/:id', auth, async c =>
  c.json({ deleted: (await run(c, 'DELETE FROM cards WHERE id=?', c.req.param('id'))).meta.changes }));

// ---------- 广告 / 友链 ----------
app.get('/api/ads', c => list(c, 'ads'));
app.post('/api/ads', auth, async c => {
  const { position, img, url } = await body(c);
  return c.json({ id: (await run(c, 'INSERT INTO ads (position,img,url) VALUES (?,?,?)', position, img, url)).meta.last_row_id });
});
app.put('/api/ads/:id', auth, async c => {
  const { img, url } = await body(c);
  return c.json({ changed: (await run(c, 'UPDATE ads SET img=?, url=? WHERE id=?', img, url, c.req.param('id'))).meta.changes });
});
app.delete('/api/ads/:id', auth, async c =>
  c.json({ deleted: (await run(c, 'DELETE FROM ads WHERE id=?', c.req.param('id'))).meta.changes }));
app.get('/api/friends', c => list(c, 'friends'));
app.post('/api/friends', auth, async c => {
  const { title, url, logo } = await body(c);
  return c.json({ id: (await run(c, 'INSERT INTO friends (title,url,logo) VALUES (?,?,?)', title, url, logo)).meta.last_row_id });
});
app.put('/api/friends/:id', auth, async c => {
  const { title, url, logo } = await body(c);
  return c.json({ changed: (await run(c, 'UPDATE friends SET title=?, url=?, logo=? WHERE id=?', title, url, logo, c.req.param('id'))).meta.changes });
});
app.delete('/api/friends/:id', auth, async c =>
  c.json({ deleted: (await run(c, 'DELETE FROM friends WHERE id=?', c.req.param('id'))).meta.changes }));

// ---------- 上传 / 图片读取（存放在 KV） ----------
const IMG = /^image\/(jpeg|png|webp|gif|avif|x-icon|vnd\.microsoft\.icon)$/;
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', ico: 'image/x-icon' };
async function saveImage(c, field, prefix, maxBytes) {
  const form = await c.req.formData().catch(() => null);
  const f = form && form.get(field);
  if (!f || typeof f === 'string') return { error: '未选择文件' };
  if (!IMG.test(f.type)) return { error: '只支持 jpg/png/webp/gif/avif/ico 图片' };
  if (f.size > maxBytes) return { error: '图片过大（限 10MB）' };
  const ext = ((f.name || '').match(/\.[a-z0-9]{1,5}$/i) || [''])[0].toLowerCase();
  const key = prefix + Date.now() + ext;
  await c.env.KV.put(key, await f.arrayBuffer(), { metadata: { type: f.type } });
  return { key };
}
app.post('/api/upload', auth, async c => {
  const r = await saveImage(c, 'logo', '', MAX_IMG);
  return r.error ? c.json({ error: r.error }, 400) : c.json({ filename: r.key, url: '/uploads/' + r.key });
});
app.get('/uploads/:name', async c => {
  const { value, metadata } = await c.env.KV.getWithMetadata(c.req.param('name'), 'arrayBuffer');
  if (!value) return c.notFound();
  return new Response(value, {
    headers: { 'Content-Type': (metadata && metadata.type) || MIME[(c.req.param('name').split('.').pop() || '').toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' }
  });
});

// ---------- 壁纸 ----------
async function getWp(c) {
  try { return JSON.parse((await first(c, "SELECT value FROM settings WHERE key='wallpaper'")).value); }
  catch (e) { return { url: '', file: '' }; }
}
const setWp = (c, v) => run(c, "INSERT INTO settings (key,value) VALUES ('wallpaper',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(v));
const dropOld = async (c, w) => { if (w.file) await c.env.KV.delete(w.file); };
app.get('/api/wallpaper', async c => { c.header('Cache-Control', 'no-store'); return c.json({ url: (await getWp(c)).url || '' }); });
app.post('/api/wallpaper/url', auth, async c => {
  const url = String((await body(c)).url || '').trim();
  if (!/^https?:\/\//i.test(url) || /["'()\\\s<>]/.test(url)) return c.json({ error: 'URL 无效（需 http/https 开头，且不能含空格、引号、括号）' }, 400);
  await dropOld(c, await getWp(c));
  await setWp(c, { url, file: '' });
  return c.json({ url });
});
app.post('/api/wallpaper/upload', auth, async c => {
  const r = await saveImage(c, 'wallpaper', 'wallpaper-', MAX_IMG);
  if (r.error) return c.json({ error: r.error }, 400);
  await dropOld(c, await getWp(c));
  const url = '/uploads/' + r.key;
  await setWp(c, { url, file: r.key });
  return c.json({ url });
});
app.delete('/api/wallpaper', auth, async c => {
  await dropOld(c, await getWp(c));
  await setWp(c, { url: '', file: '' });
  return c.json({ url: '' });
});

// ---------- 书签导入导出 ----------
const escapeHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function decodeEntities(s) {
  return String(s || '').replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
}
function safeUrl(u, { allowRelative = false } = {}) {
  if (typeof u !== 'string') return '';
  const v = u.trim();
  if (!v) return '';
  if (allowRelative && v.startsWith('/') && !v.startsWith('//')) return v;
  return /^(https?|ftp):\/\//i.test(v) ? v : '';
}
const clip = (s, len) => String(s == null ? '' : s).trim().slice(0, len);

async function loadTree(c) {
  const menus = await all(c, 'SELECT id, name, "order" FROM menus ORDER BY "order", id');
  const subs = await all(c, 'SELECT id, parent_id, name, "order" FROM sub_menus ORDER BY "order", id');
  const cards = await all(c, 'SELECT menu_id, sub_menu_id, title, url, logo_url, custom_logo_path, "desc", "order" FROM cards ORDER BY "order", id');
  const toCard = x => ({ title: x.title, url: x.url, logo_url: x.logo_url || '', custom_logo_path: x.custom_logo_path || '', desc: x.desc || '', order: x.order || 0 });
  return menus.map(m => ({
    name: m.name, order: m.order || 0,
    cards: cards.filter(x => x.menu_id === m.id && !x.sub_menu_id).map(toCard),
    subMenus: subs.filter(s => s.parent_id === m.id).map(s => ({ name: s.name, order: s.order || 0, cards: cards.filter(x => x.sub_menu_id === s.id).map(toCard) }))
  }));
}
function toNetscapeHtml(menus) {
  const link = x => `<DT><A HREF="${escapeHtml(x.url)}">${escapeHtml(x.title || x.url)}</A>` + (x.desc ? `\n<DD>${escapeHtml(x.desc)}` : '');
  const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<!-- This is an automatically generated file. -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', '<TITLE>Bookmarks</TITLE>', '<H1>Bookmarks</H1>', '<DL><p>'];
  menus.forEach(m => {
    lines.push(`    <DT><H3>${escapeHtml(m.name)}</H3>`, '    <DL><p>');
    m.cards.forEach(x => lines.push('        ' + link(x)));
    m.subMenus.forEach(s => {
      lines.push(`        <DT><H3>${escapeHtml(s.name)}</H3>`, '        <DL><p>');
      s.cards.forEach(x => lines.push('            ' + link(x)));
      lines.push('        </DL><p>');
    });
    lines.push('    </DL><p>');
  });
  lines.push('</DL><p>');
  return lines.join('\n');
}
app.get('/api/bookmarks/export', auth, async c => {
  const menus = await loadTree(c);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (c.req.query('format') === 'html') {
    return new Response(toNetscapeHtml(menus), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': `attachment; filename="nav-bookmarks-${stamp}.html"` } });
  }
  return new Response(JSON.stringify({ type: 'nav-bookmarks', version: 1, exported_at: new Date().toISOString(), menus }, null, 2),
    { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="nav-bookmarks-${stamp}.json"` } });
});
function parseNetscapeHtml(html) {
  const result = new Map();
  const ensureMenu = name => { if (!result.has(name)) result.set(name, { name, order: 0, cards: [], subMenus: new Map() }); return result.get(name); };
  const lower = html.toLowerCase();
  const stack = [];
  let pending = null, m;
  const re = /<(\/?)(h3|dl|a)\b([^>]*)>/gi;
  while ((m = re.exec(html))) {
    const closing = m[1] === '/', tag = m[2].toLowerCase();
    if (tag === 'h3' && !closing) {
      const close = lower.indexOf('</h3', re.lastIndex);
      pending = decodeEntities(html.slice(re.lastIndex, close === -1 ? undefined : close));
    } else if (tag === 'dl') {
      if (closing) stack.pop(); else { stack.push(pending); pending = null; }
    } else if (tag === 'a' && !closing) {
      const close = lower.indexOf('</a', re.lastIndex);
      const title = decodeEntities(html.slice(re.lastIndex, close === -1 ? undefined : close));
      const hm = /href\s*=\s*"([^"]*)"/i.exec(m[3]) || /href\s*=\s*'([^']*)'/i.exec(m[3]);
      if (!hm) continue;
      const card = { title, url: decodeEntities(hm[1]) };
      const path = stack.filter(Boolean);
      const menu = ensureMenu(path[0] || '导入书签');
      if (path.length >= 2) {
        if (!menu.subMenus.has(path[1])) menu.subMenus.set(path[1], { name: path[1], order: 0, cards: [] });
        menu.subMenus.get(path[1]).cards.push(card);
      } else menu.cards.push(card);
    }
  }
  return [...result.values()].map(mn => ({ ...mn, subMenus: [...mn.subMenus.values()] }));
}
function parseJson(text) {
  const data = JSON.parse(text);
  const menus = Array.isArray(data) ? data : data && data.menus;
  if (!Array.isArray(menus)) throw new Error('JSON 格式不正确：缺少 menus 数组');
  return menus;
}
// 为避开 D1 单次请求的查询数量限制：先一次性读入现有数据，卡片用 batch 批量写入
async function importTree(c, menus) {
  const stats = { menus_added: 0, submenus_added: 0, cards_added: 0, cards_skipped: 0 };
  const allMenus = await all(c, 'SELECT id, name, "order" FROM menus');
  const allSubs = await all(c, 'SELECT id, parent_id, name, "order" FROM sub_menus');
  const allCards = await all(c, 'SELECT menu_id, sub_menu_id, url, "order" FROM cards');
  const mx = arr => arr.reduce((a, x) => Math.max(a, x.order || 0), 0);
  const stmts = [];
  const addCards = (cards, menuId, subId) => {
    if (!Array.isArray(cards)) return;
    const ex = allCards.filter(x => subId ? x.sub_menu_id === subId : (x.menu_id === menuId && !x.sub_menu_id));
    const urls = new Set(ex.map(x => x.url.trim().replace(/\/+$/, '')));
    let order = mx(ex);
    for (const x of cards) {
      const url = safeUrl(x && x.url);
      if (!url) { stats.cards_skipped++; continue; }
      const key = url.replace(/\/+$/, '');
      if (urls.has(key)) { stats.cards_skipped++; continue; }
      urls.add(key); order += 1;
      stmts.push(stmt(c, 'INSERT INTO cards (menu_id,sub_menu_id,title,url,logo_url,custom_logo_path,"desc","order") VALUES (?,?,?,?,?,?,?,?)',
        [menuId, subId || null, clip(x.title, 200) || url, url, safeUrl(x.logo_url, { allowRelative: true }) || null,
          clip(x.custom_logo_path, 300).replace(/\.\./g, '') || null, clip(x.desc, 500) || null, order]));
      stats.cards_added++;
    }
  };
  for (const m of menus) {
    const name = clip(m && m.name, 100);
    if (!name) continue;
    let menu = allMenus.find(x => x.name === name);
    if (!menu) {
      const order = mx(allMenus) + 1;
      menu = { id: (await run(c, 'INSERT INTO menus (name,"order") VALUES (?,?)', name, order)).meta.last_row_id, name, order };
      allMenus.push(menu); stats.menus_added++;
    }
    addCards(m.cards, menu.id, null);
    for (const s of Array.isArray(m.subMenus) ? m.subMenus : []) {
      const sname = clip(s && s.name, 100);
      if (!sname) continue;
      let sub = allSubs.find(x => x.parent_id === menu.id && x.name === sname);
      if (!sub) {
        const order = mx(allSubs.filter(x => x.parent_id === menu.id)) + 1;
        sub = { id: (await run(c, 'INSERT INTO sub_menus (parent_id,name,"order") VALUES (?,?,?)', menu.id, sname, order)).meta.last_row_id, parent_id: menu.id, name: sname, order };
        allSubs.push(sub); stats.submenus_added++;
      }
      addCards(s.cards, menu.id, sub.id);
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await c.env.DB.batch(stmts.slice(i, i + 50));
  return stats;
}
app.post('/api/bookmarks/import', auth, async c => {
  const { content, type } = await body(c);
  if (typeof content !== 'string' || !content.trim()) return c.json({ error: '文件内容为空' }, 400);
  let menus;
  try {
    const isHtml = type === 'html' || (type !== 'json' && /^\s*</.test(content));
    menus = isHtml ? parseNetscapeHtml(content) : parseJson(content);
  } catch (e) { return c.json({ error: '文件解析失败：' + e.message }, 400); }
  if (!menus.length) return c.json({ error: '没有识别到任何书签' }, 400);
  try { return c.json({ success: true, ...(await importTree(c, menus)) }); }
  catch (e) { return c.json({ error: '导入失败：' + e.message }, 500); }
});

export default app;
