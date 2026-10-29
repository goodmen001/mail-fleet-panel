#!/usr/bin/env bash
# Build the Windows package zip. Run from repo root.
# Keeps /tmp/sea/winpkg (exe + patched panel.cjs) as the packaging base and
# always syncs the freshly built web/dist in — the exe-side files only change
# when server code changes, but web dist changes with every frontend edit.
set -e
cd "$(dirname "$0")"

echo "[1/3] building web dist..."
(cd web && npm run build)

echo "[2/3] bundling server + applying exe patches..."
(cd server && node -e "const es=require('/tmp/postject/node_modules/esbuild'); es.build({entryPoints:['src/index.js'],bundle:true,platform:'node',format:'cjs',outfile:'/tmp/sea/winpkg/panel.cjs',supported:{'import-meta':false},inject:['/tmp/sea/dirname-shim.js'],logLevel:'silent'})")
python3 /tmp/sea/patch.py

echo "[3/4] staging worker deploy bundle (data/worker-dist)..."
# worker.js: wrangler dry-run bundle of cloud-mail mail-worker (ESM, self-contained)
(cd /cloudmail/cloud-mail/mail-worker && npx wrangler deploy --dry-run --outdir /tmp/worker-bundle >/dev/null)
rm -rf /tmp/sea/winpkg/data/worker-dist
mkdir -p /tmp/sea/winpkg/data/worker-dist
cp /tmp/worker-bundle/index.js /tmp/sea/winpkg/data/worker-dist/worker.js
# static assets: mail-worker's built frontend (index.html + assets/...)
cp -r /cloudmail/cloud-mail/mail-worker/dist/. /tmp/sea/winpkg/data/worker-dist/
test -f /tmp/sea/winpkg/data/worker-dist/worker.js
test -f /tmp/sea/winpkg/data/worker-dist/index.html

echo "[4/4] syncing web dist + zipping..."
rm -rf /tmp/sea/winpkg/web/dist
cp -r web/dist /tmp/sea/winpkg/web/dist
python3 - <<'EOF'
import zipfile, os
src='/tmp/sea/winpkg'; out='/cloudmail/mail-fleet-panel-win.zip'
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
    for root,_,files in os.walk(src):
        for f in files:
            p=os.path.join(root,f)
            z.write(p, os.path.relpath(p,src))
# sanity: packaged UI must be the current one
z = zipfile.ZipFile(out)
d = ''.join(z.read(n).decode('utf8','ignore') for n in z.namelist() if n.endswith('.js'))
assert '原版界面内嵌' not in d, 'zip still contains OLD iframe UI!'
assert '复制密码' in d, 'zip missing NEW console UI!'
# deploy bundle must ship (this was the "你没有打包" bug)
z.read('data/worker-dist/worker.js')
z.read('data/worker-dist/index.html')
assert any(n.startswith('data/worker-dist/assets/') for n in z.namelist()), 'worker-dist assets missing!'
print('OK ->', out, os.path.getsize(out))
EOF
