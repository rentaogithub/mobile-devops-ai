import contextlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('runner', Path(__file__).with_name('runner.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class AndroidRunnerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.original = Path.cwd()
        os.chdir(self.temp.name)
        self.addCleanup(os.chdir, self.original)
        self.addCleanup(self.temp.cleanup)
        self.config = dict(PLATFORM_REQUEST_ID='request-id', APPLICATION_ID='application-id', PACKAGE_ID='com.test.app', COMMIT='a' * 40,
                           APK_PATH='app/build/app.apk', BUILD_VARIANT='debug', DEVICE_SERIAL='test-device', VERSION_CODE='1', VERSION_NAME='1.0',
                           SOURCE_RUN_ID='build-id', SOURCE_JOB='android/build', SOURCE_BUILD='12')
        self.patch_env = patch.dict(os.environ, self.config)
        self.patch_env.start()
        self.addCleanup(self.patch_env.stop)

    def test_wrong_commit_never_invokes_gradle(self):
        with patch.object(runner, 'run', return_value='b' * 40) as cmd:
            with self.assertRaisesRegex(ValueError, 'fixed Commit'):
                runner.build()
            self.assertEqual(cmd.call_count, 1)
            self.assertFalse(Path('mobile-delivery.json').exists())

    def test_build_attests_actual_apk_identity_and_hash(self):
        def command(*args, **kwargs):
            if args[0] == 'git':
                return 'a' * 40
            if args[0] == './gradlew':
                self.assertIn('assembleDebug', args)
                file = Path(self.config['APK_PATH'])
                file.parent.mkdir(parents=True)
                file.write_bytes(b'apk')
                return ''
            if args[0] == 'apkanalyzer':
                return 'com.test.app 1 1.0'
            if args[0] == 'apksigner':
                return ''
            self.fail('Unexpected command')
        with patch.object(runner, 'run', side_effect=command):
            runner.build()
        manifest = json.loads(Path('mobile-delivery.json').read_text())
        self.assertEqual(manifest['sha256'], runner.digest(self.config['APK_PATH']))
        self.assertEqual(manifest['versionCode'], '1')

    def test_rejects_stale_apk_and_paths_outside_workspace(self):
        apk = Path(self.config['APK_PATH'])
        apk.parent.mkdir(parents=True)
        apk.write_bytes(b'old')
        with patch.object(runner, 'run', return_value='a' * 40) as cmd:
            with self.assertRaisesRegex(ValueError, 'already exists'):
                runner.build()
            self.assertEqual(cmd.call_count, 1)
        for value in ('../app.apk', '/tmp/app.apk'):
            with self.assertRaises(ValueError):
                runner.relative_file(value)

    def test_wrong_source_apk_never_touches_device(self):
        apk = Path('source') / self.config['APK_PATH']
        apk.parent.mkdir(parents=True)
        apk.write_bytes(b'tampered')
        with patch.dict(os.environ, APK_SHA256='a' * 64), patch.object(runner, 'run') as cmd:
            with self.assertRaisesRegex(ValueError, 'SHA256 mismatch'):
                runner.smoke()
            cmd.assert_not_called()

    def test_wrong_installed_version_never_launches_app(self):
        apk = Path('source') / self.config['APK_PATH']
        apk.parent.mkdir(parents=True)
        apk.write_bytes(b'apk')
        def command(*args, **kwargs):
            if args[0] == 'apkanalyzer':
                return 'com.test.app 1 1.0'
            if args[0] == 'apksigner':
                return ''
            if args[3:] == ('get-state',):
                return 'device'
            if 'install' in args:
                return 'Success'
            if 'dumpsys' in args:
                return 'versionCode=2\nversionName=2.0'
            self.fail('Device launch must not happen for mismatched installed version')
        with patch.dict(os.environ, APK_SHA256=runner.digest(apk)), patch.object(runner, 'run', side_effect=command):
            with self.assertRaisesRegex(ValueError, 'Installed version mismatch'):
                runner.smoke()
        self.assertFalse(json.loads(Path('mobile-quality.json').read_text())['passed'])

    def execute_smoke(self, logs):
        apk = Path('source') / self.config['APK_PATH']
        apk.parent.mkdir(parents=True)
        apk.write_bytes(b'apk')
        def command(*args, **kwargs):
            if args[0] == 'apkanalyzer': return 'com.test.app 1 1.0'
            if args[0] == 'apksigner': return ''
            if args[3:] == ('get-state',): return 'device'
            if 'install' in args: return 'Success'
            if 'dumpsys' in args: return 'versionCode=1\nversionName=1.0'
            if 'pm' in args: return 'package:/data/app/base.apk'
            if 'pull' in args:
                Path(args[-1]).write_bytes(b'apk')
                return ''
            if 'force-stop' in args: return ''
            if 'date' in args: return '09-08 00:00:00.000'
            if 'resolve-activity' in args: return 'com.test.app/.MainActivity'
            if 'start' in args: return 'Status: ok'
            if 'pidof' in args: return '123'
            self.fail('Unexpected command: ' + repr(args))
        def logger(*args, **kwargs):
            kwargs['stdout'].write(logs.encode())
            return Mock()
        return contextlib.ExitStack(), [
            patch.dict(os.environ, APK_SHA256=runner.digest(apk)), patch.object(runner, 'run', side_effect=command),
            patch.object(runner.subprocess, 'Popen', side_effect=logger),
            patch.object(runner.subprocess, 'run', return_value=SimpleNamespace(stdout=b'\x89PNG\r\n\x1a\nfixture')),
            patch.object(runner.time, 'sleep'),
        ]

    def test_successful_smoke_attests_installed_bytes_and_archived_evidence(self):
        stack, patches = self.execute_smoke('I ActivityManager: started com.test.app')
        with stack:
            for item in patches: stack.enter_context(item)
            runner.smoke()
        manifest = json.loads(Path('mobile-quality.json').read_text())
        self.assertTrue(manifest['passed'])
        self.assertEqual(manifest['installedPackageId'], 'com.test.app')
        self.assertEqual(manifest['installedVersionCode'], '1')
        self.assertEqual(set(manifest['evidence']), {'logcat', 'screenshot', 'packageDump'})
        for key, file in manifest['evidence'].items():
            self.assertEqual(manifest['evidenceSha256'][key], runner.digest(file))

    def test_detected_java_crash_fails_smoke_and_preserves_raw_evidence(self):
        stack, patches = self.execute_smoke('E AndroidRuntime: Process: com.test.app, PID: 123')
        with stack:
            for item in patches: stack.enter_context(item)
            with self.assertRaisesRegex(ValueError, 'Smoke failed'):
                runner.smoke()
        manifest = json.loads(Path('mobile-quality.json').read_text())
        self.assertFalse(manifest['passed'])
        self.assertTrue(manifest['crashDetected'])
        self.assertTrue(Path(manifest['evidence']['logcat']).exists())


if __name__ == '__main__':
    unittest.main()
