#!/usr/bin/env python3
"""Bounded Android Jenkins executor. Run from the checked-out application workspace.
The runner must come from a pinned, trusted platform revision, not the application.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


def run(*args, timeout=60):
    result = subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    return result.stdout.decode('utf-8', errors='replace').strip()


def env(name, pattern=None):
    value = os.environ.get(name, '')
    if not value or (pattern and not re.fullmatch(pattern, value)):
        raise ValueError('Missing or invalid ' + name)
    return value


def digest(file):
    sha = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            sha.update(chunk)
    return sha.hexdigest()


def relative_file(value):
    file = Path(value)
    if file.is_absolute() or '..' in file.parts or not re.fullmatch(r'[\w./-]+', value):
        raise ValueError('Invalid relative artifact path')
    if not file.resolve().is_relative_to(Path.cwd().resolve()):
        raise ValueError('Artifact escapes workspace')
    return file


def base(kind):
    return dict(schemaVersion=1, kind=kind, requestId=env('PLATFORM_REQUEST_ID', r'[\w-]+'),
                applicationId=env('APPLICATION_ID', r'[\w:-]+'), packageId=env('PACKAGE_ID', r'[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+'),
                commit=env('COMMIT', r'[a-f0-9]{40}'))


def apk_identity(apk):
    # apkanalyzer and apksigner must be provisioned on the Android Jenkins agent.
    summary = run('apkanalyzer', 'apk', 'summary', str(apk)).split(maxsplit=2)
    if len(summary) != 3 or not re.fullmatch(r'[1-9]\d{0,9}', summary[1]):
        raise ValueError('Cannot read APK identity')
    run('apksigner', 'verify', str(apk))
    return summary


def build():
    manifest = base('build')
    actual = run('git', 'rev-parse', 'HEAD')
    if actual != manifest['commit']:
        raise ValueError('Checkout does not match fixed Commit')
    variant = env('BUILD_VARIANT', r'[A-Za-z][A-Za-z0-9]{0,79}')
    apk = relative_file(env('APK_PATH'))
    # The Jenkinsfile cleans the workspace; refuse a preexisting APK nevertheless.
    if apk.exists():
        raise ValueError('APK already exists before build')
    run('./gradlew', '--no-daemon', 'assemble' + variant[0].upper() + variant[1:], timeout=1500)
    if run('git', 'rev-parse', 'HEAD') != manifest['commit']:
        raise ValueError('Build changed the fixed Commit')
    apk = relative_file(str(apk))
    package, version_code, version_name = apk_identity(apk)
    if package != manifest['packageId']:
        raise ValueError('Built package ID does not match application')
    manifest.update(apkPath=str(apk), sha256=digest(apk), versionCode=version_code, versionName=version_name)
    Path('mobile-delivery.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')


def smoke():
    manifest = base('smoke')
    serial = env('DEVICE_SERIAL', r'[A-Za-z0-9_.:-]{1,160}')
    apk = relative_file('source/' + env('APK_PATH'))
    expected_hash = env('APK_SHA256', r'[a-f0-9]{64}')
    if digest(apk) != expected_hash:
        raise ValueError('Source APK SHA256 mismatch')
    package, version_code, version_name = apk_identity(apk)
    if (package, version_code, version_name) != (manifest['packageId'], env('VERSION_CODE'), env('VERSION_NAME')):
        raise ValueError('Source APK identity mismatch')
    manifest.update(sourceRunId=env('SOURCE_RUN_ID'), sourceJob=env('SOURCE_JOB'), sourceBuild=int(env('SOURCE_BUILD', r'[1-9]\d*')),
                    deviceSerial=serial, sha256=expected_hash, passed=False, launchPassed=False, crashDetected=False, anrDetected=False)
    evidence = Path('android-evidence')
    evidence.mkdir(exist_ok=True)
    adb = lambda *args, timeout=60: run('adb', '-s', serial, *args, timeout=timeout)
    logger = None
    log_file = None
    try:
        if adb('get-state') != 'device':
            raise ValueError('Selected adb device is not ready')
        adb('install', '-r', str(apk), timeout=180)
        dump = adb('shell', 'dumpsys', 'package', package)
        (evidence / 'package.txt').write_text(dump, encoding='utf-8')
        code = re.search(r'\bversionCode=(\d+)', dump)
        name = re.search(r'\bversionName=([^\r\n]+)', dump)
        if not code or not name or (code[1], name[1].strip()) != (version_code, version_name):
            raise ValueError('Installed version mismatch')
        installed = adb('shell', 'pm', 'path', package).splitlines()
        if len(installed) != 1 or not installed[0].startswith('package:/'):
            raise ValueError('Expected a single installed APK')
        pulled = evidence / 'installed.apk'
        adb('pull', installed[0][len('package:'):], str(pulled), timeout=180)
        if digest(pulled) != expected_hash:
            raise ValueError('Installed APK checksum mismatch')
        pulled.unlink()
        manifest.update(installedPackageId=package, installedVersionCode=code[1], installedVersionName=name[1].strip())
        adb('shell', 'am', 'force-stop', package)
        # Capture new device logs without clearing other users\' log buffers.
        since = adb('shell', 'date', '+%m-%dT%H:%M:%S.000').replace('T', ' ')
        log_file = (evidence / 'logcat.txt').open('wb')
        logger = subprocess.Popen(['adb', '-s', serial, 'logcat', '-v', 'threadtime', '-T', since], stdout=log_file, stderr=subprocess.DEVNULL)
        activity = adb('shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', package).splitlines()[-1]
        if not activity.startswith(package + '/') or not re.fullmatch(r'[\w.$/]+', activity):
            raise ValueError('No valid launcher activity')
        launch = adb('shell', 'am', 'start', '-W', '-n', "'" + activity + "'")
        if 'Status: ok' not in launch:
            raise ValueError('Launch failed')
        time.sleep(10)
        if not adb('shell', 'pidof', package):
            raise ValueError('App process exited during launch Smoke')
        screen = subprocess.run(['adb', '-s', serial, 'exec-out', 'screencap', '-p'], check=True, capture_output=True, timeout=30).stdout
        if not screen.startswith(b'\x89PNG\r\n\x1a\n'):
            raise ValueError('Missing screenshot')
        (evidence / 'screen.png').write_bytes(screen)
        manifest['launchPassed'] = True
    finally:
        if not (evidence / 'screen.png').exists() and manifest.get('installedPackageId'):
            try:
                screen = subprocess.run(['adb', '-s', serial, 'exec-out', 'screencap', '-p'], check=True, capture_output=True, timeout=30).stdout
                if screen.startswith(b'\x89PNG\r\n\x1a\n'):
                    (evidence / 'screen.png').write_bytes(screen)
            except (subprocess.SubprocessError, OSError):
                pass
        if logger:
            logger.terminate()
            try:
                logger.wait(timeout=10)
            except subprocess.TimeoutExpired:
                logger.kill()
                logger.wait(timeout=5)
        if log_file:
            log_file.close()
        log_path = evidence / 'logcat.txt'
        logs = log_path.read_text(errors='replace') if log_path.exists() else ''
        # Java crash process lines and system ANR lines; this is a bounded launch check.
        manifest['crashDetected'] = bool(re.search(r'(?:Process: |am_crash[^\n]*)' + re.escape(package) + r'(?:[,:\s]|$)', logs))
        manifest['anrDetected'] = bool(re.search(r'(?:ANR in |am_anr[^\n]*)' + re.escape(package) + r'(?:[,:\s]|$)', logs))
        manifest['passed'] = manifest['launchPassed'] and not manifest['crashDetected'] and not manifest['anrDetected']
        manifest['evidence'] = {key: str(evidence / file) for key, file in [('logcat', 'logcat.txt'), ('screenshot', 'screen.png'), ('packageDump', 'package.txt')] if (evidence / file).exists()}
        manifest['evidenceSha256'] = {key: digest(file) for key, file in manifest['evidence'].items()}
        Path('mobile-quality.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
    if not manifest['passed']:
        raise ValueError('Launch Smoke failed (Crash/ANR or launch failure)')


if __name__ == '__main__':
    if sys.argv[1:] == ['build']:
        build()
    elif sys.argv[1:] == ['smoke']:
        smoke()
    else:
        raise SystemExit('Usage: runner.py build|smoke')
