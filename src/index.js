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
      // 已初始化过就直接跳过建表（避免每个冷启动实例都跑一遍 11 条 DDL，导致首个请求很慢）
      const done = await env.DB.prepare("SELECT 1 AS x FROM settings WHERE key='seeded'").first().catch(() => null);
      if (done) return;
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

// ---------- 操作日志（谁、什么时间、什么 IP、改了什么） ----------
let auditReady = null;
const ensureAudit = env => auditReady || (auditReady = env.DB.batch([
  env.DB.prepare('CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, username TEXT, ip TEXT, action TEXT NOT NULL, detail TEXT)'),
  env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts)')
]).catch(e => { auditReady = null; throw e; }));
const clientIp = c => c.req.header('cf-connecting-ip') || (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || '';
const AUDIT_TABLES = { cards: ['卡片', 'cards', 'title'], menus: ['分类', 'menus', 'name'], submenus: ['子分类', 'sub_menus', 'name'], ads: ['广告', 'ads', 'url'], friends: ['友链', 'friends', 'title'] };
const AUDIT_FIELDS = { menu_id: '所属分类ID', sub_menu_id: '子分类ID', parent_id: '父分类ID', title: '标题', name: '名称', url: '链接', logo_url: '图标', logo: '图标', img: '图片', desc: '描述', order: '排序', position: '位置', text: '版权文字', link_text: '链接文字', admin_text: '后台版权文字', admin_link_text: '后台链接文字', admin_url: '后台链接' };
const aclip = (v, n = 80) => { v = v == null ? '' : String(v); return v.length > n ? v.slice(0, n) + '…' : v; };
const diffFields = (o, nw) => {
  const out = [];
  for (const k of Object.keys(AUDIT_FIELDS)) {
    if (!(k in nw) || !(k in o)) continue;
    const a = o[k] == null ? '' : String(o[k]), b = nw[k] == null ? '' : String(nw[k]);
    if (a !== b) out.push(`${AUDIT_FIELDS[k]}：${aclip(a) || '（空）'} → ${aclip(b) || '（空）'}`);
  }
  return out;
};
// 解析接口 → { action, table?, id? }
function auditRoute(method, path) {
  let m;
  if (method === 'POST' && path === '/api/login') return { action: '登录' };
  if (path === '/api/users/password') return { action: '修改登录密码' };
  if ((m = /^\/api\/menus\/submenus\/(\d+)\/password$/.exec(path))) return { action: '设置/清除子分类密码', table: 'submenus', id: m[1] };
  if ((m = /^\/api\/menus\/(\d+)\/password$/.exec(path))) return { action: '设置/清除分类密码', table: 'menus', id: m[1] };
  if ((m = /^\/api\/menus\/(\d+)\/submenus$/.exec(path)) && method === 'POST') return { action: '新增子分类', table: 'submenus', parent: m[1] };
  if ((m = /^\/api\/(cards|menus|ads|friends)(?:\/(\d+))?$/.exec(path)) || (m = /^\/api\/menus\/(submenus)\/(\d+)$/.exec(path))) {
    const t = AUDIT_TABLES[m[1]], v = { POST: '新增', PUT: '修改', DELETE: '删除' }[method];
    if (v) return { action: v + t[0], table: m[1], id: m[2] };
  }
  if (path === '/api/footer') return { action: method === 'DELETE' ? '恢复默认页脚' : '修改页脚', footer: true };
  if (path === '/api/wallpaper/url') return { action: '修改壁纸（URL）' };
  if (path === '/api/wallpaper/upload') return { action: '上传壁纸' };
  if (path === '/api/wallpaper' && method === 'DELETE') return { action: '恢复默认壁纸' };
  if (path === '/api/upload') return { action: '上传图片' };
  if (path === '/api/bookmarks/import') return { action: '导入书签/数据' };
  if (path === '/api/backup/config') return { action: '修改备份设置' };
  if (path === '/api/backup/run') return { action: '立即备份' };
  if (path === '/api/backup/restore') return { action: '恢复备份' };
  if (path === '/api/backup/file' && method === 'DELETE') return { action: '删除备份文件' };
  if (path === '/api/backup/webdav/test') return { action: '测试 WebDAV 连接' };
  if (path === '/api/logs' && method === 'DELETE') return { action: '清空操作日志' };
  return { action: method + ' ' + path };
}
app.use('/api/*', async (c, next) => {
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || path.startsWith('/api/backup/cron') || path === '/api/menus/verify-password') return next();
  const info = auditRoute(method, path);
  let nw = null, old = null;
  const big = path === '/api/backup/restore' || path === '/api/bookmarks/import';
  try {
    if (!big && (c.req.header('content-type') || '').includes('json')) nw = await c.req.raw.clone().json();
    if (nw && typeof nw !== 'object') nw = null;
    if (info.footer) old = await getFooter(c);
    else if (info.table && info.id && (method === 'PUT' || method === 'DELETE') && !path.endsWith('/password')) {
      await ensureAudit(c.env);
      old = await first(c, `SELECT * FROM ${AUDIT_TABLES[info.table][1]} WHERE id=?`, info.id);
    }
  } catch (e) {}
  await next();
  try {
    const status = c.res.status;
    const isLogin = path === '/api/login';
    if (status >= 400 && !isLogin) return;
    const u = c.get('user');
    let username = u && u.username ? u.username : '';
    let action = info.action, detail = '';
    if (isLogin) { username = aclip(nw && nw.username, 60); if (status >= 400) action = '登录失败'; }
    else if (info.table) {
      const t = AUDIT_TABLES[info.table];
      const label = (old && old[t[2]]) || (nw && nw[t[2]]) || '';
      const parts = [];
      if (info.id) parts.push(`${t[0]} #${info.id}`);
      if (label) parts.push(`「${aclip(label, 60)}」`);
      if (info.parent) parts.push(`父分类 #${info.parent}`);
      detail = parts.join(' ');
      if (method === 'PUT' && old && nw && !path.endsWith('/password')) { const d = diffFields(old, nw); detail += d.length ? '；' + d.join('；') : '；无字段变化'; }
      else if (method === 'POST' && nw) detail += (detail ? '；' : '') + diffFields({ ...Object.fromEntries(Object.keys(AUDIT_FIELDS).map(k => [k, ''])) }, nw).join('；');
      else if (method === 'DELETE' && old) detail += '；' + Object.keys(AUDIT_FIELDS).filter(k => k in old && old[k] != null && old[k] !== '').slice(0, 4).map(k => `${AUDIT_FIELDS[k]}：${aclip(old[k], 60)}`).join('；');
    } else if (info.footer) {
      if (method === 'PUT' && old && nw) { const d = diffFields(old, nw); detail = d.length ? d.join('；') : '无字段变化'; }
    } else if (path === '/api/wallpaper/url' && nw) detail = aclip(nw.url, 200);
    else if (path === '/api/backup/restore' && nw) detail = '来源：' + aclip(nw.source, 20) + (nw.name ? ' / ' + aclip(nw.name, 60) : '');
    await ensureAudit(c.env);
    const task = run(c, 'INSERT INTO audit_logs (ts,username,ip,action,detail) VALUES (?,?,?,?,?)', Date.now(), username, clientIp(c), action, aclip(detail, 600))
      .then(() => { if (Math.random() < 0.02) return run(c, 'DELETE FROM audit_logs WHERE id <= (SELECT MAX(id) FROM audit_logs) - 5000'); })
      .catch(() => {});
    try { c.executionCtx.waitUntil(task); } catch (e) { await task; }
  } catch (e) {}
});

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

// 管理员（带有效登录 token 且显式 ?admin=1）可查看加密分类下的卡片，用于后台管理
async function isAdminReq(c) {
  if (c.req.query('admin') !== '1') return false;
  const h = c.req.header('Authorization') || '';
  if (!h.startsWith('Bearer ')) return false;
  try {
    const p = await verify(h.slice(7), await jwtSecret(c), 'HS256');
    return !(p.kind || p.typ);
  } catch (e) { return false; }
}

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
  const admin = await isAdminReq(c);
  const tokens = admin ? [] : await unlockTokens(c);
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
    if (!admin && (!isUnlocked(tokens, 'menu', row.parent_id, row.menu_hash) || !isUnlocked(tokens, 'submenu', row.id, row.sub_hash))) return locked();
    return send('SELECT * FROM cards WHERE sub_menu_id=? ORDER BY "order"', row.id);
  }
  const row = await first(c, 'SELECT id, password_hash FROM menus WHERE id=?', Number(c.req.param('menuId')));
  if (!row) return c.json({ error: '分类不存在' }, 404);
  if (!admin && !isUnlocked(tokens, 'menu', row.id, row.password_hash)) return locked();
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
  const nm = c.req.param('name');
  if (nm.includes('/') || nm.startsWith('__')) return c.notFound(); // 备份存档不对外公开
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

// ---------- 操作日志查询 / 清空 ----------
app.get('/api/logs', auth, async c => {
  await ensureAudit(c.env);
  const page = Math.max(1, parseInt(c.req.query('page')) || 1);
  const size = Math.min(100, Math.max(1, parseInt(c.req.query('pageSize')) || 20));
  const q = (c.req.query('q') || '').trim().slice(0, 60);
  const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
  const where = q ? " WHERE (username LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')" : '';
  const args = q ? [like, like, like, like] : [];
  const total = (await first(c, 'SELECT COUNT(*) AS total FROM audit_logs' + where, ...args)).total;
  const data = await all(c, 'SELECT id, ts, username, ip, action, detail FROM audit_logs' + where + ' ORDER BY id DESC LIMIT ? OFFSET ?', ...args, size, (page - 1) * size);
  return c.json({ total, page, pageSize: size, data });
});
app.delete('/api/logs', auth, async c => {
  await ensureAudit(c.env);
  await run(c, 'DELETE FROM audit_logs');
  return c.json({ success: true });
});

// ---------- 页脚版权（文字 + 链接，可在后台自定义） ----------
const FOOTER_DEFAULT = { text: 'Copyright © 2026  |   ', link_text: '龍哥博客', url: 'https://bk0.at8.ccwu.cc/', admin_text: 'Copyright © 2025 Nav-Item | ', admin_link_text: 'Powered by eooce', admin_url: 'https://github.com/eooce/Nav-Item' };
const badUrl = u => u && (!/^https?:\/\//i.test(u) || u.length > 500 || /[\s"'<>\\]/.test(u));
const cleanFooter = v => {
  v = v && typeof v === 'object' ? v : {};
  const pick = (k, max, trim) => { let x = v[k] == null ? (k.startsWith('admin_') ? FOOTER_DEFAULT[k] : '') : String(v[k]); if (trim) x = x.trim(); return x.slice(0, max); };
  const out = { text: pick('text', 200), link_text: pick('link_text', 100, 1), url: pick('url', 600, 1), admin_text: pick('admin_text', 200), admin_link_text: pick('admin_link_text', 100, 1), admin_url: pick('admin_url', 600, 1) };
  if (badUrl(out.url) || badUrl(out.admin_url)) return { error: '链接 URL 无效（需 http:// 或 https:// 开头，不超过 500 字，且不能含空格、引号、尖括号）' };
  return out;
};
async function getFooter(c) {
  try { const r = await first(c, "SELECT value FROM settings WHERE key='footer'"); if (r && r.value) { const f = cleanFooter(JSON.parse(r.value)); if (!f.error) return f; } } catch (e) {}
  return { ...FOOTER_DEFAULT };
}
app.get('/api/footer', async c => { c.header('Cache-Control', 'no-store'); return c.json(await getFooter(c)); });
app.put('/api/footer', auth, async c => {
  const f = cleanFooter(await body(c));
  if (f.error) return c.json({ error: f.error }, 400);
  await run(c, "INSERT INTO settings (key,value) VALUES ('footer',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(f));
  return c.json(f);
});
app.delete('/api/footer', auth, async c => {
  await run(c, "DELETE FROM settings WHERE key='footer'");
  return c.json({ ...FOOTER_DEFAULT });
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

// ================= 备份 / 恢复：本地下载 · WebDAV · 站内存档(KV) · 自动备份 =================
// 说明：Cloudflare Pages 没有内置定时器，自动备份采用「到点后的第一次访问触发」+ 可选的外部 Cron 地址（/api/backup/cron）。
// 备份内容：栏目、子栏目、卡片、广告、友链、壁纸设置（含栏目密码哈希）；不含用户账号。可选打包 KV 里的图片。
const BJ = 8 * 3600e3, DAY = 86400e3, KVP = '__backup__/';
const NAME_RE = /^nav-backup-[0-9A-Za-z-]{1,40}\.json$/;
const pad = x => String(x).padStart(2, '0');
const bjDate = ts => new Date(ts + BJ);
const stampOf = ts => { const d = bjDate(ts); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`; };
const bytesB64 = buf => { const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const toInt = v => { if (v == null || v === '') return null; const x = Number(v); return Number.isSafeInteger(x) ? x : null; };
const str = (v, len) => (typeof v === 'string' && v.length <= len ? v : null);
const putSetting = (c, k, v) => run(c, 'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v);
const drain = r => { try { if (r.body) r.body.cancel().catch(() => {}); } catch (e) {} };

// ---------- 配置 / 状态（存放在 settings 表） ----------
const DEF_CFG = () => ({
  webdav: { url: '', username: '', password: '', dir: 'nav-backup' },
  auto: { enabled: false, mode: 'daily', intervalHours: 24, time: '03:00', weekday: 1, targets: ['kv'], includeImages: false, keep: 7 },
  cron_token: ''
});
async function getCfg(c) {
  let s = {};
  try { s = JSON.parse((await first(c, "SELECT value FROM settings WHERE key='backup_config'")).value) || {}; } catch (e) {}
  const d = DEF_CFG();
  return { webdav: { ...d.webdav, ...s.webdav }, auto: { ...d.auto, ...s.auto }, cron_token: s.cron_token || '' };
}
const saveCfg = (c, v) => putSetting(c, 'backup_config', JSON.stringify(v));
async function getState(c) {
  try { return JSON.parse((await first(c, "SELECT value FROM settings WHERE key='backup_state'")).value) || {}; } catch (e) { return {}; }
}
const saveState = (c, v) => putSetting(c, 'backup_state', JSON.stringify(v));
async function pushHist(c, entry) {
  const st = await getState(c);
  st.history = [{ t: Date.now(), ...entry }, ...(st.history || [])].slice(0, 15);
  await saveState(c, st);
}

// WebDAV 密码加密保存（AES-GCM，密钥由 JWT 密钥派生）
async function aesKey(c) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode('nav-backup:' + (await jwtSecret(c))));
  return crypto.subtle.importKey('raw', h, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encPw(c, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(c), enc.encode(text));
  return `enc1$${b64(iv)}$${bytesB64(ct)}`;
}
async function decPw(c, v) {
  if (!v) return '';
  if (!v.startsWith('enc1$')) return v;
  const [, iv, ct] = v.split('$');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(c), unb64(ct)));
}

// ---------- 定时规则（时间一律按北京时间 UTC+8） ----------
const baseOf = st => Math.max(st.last_attempt || 0, st.anchor || 0);
function prevSched(now, a) {
  const [h, m] = a.time.split(':').map(Number), d = bjDate(now);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m) - BJ;
  if (t > now) t -= DAY;
  if (a.mode === 'weekly') for (let i = 0; i < 7 && bjDate(t).getUTCDay() !== a.weekday; i++) t -= DAY;
  return t;
}
function isDue(a, st, now) {
  // 自动备份失败后 30 分钟重试，最多连续 3 次
  if (st.last_ok === false && st.last_trigger === 'auto' && (st.fails || 0) < 3 && now - (st.last_attempt || 0) >= 30 * 60e3) return true;
  const base = baseOf(st);
  if (a.mode === 'interval') return now - base >= a.intervalHours * 3600e3;
  return base < prevSched(now, a);
}
function nextRun(a, st, now) {
  const base = baseOf(st);
  if (a.mode === 'interval') return base + a.intervalHours * 3600e3;
  const p = prevSched(now, a);
  return base < p ? p : p + (a.mode === 'weekly' ? 7 : 1) * DAY;
}

// ---------- WebDAV 客户端 ----------
async function davConf(c, o = {}) {
  const w = (await getCfg(c)).webdav;
  const url = String(o.url !== undefined ? o.url : w.url).trim();
  const username = String(o.username !== undefined ? o.username : w.username);
  const dir = String(o.dir !== undefined ? o.dir : w.dir);
  let pw = '';
  if (o.password) pw = String(o.password);
  else { try { pw = await decPw(c, w.password); } catch (e) { throw new Error('已保存的 WebDAV 密码无法解密，请重新填写密码并保存'); } }
  if (!/^https?:\/\//i.test(url)) throw new Error('请先填写 WebDAV 地址（以 http:// 或 https:// 开头）');
  const segs = dir.replace(/\\/g, '/').split('/').map(s => s.trim()).filter(s => s && s !== '.' && s !== '..');
  return { base: url.replace(/\/+$/, ''), dirPath: segs.map(encodeURIComponent).join('/'), segs, auth: 'Basic ' + bytesB64(enc.encode(username + ':' + pw)) };
}
const davPath = (conf, name) => [conf.dirPath, name && encodeURIComponent(name)].filter(Boolean).join('/');
async function dav(conf, method, path, opt = {}) {
  const r = await fetch(conf.base + (path ? '/' + path : ''), { method, body: opt.body, headers: { Authorization: conf.auth, ...(opt.headers || {}) }, signal: AbortSignal.timeout(30000) });
  if (r.status === 401) { drain(r); throw new Error('WebDAV 认证失败（401），请检查用户名和密码（坚果云等需使用「应用密码」）'); }
  return r;
}
async function davEnsure(conf) {
  let p = '';
  for (const s of conf.segs) { p += (p ? '/' : '') + encodeURIComponent(s); drain(await dav(conf, 'MKCOL', p)); }
}
async function davPut(conf, name, bytes) {
  const r = await dav(conf, 'PUT', davPath(conf, name), { body: bytes, headers: { 'Content-Type': 'application/json' } });
  drain(r);
  if (![200, 201, 204].includes(r.status)) throw new Error(`WebDAV 上传失败（HTTP ${r.status}${r.status === 507 ? '，空间不足' : r.status === 403 || r.status === 405 ? '，无写入权限或目录不存在' : ''}）`);
}
async function davGet(conf, name) {
  const r = await dav(conf, 'GET', davPath(conf, name));
  if (!r.ok) { drain(r); throw new Error(`WebDAV 读取失败（HTTP ${r.status}）`); }
  return r.text();
}
async function davDel(conf, name) {
  const r = await dav(conf, 'DELETE', davPath(conf, name));
  drain(r);
  if (![200, 202, 204, 404].includes(r.status)) throw new Error(`WebDAV 删除失败（HTTP ${r.status}）`);
}
async function davList(conf) {
  const r = await dav(conf, 'PROPFIND', davPath(conf), {
    headers: { Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>'
  });
  if (r.status === 404) { drain(r); return []; }
  if (r.status !== 207 && !r.ok) { drain(r); throw new Error(`WebDAV 列表失败（HTTP ${r.status}）`); }
  const xml = await r.text(), items = [];
  for (const m of xml.matchAll(/<(?:\w+:)?response\b[\s\S]*?<\/(?:\w+:)?response>/gi)) {
    const blk = m[0];
    const href = (/<(?:\w+:)?href[^>]*>([\s\S]*?)<\/(?:\w+:)?href>/i.exec(blk) || [])[1] || '';
    let nm; try { nm = decodeURIComponent(href.trim().replace(/\/+$/, '').split('/').pop()); } catch (e) { continue; }
    if (!NAME_RE.test(nm)) continue;
    const size = +((/<(?:\w+:)?getcontentlength[^>]*>\s*(\d+)\s*</i.exec(blk) || [])[1] || 0);
    const lm = (/<(?:\w+:)?getlastmodified[^>]*>([^<]+)</i.exec(blk) || [])[1];
    items.push({ name: nm, size, time: lm ? Date.parse(lm) || 0 : 0 });
  }
  return items.sort((a, b) => (a.name < b.name ? 1 : -1));
}
async function pruneDav(conf, keep) {
  const l = (await davList(conf)).filter(x => !x.name.includes('pre-restore'));
  for (const x of l.slice(keep)) await davDel(conf, x.name).catch(() => {});
}

// ---------- 站内存档（KV，前缀 __backup__/，不会通过 /uploads 对外暴露） ----------
async function kvList(c) {
  if (!c.env.KV) throw new Error('未绑定 KV');
  const r = await c.env.KV.list({ prefix: KVP, limit: 1000 });
  return r.keys.map(k => ({ name: k.name.slice(KVP.length), size: (k.metadata && k.metadata.size) || 0, time: (k.metadata && k.metadata.time) || 0 }))
    .filter(x => NAME_RE.test(x.name)).sort((a, b) => (a.name < b.name ? 1 : -1));
}
async function pruneKv(c, keep, only) {
  const l = (await kvList(c)).filter(x => x.name.includes('pre-restore') === !!only);
  for (const x of l.slice(keep)) await c.env.KV.delete(KVP + x.name).catch(() => {});
}

// ---------- 生成备份 ----------
const IMG_KEY = /^[A-Za-z0-9._-]{1,120}$/;
async function buildBackup(c, { images = false } = {}) {
  const tables = {
    menus: await all(c, 'SELECT id, name, "order", password_hash FROM menus ORDER BY id'),
    sub_menus: await all(c, 'SELECT id, parent_id, name, "order", password_hash FROM sub_menus ORDER BY id'),
    cards: await all(c, 'SELECT id, menu_id, sub_menu_id, title, url, logo_url, custom_logo_path, "desc", "order" FROM cards ORDER BY id'),
    ads: await all(c, 'SELECT id, position, img, url FROM ads ORDER BY id'),
    friends: await all(c, 'SELECT id, title, url, logo FROM friends ORDER BY id')
  };
  const wp = await first(c, "SELECT value FROM settings WHERE key='wallpaper'");
  const ft = await first(c, "SELECT value FROM settings WHERE key='footer'");
  const out = { type: 'nav-backup', version: 2, created_at: new Date().toISOString(), includes_images: !!images, tables, settings: { wallpaper: wp ? wp.value : null, footer: ft ? ft.value : null } };
  if (images && c.env.KV) {
    const keys = new Set();
    const scan = s => { for (const m of String(s || '').matchAll(/\/uploads\/([A-Za-z0-9._-]{1,120})/g)) keys.add(m[1]); };
    tables.cards.forEach(x => { if (x.custom_logo_path) keys.add(String(x.custom_logo_path)); scan(x.logo_url); });
    tables.ads.forEach(x => scan(x.img));
    tables.friends.forEach(x => scan(x.logo));
    scan(wp && wp.value);
    const files = {}; let total = 0, skipped = 0;
    for (const k of keys) {
      if (!IMG_KEY.test(k) || k.startsWith('__')) continue;
      if (Object.keys(files).length >= 60 || total > 25 * 1024 * 1024) { skipped++; continue; }
      const { value, metadata } = await c.env.KV.getWithMetadata(k, 'arrayBuffer');
      if (!value) continue;
      total += value.byteLength;
      files[k] = { type: (metadata && metadata.type) || MIME[(k.split('.').pop() || '').toLowerCase()] || 'application/octet-stream', data: bytesB64(value) };
    }
    out.files = files; out.files_skipped = skipped;
  }
  return out;
}

async function runBackup(c, { targets, images, trigger }) {
  const keep = (await getCfg(c)).auto.keep;
  const bytes = enc.encode(JSON.stringify(await buildBackup(c, { images })));
  const name = `nav-backup-${stampOf(Date.now())}${trigger === 'auto' ? '-auto' : ''}.json`;
  const results = [];
  for (const t of targets) {
    try {
      if (t === 'webdav') {
        const conf = await davConf(c);
        await davEnsure(conf);
        await davPut(conf, name, bytes);
        if (keep > 0) await pruneDav(conf, keep).catch(() => {});
        results.push({ target: 'webdav', ok: true, msg: '成功' });
      } else if (t === 'kv') {
        if (!c.env.KV) throw new Error('未绑定 KV');
        await c.env.KV.put(KVP + name, bytes, { metadata: { size: bytes.length, time: Date.now() } });
        if (keep > 0) await pruneKv(c, keep).catch(() => {});
        results.push({ target: 'kv', ok: true, msg: '成功' });
      }
    } catch (e) { results.push({ target: t, ok: false, msg: e.message }); }
  }
  return { name, size: bytes.length, includes_images: !!images, results, ok: results.length > 0 && results.every(r => r.ok) };
}
const TGT = { webdav: 'WebDAV', kv: '站内存档' };
async function noteRun(c, trigger, out) {
  const now = Date.now(), st = await getState(c);
  const msg = out.results.map(r => `${TGT[r.target] || r.target}：${r.ok ? '成功' : r.msg}`).join('；');
  st.last_attempt = now; st.last_ok = out.ok; st.last_trigger = trigger; st.last_name = out.name; st.last_msg = msg;
  if (out.ok) { st.last_success = now; st.fails = 0; } else st.fails = (st.fails || 0) + 1;
  st.history = [{ t: now, trigger, ok: out.ok, name: out.name, size: out.size, msg }, ...(st.history || [])].slice(0, 15);
  await saveState(c, st);
}

// 并发锁：同一时刻只允许一个备份/恢复任务（10 分钟后自动过期）
async function claimLock(c) {
  const now = Date.now();
  const r = await run(c, "INSERT INTO settings (key,value) VALUES ('backup_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(settings.value AS INTEGER) < ?", String(now), now - 10 * 60e3);
  return r.meta.changes > 0;
}
const freeLock = c => run(c, "UPDATE settings SET value='0' WHERE key='backup_lock'").catch(() => {});

// ---------- 自动备份调度 ----------
let lastTick = 0;
async function autoTick(env, force = false) {
  const c = { env };
  const cfg = await getCfg(c);
  if (!cfg.auto.enabled && !force) return { skipped: 'disabled' };
  if (!force && !isDue(cfg.auto, await getState(c), Date.now())) return { skipped: 'not-due' };
  if (!(await claimLock(c))) return { skipped: 'busy' };
  try {
    if (!force && !isDue(cfg.auto, await getState(c), Date.now())) return { skipped: 'not-due' };
    const out = await runBackup(c, { targets: cfg.auto.targets.length ? cfg.auto.targets : ['kv'], images: cfg.auto.includeImages, trigger: 'auto' });
    await noteRun(c, 'auto', out);
    return out;
  } finally { await freeLock(c); }
}
// 任意 /api/* 请求结束后，最多每分钟检查一次是否到点（不拖慢响应）
app.use('/api/*', async (c, next) => {
  await next();
  const t = Date.now();
  if (t - lastTick < 60000 || c.req.path.startsWith('/api/backup')) return;
  lastTick = t;
  try { c.executionCtx.waitUntil(autoTick(c.env).catch(() => {})); } catch (e) {}
});

// ---------- 恢复 ----------
async function restoreBackup(c, data) {
  if (!data || data.type !== 'nav-backup' || !data.tables) throw new Error(data && data.type === 'nav-bookmarks' ? '这是「书签导出」文件，请使用顶部的「导入」按钮' : '不是有效的备份文件');
  const T = data.tables, arr = k => (Array.isArray(T[k]) ? T[k] : []);
  const stats = { menus: 0, sub_menus: 0, cards: 0, ads: 0, friends: 0, files: 0, skipped: 0 };
  const menus = [], subs = [], cards = [], ads = [], friends = [], mids = new Set(), sids = new Set();
  for (const r of arr('menus')) {
    const id = toInt(r && r.id), name = clip(r && r.name, 100);
    if (id == null || !name || mids.has(id)) { stats.skipped++; continue; }
    mids.add(id); menus.push([id, name, toInt(r.order) || 0, str(r.password_hash, 500)]);
  }
  for (const r of arr('sub_menus')) {
    const id = toInt(r && r.id), pid = toInt(r && r.parent_id), name = clip(r && r.name, 100);
    if (id == null || !name || !mids.has(pid) || sids.has(id)) { stats.skipped++; continue; }
    sids.add(id); subs.push([id, pid, name, toInt(r.order) || 0, str(r.password_hash, 500)]);
  }
  for (const r of arr('cards')) {
    const id = toInt(r && r.id), mid = toInt(r && r.menu_id), sid = toInt(r && r.sub_menu_id);
    const title = clip(r && r.title, 200), url = clip(r && r.url, 2000);
    if (id == null || !title || !url || (mid != null && !mids.has(mid)) || (sid != null && !sids.has(sid)) || (mid == null && sid == null)) { stats.skipped++; continue; }
    cards.push([id, mid, sid, title, url, clip(r.logo_url, 2000) || null, clip(r.custom_logo_path, 300).replace(/\.\./g, '') || null, clip(r.desc, 500) || null, toInt(r.order) || 0]);
  }
  for (const r of arr('ads')) {
    const id = toInt(r && r.id), pos = clip(r && r.position, 50), img = clip(r && r.img, 2000), url = clip(r && r.url, 2000);
    if (id == null || !pos || !img || !url) { stats.skipped++; continue; }
    ads.push([id, pos, img, url]);
  }
  for (const r of arr('friends')) {
    const id = toInt(r && r.id), title = clip(r && r.title, 200), url = clip(r && r.url, 2000);
    if (id == null || !title || !url) { stats.skipped++; continue; }
    friends.push([id, title, url, clip(r.logo, 2000) || null]);
  }
  // 先把当前数据存一份到站内存档，便于恢复错了回滚
  if (c.env.KV) {
    const snap = enc.encode(JSON.stringify(await buildBackup(c, { images: false })));
    await c.env.KV.put(`${KVP}nav-backup-pre-restore-${stampOf(Date.now())}.json`, snap, { metadata: { size: snap.length, time: Date.now() } });
    await pruneKv(c, 3, true).catch(() => {});
  }
  const S = [stmt(c, 'DELETE FROM cards'), stmt(c, 'DELETE FROM sub_menus'), stmt(c, 'DELETE FROM menus'), stmt(c, 'DELETE FROM ads'), stmt(c, 'DELETE FROM friends')];
  menus.forEach(p => S.push(stmt(c, 'INSERT INTO menus (id,name,"order",password_hash) VALUES (?,?,?,?)', p)));
  subs.forEach(p => S.push(stmt(c, 'INSERT INTO sub_menus (id,parent_id,name,"order",password_hash) VALUES (?,?,?,?,?)', p)));
  cards.forEach(p => S.push(stmt(c, 'INSERT INTO cards (id,menu_id,sub_menu_id,title,url,logo_url,custom_logo_path,"desc","order") VALUES (?,?,?,?,?,?,?,?,?)', p)));
  ads.forEach(p => S.push(stmt(c, 'INSERT INTO ads (id,position,img,url) VALUES (?,?,?,?)', p)));
  friends.forEach(p => S.push(stmt(c, 'INSERT INTO friends (id,title,url,logo) VALUES (?,?,?,?)', p)));
  for (let i = 0; i < S.length; i += 50) await c.env.DB.batch(S.slice(i, i + 50));
  Object.assign(stats, { menus: menus.length, sub_menus: subs.length, cards: cards.length, ads: ads.length, friends: friends.length });
  // 图片 → KV
  if (data.files && typeof data.files === 'object' && c.env.KV) {
    for (const [k, f] of Object.entries(data.files)) {
      if (!IMG_KEY.test(k) || k.startsWith('__') || !f || typeof f.data !== 'string' || !IMG.test(String(f.type))) continue;
      try { await c.env.KV.put(k, unb64(f.data), { metadata: { type: f.type } }); stats.files++; } catch (e) {}
    }
  }
  // 壁纸设置
  if (data.settings && 'wallpaper' in data.settings) {
    let w = { url: '', file: '' };
    try { const p = JSON.parse(data.settings.wallpaper); w = { url: String(p.url || ''), file: String(p.file || '') }; } catch (e) {}
    if (w.file && c.env.KV && !(await c.env.KV.list({ prefix: w.file, limit: 1 })).keys.some(k => k.name === w.file)) w = { url: '', file: '' };
    await setWp(c, w);
  }
  // 页脚设置
  if (data.settings && 'footer' in data.settings) {
    let f = null;
    try { f = cleanFooter(JSON.parse(data.settings.footer)); } catch (e) {}
    if (f && !f.error) await run(c, "INSERT INTO settings (key,value) VALUES ('footer',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(f));
  }
  return stats;
}
async function readBackupText(c, source, name) {
  if (!NAME_RE.test(String(name))) throw new Error('文件名不正确');
  if (source === 'kv') {
    if (!c.env.KV) throw new Error('未绑定 KV');
    const v = await c.env.KV.get(KVP + name);
    if (v == null) throw new Error('存档不存在');
    return v;
  }
  if (source === 'webdav') return davGet(await davConf(c), name);
  throw new Error('参数不正确');
}

// ---------- 接口（均需登录；cron 用专用 token） ----------
app.get('/api/backup/config', auth, async c => {
  const cfg = await getCfg(c);
  if (!cfg.cron_token) { cfg.cron_token = b64url(crypto.getRandomValues(new Uint8Array(24))); await saveCfg(c, cfg); }
  const st = await getState(c), now = Date.now();
  const { password, ...w } = cfg.webdav;
  return c.json({
    webdav: { ...w, has_password: !!password }, auto: cfg.auto, cron_token: cfg.cron_token, kvBound: !!c.env.KV, now,
    state: { ...st, next_run: cfg.auto.enabled ? nextRun(cfg.auto, st, now) : null }
  });
});
const b64url = buf => bytesB64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
app.put('/api/backup/config', auth, async c => {
  const b = await body(c), cur = await getCfg(c);
  const next = { cron_token: cur.cron_token, webdav: { ...cur.webdav }, auto: { ...cur.auto } };
  if (b.webdav) {
    const w = b.webdav, url = clip(w.url, 300);
    if (url && !/^https?:\/\//i.test(url)) return c.json({ error: 'WebDAV 地址需以 http:// 或 https:// 开头' }, 400);
    next.webdav.url = url; next.webdav.username = clip(w.username, 200); next.webdav.dir = clip(w.dir, 200);
    if (typeof w.password === 'string' && w.password) next.webdav.password = await encPw(c, w.password.slice(0, 200));
    if (w.clear_password) next.webdav.password = '';
  }
  if (b.auto) {
    const a = b.auto;
    const mode = ['interval', 'daily', 'weekly'].includes(a.mode) ? a.mode : 'daily';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(a.time || '03:00'))) return c.json({ error: '时间格式应为 HH:MM（如 03:30）' }, 400);
    const targets = [...new Set((Array.isArray(a.targets) ? a.targets : []).filter(t => t === 'webdav' || t === 'kv'))];
    next.auto = {
      enabled: !!a.enabled, mode, time: String(a.time || '03:00'),
      intervalHours: Math.min(720, Math.max(1, parseInt(a.intervalHours) || 24)),
      weekday: Math.min(6, Math.max(0, parseInt(a.weekday) || 0)),
      targets, includeImages: !!a.includeImages, keep: Math.min(200, Math.max(0, parseInt(a.keep) || 0))
    };
    if (next.auto.enabled && !targets.length) return c.json({ error: '请至少选择一个自动备份的保存位置' }, 400);
    if (next.auto.enabled && targets.includes('webdav') && !next.webdav.url) return c.json({ error: '自动备份选择了 WebDAV，请先填写 WebDAV 地址' }, 400);
    if (targets.includes('kv') && !c.env.KV) return c.json({ error: '未绑定 KV，无法使用站内存档' }, 400);
  }
  if (b.regen_token) next.cron_token = b64url(crypto.getRandomValues(new Uint8Array(24)));
  await saveCfg(c, next);
  const st = await getState(c); st.anchor = Date.now(); st.fails = 0; await saveState(c, st); // 改动设置后从此刻重新计时
  return c.json({ success: true });
});
app.post('/api/backup/webdav/test', auth, async c => {
  try {
    const conf = await davConf(c, (await body(c)).webdav || {});
    await davEnsure(conf);
    const probe = `.nav-backup-test-${Date.now()}.tmp`;
    await davPut(conf, probe, enc.encode('ok'));
    await davDel(conf, probe).catch(() => {});
    return c.json({ success: true, message: '连接成功，目录可写' });
  } catch (e) { return c.json({ success: false, error: e.message }, 400); }
});
app.get('/api/backup/download', auth, async c => {
  const snap = await buildBackup(c, { images: c.req.query('images') === '1' });
  return new Response(JSON.stringify(snap), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="nav-backup-${stampOf(Date.now())}.json"`, 'Cache-Control': 'no-store' } });
});
app.post('/api/backup/run', auth, async c => {
  const b = await body(c);
  const targets = [...new Set((Array.isArray(b.targets) ? b.targets : []).filter(t => t === 'webdav' || t === 'kv'))];
  if (!targets.length) return c.json({ error: '请选择保存位置' }, 400);
  if (!(await claimLock(c))) return c.json({ error: '已有备份/恢复任务在进行，请稍后再试' }, 409);
  try {
    const out = await runBackup(c, { targets, images: !!b.images, trigger: 'manual' });
    await noteRun(c, 'manual', out);
    return c.json(out);
  } catch (e) { return c.json({ error: e.message }, 500); } finally { await freeLock(c); }
});
app.get('/api/backup/list', auth, async c => {
  try {
    const s = c.req.query('source');
    if (s === 'webdav') return c.json({ data: await davList(await davConf(c)) });
    if (s === 'kv') return c.json({ data: await kvList(c) });
    return c.json({ error: '参数不正确' }, 400);
  } catch (e) { return c.json({ error: e.message }, 400); }
});
app.get('/api/backup/file', auth, async c => {
  try {
    const name = c.req.query('name');
    const text = await readBackupText(c, c.req.query('source'), name);
    return new Response(text, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' } });
  } catch (e) { return c.json({ error: e.message }, 400); }
});
app.delete('/api/backup/file', auth, async c => {
  try {
    const { source, name } = c.req.query();
    if (!NAME_RE.test(String(name))) return c.json({ error: '文件名不正确' }, 400);
    if (source === 'kv') { if (!c.env.KV) throw new Error('未绑定 KV'); await c.env.KV.delete(KVP + name); }
    else if (source === 'webdav') await davDel(await davConf(c), name);
    else return c.json({ error: '参数不正确' }, 400);
    return c.json({ success: true });
  } catch (e) { return c.json({ error: e.message }, 400); }
});
app.post('/api/backup/restore', auth, async c => {
  const b = await body(c);
  let text;
  try { text = b.source === 'upload' ? b.content : await readBackupText(c, b.source, b.name); } catch (e) { return c.json({ error: e.message }, 400); }
  let data;
  try { data = JSON.parse(text); } catch (e) { return c.json({ error: '备份文件不是有效的 JSON' }, 400); }
  if (!(await claimLock(c))) return c.json({ error: '已有备份/恢复任务在进行，请稍后再试' }, 409);
  try {
    const stats = await restoreBackup(c, data);
    await pushHist(c, { trigger: 'restore', ok: true, name: b.source === 'upload' ? '本地文件' : b.name, msg: `恢复：栏目 ${stats.menus}、子栏目 ${stats.sub_menus}、卡片 ${stats.cards}` });
    return c.json({ success: true, ...stats });
  } catch (e) { return c.json({ error: '恢复失败：' + e.message + (c.env.KV ? '（恢复前已自动存档当前数据，可在「站内存档」中找到 pre-restore 文件回滚）' : '') }, 500); }
  finally { await freeLock(c); }
});
// 外部定时服务（cron-job.org / UptimeRobot / 另建 Worker Cron）可定时访问：/api/backup/cron?token=xxx（加 &force=1 则立即备份）
app.all('/api/backup/cron', async c => {
  const cfg = await getCfg(c), tk = c.req.query('token') || c.req.header('x-cron-token') || '';
  if (!cfg.cron_token || !safeEq(String(tk), cfg.cron_token)) return c.json({ error: '无效的 token' }, 403);
  try { return c.json({ success: true, ...(await autoTick(c.env, c.req.query('force') === '1')) }); }
  catch (e) { return c.json({ error: e.message }, 500); }
});

export default app;
