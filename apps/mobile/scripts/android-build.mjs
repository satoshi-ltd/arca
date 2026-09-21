import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
const local = process.argv.includes('--local');
const installOnly = process.argv.includes('--install-only');
const profile = { dev: 'development', prod: 'production' }[mode];
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (!profile) fail('Use android-build.mjs dev|prod [--local] [--install-only]');
if (installOnly && mode !== 'dev') fail('--install-only is for dev builds');

const sdk =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  (process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Android/sdk') : path.join(os.homedir(), 'Android/Sdk'));
const java =
  process.env.JAVA_HOME ||
  (process.platform === 'darwin' ? '/Applications/Android Studio.app/Contents/jbr/Contents/Home' : undefined);
const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ...(java ? { JAVA_HOME: java } : {}) };
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  return result;
};

if (!fs.existsSync(path.join(root, 'node_modules/expo'))) fail('Install dependencies first');
const check = read('package.json').scripts?.['check:release'];
if (!check) fail('package.json needs a check:release script');
run(check, [], { shell: true });

const { expo } = read('app.json');
const application = expo.android.package;
const output = path.join(
  root,
  'release-assets',
  `${application.split('.').pop()}-${expo.version}-android${mode === 'dev' ? '-dev' : ''}.apk`,
);
fs.mkdirSync(path.dirname(output), { recursive: true });

if (!installOnly) {
  const eas = ['--yes', 'eas-cli', 'build', '--platform', 'android', '--profile', profile];
  if (local) {
    run('npx', [...eas, '--local', '--output', output]);
  } else {
    const { stdout } = run('npx', [...eas, '--json', '--non-interactive'], {
      stdio: ['inherit', 'pipe', 'inherit'],
      encoding: 'utf8',
    });
    const url = JSON.parse(stdout)[0]?.artifacts?.applicationArchiveUrl;
    if (!url) fail('EAS did not report an APK URL');
    const response = await fetch(url);
    if (!response.ok) fail(`APK download failed: ${response.status} ${response.statusText}`);
    fs.writeFileSync(output, Buffer.from(await response.arrayBuffer()));
  }
}
if (!fs.existsSync(output)) fail(`No APK at ${output}`);
console.log(`APK: ${output}`);

if (mode === 'dev') {
  const adb = path.join(sdk, 'platform-tools/adb');
  const emulator = path.join(sdk, 'emulator/emulator');
  const avd = process.env.ANDROID_AVD || 'Pixel_9_Pro_Fold';

  const query = (args) => {
    const result = spawnSync(adb, args, { env, encoding: 'utf8', timeout: 15000 });
    if (result.error && result.error.code !== 'ETIMEDOUT') throw result.error;
    return result.status === 0 ? result.stdout.trim() : '';
  };
  const attached = () =>
    query(['devices'])
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.split(/\s+/))
      .filter(([, state]) => state === 'device')
      .map(([serial]) => serial);
  const avdOf = (serial) => query(['-s', serial, 'emu', 'avd', 'name']).split(/\r?\n/)[0];
  const booted = (serial) => query(['-s', serial, 'shell', 'getprop', 'sys.boot_completed']) === '1';
  const target = () => {
    const serials = attached();
    const emulators = serials.filter((serial) => serial.startsWith('emulator-'));
    return (
      process.env.ANDROID_SERIAL ||
      serials.find((serial) => !serial.startsWith('emulator-')) ||
      emulators.find((serial) => avdOf(serial) === avd) ||
      emulators[0]
    );
  };

  let serial = target();
  if (!serial) {
    const available = spawnSync(emulator, ['-list-avds'], { env, encoding: 'utf8' });
    if (!available.stdout?.split(/\r?\n/).includes(avd)) fail(`No device attached and no emulator named ${avd}`);
    const child = spawn(emulator, ['-avd', avd], { env, detached: true, stdio: 'ignore' });
    child.on('error', (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    child.unref();
  }

  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    serial = target();
    if (serial && booted(serial)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!serial || !booted(serial)) fail('Device did not become ready within 3 minutes');

  // Never uninstall or clear user data to work around a signing/version mismatch.
  run(adb, ['-s', serial, 'install', '-r', output]);
  run(adb, ['-s', serial, 'reverse', 'tcp:8081', 'tcp:8081']);
  run(adb, ['-s', serial, 'shell', 'am', 'start', '-n', `${application}/.MainActivity`]);
  console.log(`Installed on ${serial}. Start Metro yourself.`);
}
