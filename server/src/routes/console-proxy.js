// Same-origin embedded console: the panel serves the cloud-mail site's own
// frontend (index.html + assets + /api) under /api/site/console/:siteId/* on
// the PANEL origin, so the site code sees a same-origin iframe —
// localStorage('token') injection works and the user is logged in
// automatically.
//
// Why not a plain cross-origin iframe: browsers partition storage for
// third-party iframes, so the site inside could not read the token we set.
//
// Auth: the iframe cannot send the panel's JWT header, so the embed URL
// carries a short-lived HMAC key (issued by an authed endpoint). Loading it
// sets an HttpOnly cookie; subsequent asset/api proxy calls verify key or
// cookie — no anonymous access to the proxied admin API.
import db, { decrypt } from '../db/index.js';
import crypto from 'node:crypto';

const SECRET = process.env.PANEL_SECRET || 'change-me-in-production';
const EMBED_TTL_MS = 10 * 60 * 1000;
const COOKIE_TTL_S = 2 * 60 * 60;

const sign = (payload) =>
  crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

// payload: `${siteId}:${expiresAtMs}`  →  payload.signature
function makeKey(siteId, ttl = EMBED_TTL_MS) {
  const exp = Date.now() + ttl;
  const payload = `${siteId}:${exp}`;
  return `${payload}.${sign(payload)}`;
}

function checkKey(siteId, key) {
  if (!key) return false;
  const [payload, sig] = key.split('.');
  if (!payload || !sig) return false;
  const [id, exp] = payload.split(':');
  if (Number(id) !== Number(siteId)) return false;
  if (Number(exp) < Date.now()) return false;
  const expect = sign(payload);
  return sig.length === expect.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
}

function authorized(req, siteId) {
  if (checkKey(siteId, req.query.key)) return true;
  const cookie = (req.headers.cookie || '')
    .split(';').map(s => s.trim()).find(s => s.startsWith('cmconsole='));
  return checkKey(siteId, cookie?.slice('cmconsole='.length));
}

// top-level static roots/files referenced by the built index.html / app code
const STATIC_PREFIXES = ['assets', 'image', 'fonts', 'tinymce',
  'mail.png', 'mail-pwa.png', 'manifest.webmanifest', 'registerSW.js',
  'sw.js', 'workbox-', 'content.css'];

async function siteLogin(site) {
  const res = await fetch(`${site.base_url}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: site.admin_email, password: decrypt(site.admin_password_enc) })
  });
  const j = await res.json().catch(() => null);
  if (j?.code !== 200) throw new Error(j?.message || `登录失败(HTTP ${res.status})`);
  return j.data.token;
}

async function getToken(site) {
  try {
    const token = await siteLogin(site);
    db.prepare("UPDATE site SET status='online', last_check=datetime('now'), jwt_cache=? WHERE site_id=?")
      .run(token, site.site_id);
    return token;
  } catch (e) {
    db.prepare("UPDATE site SET status='offline', last_check=datetime('now') WHERE site_id=?").run(site.site_id);
    // no silent fallback to a cached token: an expired one makes the embedded
    // console show "身份认证失效" with no way to log in inside the iframe
    throw e;
  }
}

// rewrite absolute root paths in the site's index.html to the embed prefix and
// inject the token into localStorage BEFORE the app bundle runs
function rewriteHtml(html, prefix, token, error) {
  let out = html;
  if (error) {
    const inject = `<body style="font-family:sans-serif;background:#141414;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><p style="font-size:15px">${error}</p><p style="font-size:12px;opacity:.6">请检查站点地址是否可达，或稍后重试</p></div></body>`;
    return html.slice(0, Math.max(html.indexOf('</body>'), 0)) + inject;
  }
  // prefix quoted absolute refs in html
  for (const p of STATIC_PREFIXES) {
    out = out.split(`"/${p}`).join(`"${prefix}/${p}`);
  }
  // safety net for unquoted / attribute-less occurrences
  out = out.replace(/(src|href)=\/(assets|image|fonts|tinymce)/g, `$1=${prefix}/$2`);
  const inject = `<script>
try{
  // the site registers a service worker at scope "/" on our origin — that
  // would intercept the PANEL's own requests; disable SW inside the embed
  if ('serviceWorker' in navigator) navigator.serviceWorker.register = () => Promise.resolve();
  ${token ? `localStorage.setItem('token', ${JSON.stringify(token)});` : `localStorage.removeItem('token');`}
  if(!localStorage.getItem('ui')) localStorage.setItem('ui', JSON.stringify({dark:true}));
}catch(e){}
</script>`;
  // vue-router's createWebHistory() (no base arg) falls back to the <base href>
  // element — injecting it routes the site's SPA under our embed prefix
  // without touching the bundle; refresh also keeps working since absolute
  // proxy paths still resolve.
  const baseTag = `<base href="${prefix}/">`;
  return out.replace('</head>', `${baseTag}${inject}</head>`);
}

// the site's axios is built with a relative baseURL "/api" — inside the embed
// that must hit our proxy (…/console/:siteId/api) instead of the panel origin
// vue-router's history base is compiled in as createWebHistory("/") — an
// explicit arg means the injected <base href> is IGNORED, so the router would
// see "/api/site/console/1/…" and 404; rewrite the compiled base to our prefix
const JS_REWRITES = [
  [/baseURL:"\/api"/g, (prefix) => () => `baseURL:"${prefix}/api"`],
  [/history:([A-Za-z_$][\w$]*)\("\/"\)/g, (prefix) => (m, fn) => `history:${fn}("${prefix}/")`],
  // runtime-composed ABSOLUTE refs inside the app bundle: tiny-editor injects
  // <script src="/tinymce/tinymce.min.js"> at runtime (tiny-editor/index.vue)
  // and the logo/icon paths come from compiled BASE_URL="/" — without this
  // they hit the PANEL origin and get the panel's own index.html back
  // (SyntaxError: Unexpected token '<' → app crashes on the loading screen).
  // Rewrite the quoted/plain occurrences of the static roots inside JS too.
  [/(["'`])\/(tinymce|image|fonts)\//g, (prefix) => (m, q, name) => `${q}${prefix}/${name}/`],
  [/(["'`])\/(mail\.png|mail-pwa\.png)/g, (prefix) => (m, q, f) => `${q}${prefix}/${f}`],
  // vite compiles BASE_URL="/" into the preload helper: Wg=function(e){return"/"+e}
  // — every lazy chunk/preload URL gets an absolute "/assets/…" that lands on
  // the PANEL origin (returns the panel's own index.html → MIME module error).
  // Rewrite the compiled base function to our embed prefix.
  [/function\(([a-zA-Z_$][\w$]*)\)\{return"\/"\+([a-zA-Z_$][\w$]*)\}/g,
    (prefix) => (m, arg, v) => `function(${arg}){return"${prefix}/"+${v}}`]
];
function rewriteJs(code, prefix) {
  let out = code;
  for (const [re, make] of JS_REWRITES) out = out.replace(re, make(prefix));
  return out;
}

export default async function (app) {
  // issue a short-lived embed key (authed, from the panel UI)
  app.post('/prepare/:siteId', { preHandler: [app.auth] }, async (req, reply) => {
    const site = db.prepare('SELECT * FROM site WHERE site_id = ?').get(Number(req.params.siteId) || 0);
    if (!site) return reply.code(404).send({ code: 404, message: '站点不存在' });
    return { code: 200, data: { key: makeKey(site.site_id), expiresIn: EMBED_TTL_MS } };
  });

  // ---- console shell ----
  // The embed URL lives OUTSIDE the proxy prefix, so vue-router (whose base
  // comes from the injected <base href>) would resolve it to "/embed/:id" and
  // show its 404 page. Instead: set the auth cookie, then bounce the iframe
  // to the prefix root — there the router sees "/" and boots normally.
  app.get('/embed/:siteId', async (req, reply) => {
    const siteId = Number(req.params.siteId) || 0;
    const site = db.prepare('SELECT * FROM site WHERE site_id = ?').get(siteId);
    if (!site) return reply.code(404).type('text/plain').send('站点不存在');
    if (!authorized(req, site.site_id)) return reply.code(403).type('text/plain').send('嵌入凭证无效或已过期，请在面板中重新打开控制台');
    // refresh the signed cookie so long sessions keep working
    reply.header('Set-Cookie', `cmconsole=${makeKey(site.site_id, COOKIE_TTL_S * 1000)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_TTL_S}`);
    return reply.redirect(`/api/site/console/${site.site_id}/`, 302);
  });

  // ---- static assets proxy (SPA fallback for navigation paths) ----
  // "/" and any navigation path return the site's index.html rewritten for
  // the embed; the injected <base href> anchors vue-router and relative URLs
  app.get('/:siteId', async (req, reply) => serveAsset(req, reply, ''));
  app.get('/:siteId/*', async (req, reply) => serveAsset(req, reply, req.params['*']));

  async function serveAsset(req, reply, rel) {
    const siteId = Number(req.params.siteId) || 0;
    const site = db.prepare('SELECT * FROM site WHERE site_id = ?').get(siteId);
    if (!site) return reply.code(404).send('站点不存在');
    if (!authorized(req, siteId)) return reply.code(403).type('text/plain').send('嵌入凭证无效或已过期，请在面板中重新打开控制台');
    let res;
    try {
      res = await fetch(site.base_url + '/' + rel, { headers: { Accept: req.headers.accept || '*/*' } });
    } catch (e) {
      return reply.code(502).type('text/plain').send('站点不可达: ' + e.message);
    }
    const prefix = `/api/site/console/${siteId}`;
    const ct = res.headers.get('content-type') || '';
    // cloud-mail's SPA fallback returns 200 index.html for navigation paths —
    // rewrite ANY html response so asset refs keep hitting the proxy.
    // Fresh token per navigation: cached ones expire and the embedded UI
    // would show "身份认证失效" (login API is auth-free, so manual login
    // still works if the panel's stored credentials are stale).
    if (ct.includes('text/html')) {
      const html = await res.text();
      let token = null;
      try { token = await getToken(site); } catch { token = null; }
      reply.type('text/html; charset=utf-8');
      reply.header('Content-Security-Policy', "frame-ancestors 'self'");
      return rewriteHtml(html, prefix, token, null);
    }
    if (ct) reply.type(ct);
    if (ct.includes('javascript')) {
      const code = await res.text();
      // neutralize the site's service worker when served through the embed
      return rewriteJs(code.replace('navigator.serviceWorker.register', 'false&&navigator.serviceWorker.register'), prefix);
    }
    return reply.send(res.body);
  }

  // ---- site API proxy (Authorization attached server-side) ----
  app.all('/:siteId/api/*', async (req, reply) => {
    const siteId = Number(req.params.siteId) || 0;
    const site = db.prepare('SELECT * FROM site WHERE site_id = ?').get(siteId);
    if (!site) return reply.code(404).send({ code: 404, message: '站点不存在' });
    if (!authorized(req, siteId)) return reply.code(403).send({ code: 403, message: '嵌入凭证无效或已过期，请在面板中重新打开控制台' });
    const rel = req.params['*'];
    // forward the query string but strip our signed key
    const params = new URLSearchParams(req.raw.url.split('?')[1] || '');
    params.delete('key');
    const qs = params.toString() ? '?' + params.toString() : '';
    // If the client already carries its own site token (user logged in inside
    // the iframe), pass it through untouched — never override it with our
    // server-side token, and never block the request behind siteLogin: if the
    // panel's stored credentials are stale, that made manual login inside the
    // console fail too ("身份认证失效" with no way out).
    const clientAuth = req.headers.authorization;
    const isAuthFree = /(^|\/)(login|verifycode|email\/verify)(\/|$)|^public/.test(rel);
    const call = (token) => fetch(`${site.base_url}/api/${rel}${qs}`, {
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        ...(clientAuth ? { Authorization: clientAuth }
          : token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body ?? {})
    });
    // only fall back to panel-stored credentials when the client has no token
    let token = null;
    if (!clientAuth && !isAuthFree) {
      try {
        token = await getToken(site);
      } catch (e) {
        // stored credentials failed — still forward the request unauthenticated
        // so /login etc. work; protected endpoints will get the site's own 401
        token = null;
      }
    }
    let res;
    try { res = await call(token); } catch (e) {
      return reply.code(502).send({ code: 502, message: '站点不可达: ' + e.message });
    }
    if (res.status === 401) {
      if (clientAuth) {
        // the client's own token expired — let the site's response reach the
        // embedded UI so it clears its token and shows its login page
      } else {
        // our server-side token may have been revoked mid-session — relogin + retry
        try {
          token = await getToken(site);
          res = await call(token);
        } catch { /* keep original 401 response */ }
      }
    }
    reply.code(res.status);
    const text = await res.text();
    if (res.headers.get('content-type')?.includes('json')) {
      try { return JSON.parse(text); } catch { return text; }
    }
    reply.type('text/plain; charset=utf-8');
    return text;
  });
}
