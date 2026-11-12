import http from 'http';
import fs from 'fs';
import path from 'path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCRATCH_DIR } from '../../core/constants.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CORE_DIR = path.resolve(__dirname, '..', '..', 'core');
const PUBLIC_DIR = path.join(__dirname, 'public');

// 注册相对模块版本号传播钩子，支持 core/* 修改后零停机热重载
register(new URL('./hot-loader.mjs', import.meta.url));

const PORT = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || '39821', 10);
const LOG_FILE = path.join(SCRATCH_DIR, 'sidecar_debug.log');
const SERVER_BOOT_MTIME = safeMtime(__filename);

// 仅记录启动、重载与异常事件，并在超过 256KB 时自动截断，防止高频轮询撑爆磁盘
function logEvent(msg) {
  try {
    if (!fs.existsSync(SCRATCH_DIR)) fs.mkdirSync(SCRATCH_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE)) {
      const st = fs.statSync(LOG_FILE);
      if (st.size > 256 * 1024) {
        fs.writeFileSync(LOG_FILE, `[${new Date().toISOString()}] Log rotated\n`);
      }
    }
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [PID:${process.pid}] ${msg}\n`);
  } catch {}
}

function safeMtime(filePath) {
  try {
    return Math.floor(fs.statSync(filePath).mtimeMs);
  } catch {
    return 0;
  }
}

function computeDirSignature(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath).sort();
    const parts = [];
    for (const name of entries) {
      const full = path.join(dirPath, name);
      const st = fs.statSync(full);
      if (st.isFile()) {
        parts.push(`${name}:${Math.floor(st.mtimeMs)}:${st.size}`);
      }
    }
    return parts.join('|');
  } catch {
    return '0';
  }
}

let loadedCoreSig = '';
let coreApi = null;

async function getCoreApi(forceReload = false) {
  const currentSig = computeDirSignature(CORE_DIR);
  if (!coreApi || forceReload || currentSig !== loadedCoreSig) {
    const versionTag = `${Date.now()}_${Buffer.from(currentSig).toString('base64url').slice(0, 16)}`;
    const analyzerUrl = `${pathToFileURL(path.join(CORE_DIR, 'analyzer.mjs')).href}?v=${versionTag}`;
    coreApi = await import(analyzerUrl);
    if (loadedCoreSig && loadedCoreSig !== currentSig) {
      logEvent(`Hot-reloaded core modules (${currentSig})`);
    }
    loadedCoreSig = currentSig;
  }
  return coreApi;
}

/**
 * 动态拼装前端页面（源码按 HTML/CSS/JS 分离维护，响应时实时内联组装以避免网关鉴权拦截与缓存残留）
 */
function renderIndexHtml() {
  const htmlPath = path.join(PUBLIC_DIR, 'index.html');
  const cssPath = path.join(PUBLIC_DIR, 'styles.css');
  const jsPath = path.join(PUBLIC_DIR, 'app.js');

  if (!fs.existsSync(htmlPath)) {
    return '<h1>Context Monitor Server Running</h1>';
  }

  let html = fs.readFileSync(htmlPath, 'utf8');
  const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';
  const js = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : '';
  const uiVersion = computeDirSignature(PUBLIC_DIR);

  html = html.replace('<!-- INLINE_STYLES -->', () => `<style>\n${css}\n</style>`);
  html = html.replace(
    '<!-- INLINE_SCRIPT -->',
    () => `<script>\nwindow.__MONITOR_UI_VERSION__ = ${JSON.stringify(uiVersion)};\n${js}\n</script>`
  );
  return html;
}

function setNoCacheHeaders(res, contentType) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  if (contentType) {
    res.setHeader('Content-Type', contentType);
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = reqUrl.pathname;

  if (req.method === 'OPTIONS') {
    setNoCacheHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (pathname === '/api/reload') {
      const api = await getCoreApi(true);
      api.clearAllCaches();
      const uiVersion = computeDirSignature(PUBLIC_DIR);
      setNoCacheHeaders(res, 'application/json; charset=utf-8');
      res.writeHead(200);
      res.end(
        JSON.stringify({
          ok: true,
          reloadedAt: new Date().toISOString(),
          uiVersion,
          coreVersion: loadedCoreSig,
          pid: process.pid,
        })
      );
      return;
    }

    if (pathname === '/api/conversations') {
      const force = reqUrl.searchParams.get('force') === '1';
      const api = await getCoreApi(false);
      setNoCacheHeaders(res, 'application/json; charset=utf-8');
      res.writeHead(200);
      res.end(JSON.stringify(api.getConversations({ force })));
      return;
    }

    if (pathname === '/api/stats') {
      const force = reqUrl.searchParams.get('force') === '1';
      const targetId =
        reqUrl.searchParams.get('conversationId') ||
        reqUrl.searchParams.get('conversation_id') ||
        process.env.ANTIGRAVITY_CONVERSATION_ID ||
        '';
      const reqMaxWindow = reqUrl.searchParams.get('max_window')
        ? parseInt(reqUrl.searchParams.get('max_window'), 10)
        : 0;

      const api = await getCoreApi(false);
      const snapshot = api.getSessionSnapshot({
        conversationId: targetId,
        maxWindowOverride: reqMaxWindow > 0 ? reqMaxWindow : 0,
        force,
      });

      if (!snapshot) {
        setNoCacheHeaders(res, 'application/json; charset=utf-8');
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'No conversations found' }));
        return;
      }

      setNoCacheHeaders(res, 'application/json; charset=utf-8');
      res.writeHead(200);
      res.end(
        JSON.stringify({
          ...snapshot,
          uiVersion: computeDirSignature(PUBLIC_DIR),
          coreVersion: loadedCoreSig,
          serverPid: process.pid,
        })
      );
      return;
    }

    if (pathname === '/styles.css') {
      const cssPath = path.join(PUBLIC_DIR, 'styles.css');
      setNoCacheHeaders(res, 'text/css; charset=utf-8');
      res.writeHead(200);
      res.end(fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '');
      return;
    }

    if (pathname === '/app.js') {
      const jsPath = path.join(PUBLIC_DIR, 'app.js');
      setNoCacheHeaders(res, 'application/javascript; charset=utf-8');
      res.writeHead(200);
      res.end(fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : '');
      return;
    }

    // 默认返回动态内联最新静态资源的主面板页面
    const html = renderIndexHtml();
    setNoCacheHeaders(res, 'text/html; charset=utf-8');
    res.writeHead(200);
    res.end(html);
  } catch (err) {
    logEvent(`Error handling ${req.method} ${pathname}: ${err.stack || err.message}`);
    setNoCacheHeaders(res, 'application/json; charset=utf-8');
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

// 当入口壳文件 server.mjs 自身在磁盘上被修改时，主动优雅退出并交由 sidecar supervisor (restart_policy: always) 拉起新进程
const selfWatchTimer = setInterval(() => {
  const currentMtime = safeMtime(__filename);
  if (SERVER_BOOT_MTIME > 0 && currentMtime > SERVER_BOOT_MTIME) {
    logEvent('Detected server.mjs update on disk, exiting for supervisor restart...');
    clearInterval(selfWatchTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }
}, 2000);
selfWatchTimer.unref();

server.on('error', (err) => {
  logEvent(`Server socket error: ${err.message}`);
  console.error('Server error:', err);
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : PORT;
  logEvent(`Sidecar listening on http://127.0.0.1:${actualPort}`);
  console.log(`Context Monitor listening on http://127.0.0.1:${actualPort}`);
});
