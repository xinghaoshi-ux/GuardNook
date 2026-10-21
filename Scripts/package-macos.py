#!/usr/bin/env python3
"""Build a portable Universal GuardNook application and a drag-to-install DMG."""
from pathlib import Path
import argparse, subprocess, tempfile, shutil, urllib.request, hashlib, tarfile, plistlib, json, zipfile, datetime, concurrent.futures
root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, default=Path.home()/'Downloads')
parser.add_argument('--runtime-cache', type=Path, default=Path('/tmp/guardnook-node-runtime'))
parser.add_argument('--build-cache-root', type=Path, default=Path('/tmp'))
parser.add_argument('--version', default='0.4.0')
parser.add_argument('--skip-build', action='store_true')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
work = Path(tempfile.mkdtemp(prefix='guardnook-package-'))

def run(command, log=None):
    if log:
        with log.open('w') as output: subprocess.run(command, check=True, stdout=output, stderr=subprocess.STDOUT)
    else:
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode: raise RuntimeError(result.stderr.decode(errors='replace'))

def build(arch):
    triple = 'arm64-apple-macosx15.0' if arch == 'arm64' else 'x86_64-apple-macosx15.0'
    scratch = args.build_cache_root/('guardnook-release-'+arch)
    command = ['swift','build','--package-path',str(root),'--scratch-path',str(scratch),'-c','release','--triple',triple,'-j','6',
        '-Xswiftc','-file-prefix-map','-Xswiftc',str(root)+'=/GuardNook',
        '-Xswiftc','-debug-prefix-map','-Xswiftc',str(Path.home())+'=/Users/build']
    if not args.skip_build: run(command, work/(arch+'-build.log'))
    return Path(subprocess.check_output(command+['--show-bin-path'], text=True).strip())

with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
    builds = dict(zip(['arm64','x64'],executor.map(build,['arm64','x64'])))
cache=args.runtime_cache;cache.mkdir(parents=True,exist_ok=True)
pinned_runtimes=json.loads((root/'Scripts/node-runtime.json').read_text())
manifest={}
for arch in ['arm64','x64']:
    pinned=pinned_runtimes[arch]
    name=pinned['file']
    archive=cache/name
    if not archive.exists():
        with urllib.request.urlopen(pinned['download'],timeout=60) as src,archive.open('wb') as dst:
            while data:=src.read(1024*1024):dst.write(data)
    digest=hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != pinned['sha256']: raise RuntimeError('Node archive checksum mismatch')
    dest=cache/arch;dest.mkdir(exist_ok=True)
    with tarfile.open(archive) as tar:
        for suffix,out in [('/bin/node','node'),('/LICENSE','LICENSE')]:
            member=next(m for m in tar.getmembers() if m.name.endswith(suffix))
            (dest/out).write_bytes(tar.extractfile(member).read())
    (dest/'node').chmod(0o755)
    manifest[arch]={'file':name,'sha256':digest,'download':pinned['download']}

app=work/'GuardNook.app';contents=app/'Contents';macos=contents/'MacOS';resources=contents/'Resources'
macos.mkdir(parents=True);resources.mkdir()
run(['/usr/bin/lipo','-create',str(builds['arm64']/'GuardNook'),str(builds['x64']/'GuardNook'),'-output',str(macos/'GuardNook')])
run(['/usr/bin/strip','-S',str(macos/'GuardNook')])
(macos/'GuardNook').chmod(0o755)
shutil.copytree(builds['arm64']/'GuardNook_GuardNook.bundle',resources/'GuardNook_GuardNook.bundle')
shutil.copytree(root/'Service',resources/'Service',ignore=shutil.ignore_patterns('*.test.mjs','README.md','fixtures'))
for arch in ['arm64','x64']:
    shutil.copytree(cache/arch,resources/'Runtime'/arch)
    run(['/usr/bin/codesign','--force','--sign','-','--timestamp=none',str(resources/'Runtime'/arch/'node')])
(resources/'Runtime'/'DOWNLOADS.json').write_text(json.dumps(manifest,indent=2)+'\n')
iconset=work/'GuardNook.iconset'
run(['swift',str(root/'Scripts/make-icon.swift'),str(iconset),str(root/'Assets/AppIcon.png')])
run(['/usr/bin/iconutil','-c','icns',str(iconset),'-o',str(resources/'GuardNook.icns')])
shutil.copy2(root/'README.md',resources/'使用说明.md')
licenses=resources/'Licenses';licenses.mkdir()
shutil.copy2(root/'LICENSE',licenses/'Project-MIT.txt')
for name in ['LICENSE','LICENSE-MIT-NOOKSURFACE','NOTICE.md']:
    shutil.copy2(root/'Vendor/OpenNook'/name,licenses/('OpenNook-'+name))
shutil.copy2(root/'Vendor/OpenNook/ThirdPartyLicenses/DynamicNotchKit.txt',licenses/'DynamicNotchKit.txt')
shutil.copy2(root/'Sources/GuardNook/Resources/LICENSE-Relaunch.txt',licenses/'Relaunch-MIT.txt')
shutil.copy2(root/'Service/claude-switcher/LICENSE',licenses/'ClaudeSwitcher-MIT.txt')
shutil.copy2(root/'Service/claude-switcher/NOTICE.md',licenses/'ClaudeSwitcher-NOTICE.md')
info={'CFBundleIdentifier':'local.guardnook.app','CFBundleName':'GuardNook','CFBundleDisplayName':'GuardNook','CFBundleExecutable':'GuardNook','CFBundlePackageType':'APPL','CFBundleIconFile':'GuardNook','CFBundleShortVersionString':args.version,'CFBundleVersion':'40','LSMinimumSystemVersion':'15.0','LSUIElement':True,'NSHighResolutionCapable':True}
(contents/'Info.plist').write_bytes(plistlib.dumps(info))
run(['/usr/bin/plutil','-lint',str(contents/'Info.plist')])
run(['/usr/bin/xattr','-cr',str(app)])
for file in app.rglob('*'):
    if file.is_file() and str(Path.home()).encode() in file.read_bytes():
        raise RuntimeError('Private build home path found in packaged file: '+str(file.relative_to(app)))
run(['/usr/bin/codesign','--force','--sign','-','--timestamp=none',str(app)])
run(['/usr/bin/codesign','--verify','--deep','--strict',str(app)])
architectures=subprocess.check_output(['/usr/bin/lipo','-archs',str(macos/'GuardNook')],text=True).strip()
if set(architectures.split()) != {'arm64','x86_64'}: raise RuntimeError('Universal architectures missing')
layout=work/'DMG';layout.mkdir();shutil.copytree(app,layout/'GuardNook.app')
(layout/'Applications').symlink_to('/Applications')
shutil.copy2(root/'README.md',layout/'安装与配置说明.md')
run(['/usr/bin/xattr','-cr',str(layout)])
name='GuardNook-universal'
dmg=args.output/(name+'.dmg')
if dmg.exists(): raise RuntimeError('Refusing to overwrite an existing release')
run(['/usr/bin/hdiutil','create','-volname','GuardNook','-srcfolder',str(layout),'-format','UDZO','-ov',str(dmg)],work/'dmg-build.log')
run(['/usr/bin/hdiutil','verify',str(dmg)],work/'dmg-verify.log')
app_zip=args.output/(name+'.zip')
if app_zip.exists(): raise RuntimeError('Refusing to overwrite an existing release')
run(['/usr/bin/ditto','-c','-k','--norsrc','--noextattr','--noqtn','--keepParent',str(app),str(app_zip)])
report={'version':args.version,'built_at':datetime.datetime.now().astimezone().isoformat(),'architectures':architectures.split(),'macOS_minimum':'15.0','signature':'ad-hoc; not notarized','runtime':manifest,'outputs':{p.name:{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in [dmg,app_zip]}}
(args.output/(name+'-verification.json')).write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'dmg':str(dmg),'app_zip':str(app_zip),'work':str(work),'architectures':architectures.split()}))
