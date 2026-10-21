#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Export an independently buildable GuardNook source tree and matching binaries."""
from pathlib import Path
import argparse, datetime, hashlib, json, platform, shutil, subprocess, sys, tempfile, zipfile
root = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser()
p.add_argument('--output', type=Path, default=Path.home()/'Downloads')
p.add_argument('--version', default='0.4.0')
a = p.parse_args()
if not a.version or any(c not in '0123456789.-abcdefghijklmnopqrstuvwxyz' for c in a.version): raise SystemExit('Invalid version')
stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
out = a.output.expanduser()/('GuardNook-export-'+stamp)
out.mkdir(parents=True, exist_ok=False)
source = out/'Source'/'GuardNook'; source.mkdir(parents=True)
blocked = {'.git','.build','.swiftpm','node_modules','.DS_Store','__pycache__','.codex-backups','accounts','Logs','Backups','Profiles','disabled-connections','environment-backups','environment-backups-v2'}
private_names = {'auth.json','config.json','events.json','.env','index.json'}
def ignore(directory,names):
    return [name for name in names if name in blocked or name in private_names or name.endswith(('.pyc','.log','.tmp','.p12','.pem','.key','.dmg','.zip'))]
for name in ['Assets','Scripts','Service','Sources','Tests','Vendor','TestSupport']:
    for item in (root/name).rglob('*'):
        if item.is_symlink(): raise SystemExit('Symlinks are not allowed in the source export')
    shutil.copytree(root/name,source/name,ignore=ignore)
for name in ['Package.swift','LICENSE','README.md','CHANGELOG.md','.gitignore']:
    if (root/name).exists(): shutil.copy2(root/name,source/name)
for file in source.rglob('*'):
    if not file.is_file(): continue
    try: text=file.read_text()
    except UnicodeDecodeError: continue
    if str(Path.home()) in text: raise SystemExit('An absolute private home path was found in the source')
result = subprocess.run([sys.executable,str(source/'Scripts/package-macos.py'),'--output',str(out),'--version',a.version],check=True,capture_output=True,text=True)
packaged = json.loads(result.stdout.strip().splitlines()[-1])
work=Path(packaged['work'])
node=work/'GuardNook.app/Contents/Resources/Runtime'/('arm64' if platform.machine()=='arm64' else 'x64')/'node'
checks={}
commands=[['sh','Tests/'+name] for name in ['run-log-checks.sh','run-network-checks.sh','run-launcher-checks.sh','run-todo-checks.sh','run-resource-checks.sh']]
commands.append([str(node),'--experimental-strip-types','--test',*[str(file.relative_to(source)) for file in sorted((source/'Service/claude-guard').glob('*.test.mjs'))]])
for i,command in enumerate(commands):
    checked=subprocess.run(command,cwd=source,capture_output=True,text=True)
    if checked.returncode:
        (out/'failed-check.log').write_text(checked.stdout+'\n'+checked.stderr)
        raise SystemExit('Export checks failed; see failed-check.log')
    checks['service-tests' if i==5 else Path(command[1]).name]='passed'
shutil.rmtree(source/'.build',ignore_errors=True)
notes='''# GuardNook release export\n\nInstall: open the Universal DMG and drag GuardNook.app to Applications. macOS 15+, Apple silicon and Intel. Configure your own proxy/client/exit; no subscription, credential or account snapshot is included.\n\nSource: unzip the source archive, enter GuardNook, and follow README.md. Swift/Xcode tools, Python 3 and Node.js 22+ are needed for development/tests. Vendor dependencies are included. Build with `python3 Scripts/package-macos.py --output dist --version VERSION`.\n\nPackage and source are from the same snapshot; all included checks passed. Runtime data, account snapshots, logs, credentials, build caches and earlier backups are excluded. Historical personal examples use RFC documentation addresses. SHA256SUMS.txt verifies component integrity; it does not prove publisher identity. Manual update/rollback and uninstall steps are in README.md.\n'''.replace('VERSION',a.version)
(out/'EXPORT-README.md').write_text(notes)
archive=out/'GuardNook-source.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for file in sorted(source.rglob('*')):
        if file.is_file(): z.write(file,Path('GuardNook')/file.relative_to(source))
with zipfile.ZipFile(archive) as z:
    if z.testzip(): raise SystemExit('Source ZIP integrity failed')
files=[out/'GuardNook-universal.dmg',out/'GuardNook-universal.zip',archive,out/'GuardNook-universal-verification.json',out/'EXPORT-README.md']
verification={'version':a.version,'checks':checks,'sourceFiles':{str(f.relative_to(source)):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(source.rglob('*')) if f.is_file()}}
(out/'source-verification.json').write_text(json.dumps(verification,indent=2)+'\n');files.append(out/'source-verification.json')
(out/'SHA256SUMS.txt').write_text(''.join(hashlib.sha256(f.read_bytes()).hexdigest()+'  '+f.name+'\n' for f in files));files.append(out/'SHA256SUMS.txt')
bundle=out/'GuardNook-complete.zip'
with zipfile.ZipFile(bundle,'w',zipfile.ZIP_STORED,allowZip64=True) as z:
    for file in files:z.write(file,Path('GuardNook')/file.name)
with zipfile.ZipFile(bundle) as z:
    if z.testzip():raise SystemExit('Complete ZIP integrity failed')
print(json.dumps({'directory':str(out),'installer':str(files[0]),'source':str(archive),'complete':str(bundle),'work':str(work),'checks':checks},ensure_ascii=False))
