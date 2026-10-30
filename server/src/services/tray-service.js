// Windows system tray for the SEA exe (v0.3.0).
// Drives the prebuilt systray-portable Go binary (traybin/tray_windows_release.exe,
// shipped beside the exe) over its stdin/stdout JSON protocol:
//   node writes  { type:'update-item'|..., item:{...} } and the initial menu JSON
//   tray writes  { type:'ready' } / { type:'clicked', __id, item:{id} }
// No native node addons — safe inside Node SEA. On non-Windows or when the tray
// binary is missing, everything below is a silent no-op.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 16x16 blue mail icon, base64 PNG (generated from a simple envelope glyph)
const ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/2hAAAAu0lEQVR42mNkYPhfz0BEwMjA' +
  'yMDIwAAiZGRgZGSAcRqA+DDS8T8DA8P/IwPD/yMDw/8jA8P/IwPD4TQAsxkgFhBWAGIBYQIg' +
  'FhC2AGIBYQdALSAsAKoG0gwQSwGyAVgFiAWELQDFA8IioGoArQDRNCArAMUCogWgWEC0AFQN' +
  'iJaAagHRAlA1IFoCqgZEC0DVgGgJqBoQLQFVA6IloGpAtARUDYiWgKoB0RJQNSBaAKoGRGtA' +
  '1YBoDaweAGKQRs3wFwPMAAAAAElFTkSuQmCC';

const IS_WIN = process.platform === 'win32';

function trayBinPath() {
  // next to the exe in SEA mode; relative traybin/ otherwise (dev layout)
  const base = process.env.PANEL_SEA
    ? path.dirname(process.execPath)
    : path.dirname(fileURLToPath(import.meta.url)); // server/src/services
  return path.join(base, 'traybin', IS_WIN ? 'tray_windows_release.exe' : `tray_${process.platform}_release`);
}

// open the default browser on the panel URL
export function openBrowser(url) {
  try {
    if (IS_WIN) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* best effort */ }
}

let trayProc = null;
let onExitRequested = null;

// start the tray; onOpen fires on the "打开面板" click, onQuit on "退出"
export function startTray({ url, tooltip, onOpen, onQuit }) {
  if (!IS_WIN) return; // tray is a Windows-only nicety
  const bin = trayBinPath();
  if (!fs.existsSync(bin)) return; // not packaged — skip silently
  onExitRequested = onQuit;
  try {
    trayProc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const items = [
      { id: 'open', title: '打开面板', tooltip: '在浏览器中打开管理界面', enabled: true },
      { id: 'sep', title: '<SEPARATOR>', enabled: false },
      { id: 'quit', title: '退出', tooltip: '停止面板服务', enabled: true }
    ];
    const send = (obj) => trayProc.stdin.write(JSON.stringify(obj) + '\n');
    let buf = '';
    trayProc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const action = JSON.parse(line);
          if (action.type === 'ready') {
            send({ icon: ICON_PNG_BASE64, title: 'Mail Fleet Panel', tooltip, items });
          } else if (action.type === 'clicked') {
            const id = action.item?.id || action.item?.item_id;
            if (id === 'open' || action.item_id === 0) onOpen?.();
            if (id === 'quit') onQuit?.();
          }
        } catch { /* partial line — ignore */ }
      }
    });
    trayProc.on('error', () => { trayProc = null; });
    trayProc.on('exit', () => { trayProc = null; });
  } catch { /* tray is optional — never block startup */ }
}

export function stopTray() {
  try { trayProc?.kill(); } catch { /* already gone */ }
  trayProc = null;
}
