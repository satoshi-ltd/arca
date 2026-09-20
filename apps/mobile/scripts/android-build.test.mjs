import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(root, '../..');
const script = path.join(root, 'scripts/android-build.mjs');
const scripts = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).scripts;

test('the four build scripts and check:release live here, none at the repository root', () => {
  const mobile = scripts(path.join(root, 'package.json'));
  assert.equal(mobile['build:dev'], 'node scripts/android-build.mjs dev');
  assert.equal(mobile['build:prod'], 'node scripts/android-build.mjs prod');
  assert.equal(mobile['build:local:dev'], 'node scripts/android-build.mjs dev --local');
  assert.equal(mobile['build:local:prod'], 'node scripts/android-build.mjs prod --local');
  assert.equal(mobile['check:release'], 'node ../../scripts/check-release.js');
  assert.equal(mobile['build:preview'], undefined);
  const top = Object.keys(scripts(path.join(repository, 'package.json')));
  assert.deepEqual(top.filter((key) => /mobile|build:(local|dev|prod)/.test(key)), []);
  const ignored = spawnSync('git', ['check-ignore', '-q', 'apps/mobile/release-assets/x.apk'], { cwd: repository });
  assert.equal(ignored.status, 0);
});

test('android-build rejects bad arguments, stops on check:release and derives the APK name', (t) => {
  const unknown = spawnSync(process.execPath, [script, 'preview'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /dev\|prod/);
  assert.match(spawnSync(process.execPath, [script, 'prod', '--install-only'], { encoding: 'utf8' }).stderr, /dev builds/);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-android-build-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, 'scripts'));
  fs.mkdirSync(path.join(fixture, 'node_modules/expo'), { recursive: true });
  fs.copyFileSync(script, path.join(fixture, 'scripts/android-build.mjs'));
  fs.writeFileSync(
    path.join(fixture, 'app.json'),
    JSON.stringify({ expo: { version: '1.2.3', android: { package: 'com.example.demo' } } }),
  );
  const build = (check, ...args) => {
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ scripts: { 'check:release': check } }));
    return spawnSync(process.execPath, [path.join(fixture, 'scripts/android-build.mjs'), ...args], { encoding: 'utf8' });
  };
  assert.equal(build('exit 3', 'dev', '--install-only').status, 3);
  assert.ok(!fs.existsSync(path.join(fixture, 'release-assets')));
  const missing = build('exit 0', 'dev', '--install-only');
  assert.equal(missing.status, 1);
  assert.ok(missing.stderr.includes(path.join('release-assets', 'demo-1.2.3-android-dev.apk')), missing.stderr);
});
