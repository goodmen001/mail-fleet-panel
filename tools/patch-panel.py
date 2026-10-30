import re, sys
p = sys.argv[1] if len(sys.argv) > 1 else '/tmp/sea/winpkg/panel.cjs'
s = open(p, encoding='utf8').read()
n0 = len(s)

# 1. __dirname fallback to exec dir (single-exe mode)
s = re.sub(r'var __dirname2 = [^\n]+\n', '''var __dirname2 = (function(){
  try {
    if (process.execPath && require("fs").existsSync(require("path").join(require("path").dirname(process.execPath), "src"))) {
      return require("path").dirname(process.execPath);
    }
  } catch(e) {}
  return __dirname;
})();
''', s, count=1)

# 2. webDist relative to exe
s = re.sub(r'const webDist = [^\n]+\n', 'const webDist = process.env.PANEL_WEB_DIST || require("path").join(require("path").dirname(process.execPath), "web", "dist");\n', s, count=1)

# 3. worker bundle path relative to exe
s = re.sub(r'const bundlePath = [^\n]+\n', 'const bundlePath = process.env.WORKER_BUNDLE || require("path").join(require("path").dirname(process.execPath), "data", "bundles", "worker.zip");\n', s, count=1)

open(p, 'w', encoding='utf8').write(s)
print('patched', n0, '->', len(s))
