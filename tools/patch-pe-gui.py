#!/usr/bin/env python3
"""Patch a Windows PE (node.exe with an injected SEA blob) from the console
subsystem to the GUI subsystem, so double-clicking it opens NO console window.
Output goes to stdout or <image>.gui (in place + '.gui' backup when --inplace).

The PE header optional-header Subsystem field: 2 = GUI, 3 = console.
Off = DOS-header e_lfanew -> COFF header (20 bytes) -> optional header (offset
68 within it for PE32+ Magic=0x20b; 68 also lands on Subsystem for PE32).
"""
import struct, sys, shutil, os

def subsystem(path):
    with open(path, 'rb') as f:
        d = f.read(4096)
    if d[:2] != b'MZ': raise SystemExit('not a PE')
    e_lfanew = struct.unpack_from('<I', d, 0x3c)[0]
    if d[e_lfanew:e_lfanew+4] != b'PE\0\0': raise SystemExit('bad PE signature')
    opt = e_lfanew + 24
    magic = struct.unpack_from('<H', d, opt)[0]
    if magic == 0x20b:   # PE32+
        sub_off = opt + 68
    elif magic == 0x10b: # PE32
        sub_off = opt + 68
    else:
        raise SystemExit(f'unknown optional header magic {magic:#x}')
    with open(path, 'rb') as f:
        f.seek(sub_off)
        sub = struct.unpack('<H', f.read(2))[0]
    return sub, sub_off

def patch(path, inplace=False):
    sub, sub_off = subsystem(path)
    if sub == 2:
        print(f'{path}: already GUI subsystem')
        return
    if sub != 3:
        raise SystemExit(f'unexpected subsystem {sub}')
    if inplace:
        out = path
    else:
        out = sys.stdout.name if sys.stdout.isatty() is False and len(sys.argv) > 2 else sys.argv[2]
    with open(path, 'r+b') as f:
        f.seek(sub_off)
        f.write(struct.pack('<H', 2))
    print(f'patched {path}: subsystem console(3) -> GUI(2) @{sub_off:#x} -> {out}')

if __name__ == '__main__':
    src = sys.argv[1]
    if len(sys.argv) > 2 and sys.argv[2] != '--inplace':
        shutil.copy2(src, sys.argv[2])
        patch(sys.argv[2])
    else:
        patch(src, inplace='--inplace' in sys.argv)
