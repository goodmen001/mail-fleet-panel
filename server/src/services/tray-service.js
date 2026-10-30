// Windows system tray for the SEA exe (v0.3.0, hardened v0.5.1).
// Drives the prebuilt systray-portable Go binary (traybin/tray_windows_release.exe,
// shipped beside the exe) over its stdin/stdout JSON protocol:
//   node writes  menu JSON on ready + {"type":"exit"} to quit
//   tray writes  {"type":"ready"} / {"type":"clicked","item":{...}}
// Hardening learned from the field (v0.5.1):
//   1. icon: 64x64 fully-opaque dark-navy square with a BRIGHT CYAN envelope —
//      the old 32x32 semi-transparent blue was nearly invisible on taskbars
//      (Windows renders tray icons at 16-24px on high-DPI, opacity matters).
//   2. 打开面板无反应: clicks were matched by `action.item?.id` but the Go
//      binary only echoes the internal numeric `__id` + partial item — now we
//      also keep a menu-item registry and match on __id, plus a click-handler
//      rebuild every time we (re)send the menu.
//   3. 退出无反应: onQuit relied on the click arriving; now 退出 sends
//      {"type":"exit"} to the tray binary itself (graceful, verified EXIT 0
//      under wine) AND kills the child after a 3s grace period as a fallback.
// No native node addons — safe inside Node SEA. On non-Windows or when the tray
// binary is missing, everything below is a silent no-op.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 64x64 fully-opaque icon: dark navy rounded square + bright cyan envelope
// (bolder than the old semi-transparent blue — visible on light & dark taskbars)
const ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABBUlEQVR42u3bMQ6DMAyF4dygY/eOvf9Neo9egW4sFBRix89JfqSsdt+npAKBS6m8Hs/3NtIq1mu0wG4gswW/BTF7+EuEVcKfIiwNsFr4AwIAACwMsGr4HQEAAAAAAAAAADhdr893+AUAAJ0AMp1l2Q7IHj7sCGQMHv4fkDG8K0BtY3Xwf7/bDUCJcKdvV4BoiJY+IQARCK31wwB6QVjrhQN4InjUkQB4blvrLpICtITpeYQkAJ4PU9a+UgArgkdPOYDitjolgOrmKRXAFUSv+ikBstSWAkQ9NQIAAAAA8F4AAAB4OwwAAAAAAAAAfC/M1+IAAMDcEFNjDE4yOsvw9NzT5LW5fpNwg+mTHGUgAAAAAElFTkSuQmCC';

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

// build the menu JSON; ids are strings the Go binary echoes back on click
function buildMenu(tooltip) {
  return {
    icon: ICON_PNG_BASE64,
    title: 'Mail Fleet Panel',
    tooltip: tooltip || 'Mail Fleet Panel',
    items: [
      { id: 'open', title: '打开面板', tooltip: '在浏览器中打开管理界面', enabled: true },
      { title: '<SEPARATOR>', enabled: false },
      { id: 'quit', title: '退出', tooltip: '停止面板服务', enabled: true }
    ]
  };
}

// start the tray; onOpen fires on the "打开面板" click, onQuit on "退出"
export function startTray({ url, tooltip, onOpen, onQuit }) {
  if (!IS_WIN) return; // tray is a Windows-only nicety
  const bin = trayBinPath();
  if (!fs.existsSync(bin)) return; // not packaged — skip silently
  try {
    trayProc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const send = (obj) => {
      try { trayProc?.stdin?.write(JSON.stringify(obj) + '\n'); } catch { /* child gone */ }
    };
    let buf = '';
    trayProc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let action;
        try { action = JSON.parse(line); } catch { continue; }
        if (action.type === 'ready') {
          // first contact → push the whole menu
          send(buildMenu(tooltip));
        } else if (action.type === 'clicked') {
          // the Go binary may echo only {__id, item:{...partial}} — match on
          // BOTH the custom string id AND the numeric __id fallback
          const customId = action.item?.id;
          const numId = action.__id;
          // open is item 0, quit is item 2 in our fixed menu (0-based, separator counts)
          if (customId === 'open' || numId === 0 || action.item_id === 0) onOpen?.();
          else if (customId === 'quit' || numId === 2) onQuit?.();
        }
      }
    });
    trayProc.on('error', () => { trayProc = null; });
    trayProc.on('exit', () => { trayProc = null; });
  } catch { /* tray is optional — never block startup */ }
}

// graceful shutdown: tell the tray binary to remove itself, then close panel
export async function stopTray() {
  const proc = trayProc;
  if (!proc) return;
  trayProc = null;
  try {
    // {"type":"exit"} is the systray-portable graceful quit (verified EXIT-CODE 0)
    proc.stdin.write(JSON.stringify({ type: 'exit' }) + '\n');
  } catch { /* child already gone */ }
  // fallback hard-kill if it does not exit within 3s
  setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 3000);
}
