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

// Multi-size (16/24/32/48/64) FULLY-OPAQUE ICO: dark navy square + bright cyan
// envelope. v0.5.3 lessons from real Windows:
//   - PNG icon: systray-portable on Windows expects .ico content; a PNG was
//     rendered with broken alpha (looked white/semi-transparent on taskbars).
//     ICO with 32bpp ARGB entries renders exactly as drawn, at every DPI.
//   - clicks: this Go binary (zaaack/systray-portable) emits
//     {"type":"clicked","item":{title,tooltip,enabled,checked},"seq_id":<index>}
//     — NO `id`/`__id` fields (those are added by the systray2 JS wrapper, which
//     we do not use). Match by item.title first, seq_id as fallback.
const ICON_ICO_BASE64 =
  'AAABAAUAEBAAAAEAIAB1AAAAVgAAABgYAAABACAAigAAAMsAAAAgIAAAAQAgAKIAAABVAQAAMDAAAAEAIADVAAAA9wEAAEBAAAAB' +
  'ACAAHQEAAMwCAACJUE5HDQoaCgAAAA1JSERSAAAAEAAAABAIBgAAAB/z/2EAAAA8SURBVHicY+AX1/pPCWYYNQBhgNLldyRjDAOwGYbLZrwGoCvEZhjRBuAy' +
  'jCwDKHYBQQMoioWBT0gDZgAA96yV5x7jixQAAAAASUVORK5CYIKJUE5HDQoaCgAAAA1JSERSAAAAGAAAABgIBgAAAOB3PfgAAABRSURBVHicY+AX1/pPS8ww' +
  'asGoBdS1QOnyO6phoi0gx9V4LaCGhURbQK5FJFtAqmUUWUDIQqpbQMhnVLMAm2U0tYDqQUS0BTTNybTAoxaMAAsAT2l2KjSIinAAAAAASUVORK5CYIKJUE5H' +
  'DQoaCgAAAA1JSERSAAAAIAAAACAIBgAAAHN6evQAAABpSURBVHic7dWxDQAgDAMwPmBkZ+T/T/iDF+ABQIWWhiFD5lpRpIaYSkcmEEAAAV8Bcm14gEf+B+ww' +
  '2srFAEkzbgBLjBqgxZgCbjDPAFKMC+CkmeeAFQYCmN2AAFw3cAWA/QJECCCAAAIGdsAx76qMiogAAAAASUVORK5CYIKJUE5HDQoaCgAAAA1JSERSAAAAMAAA' +
  'ADAIBgAAAFcC+YcAAACcSURBVHic7dK5DYAwFARRd0BITkj/ndAHLUCOEODje9Zig0kcWPtkp2lej5FL9AAD6AEG0AMMoAcYQA8wgB4QAli2HR9WDRgF8QhQ' +
  'zIC3C6MqAuSApAGlryQN6A0JA/SChANKUPKAli+DAVphJAA1IElADkQaUPPN5ABfQEMB7iAGkIDruQHSAMX+ARgpA+gMoDOAzgA6A+gMoDsBXS/MHJViMgIA' +
  'AAAASUVORK5CYIKJUE5HDQoaCgAAAA1JSERSAAAAQAAAAEAIBgAAAKppcd4AAADkSURBVHic7dMxEsIgFAbh3MDS3jL3v4n38Apa2YVRAmHhvS22CzN/voHt' +
  'dt/fmdvoAXQC0APoBKAH0AlAD6ATgB5AJwA9gE4AegCdAPQAuiLA4/nCx+EA3+iROECEBBBgIAD9ro/+oQmgBSYcwEoYlwPMjjEUYEYMDOAsRkgAEmM6gNEY' +
  'UwOcgajdsgTAlRjLAfTGWBqgB0YYgBaMcAA9bkYYgFqM0AD/YKQBKEEIkBmg9I0AAgjw+3CEBBCgEiBLAtAD6ASgB9AJQA+gE4AeQCcAPYBOAHoAnQD0ADoB' +
  '6AF06QE+6HnBbaWxFtEAAAAASUVORK5CYII=';

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
    icon: ICON_ICO_BASE64,
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
          // systray-portable emits {type:'clicked', item:{title,...}, seq_id:N}
          // — no id/__id fields. Match by title (always present), then seq_id.
          const title = action.item?.title || '';
          const seq = action.seq_id;
          if (title.includes('退出') || seq === 2) onQuit?.();
          else if (title.includes('打开') || seq === 0) onOpen?.();
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
