import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

function candidate(name, n) {
  if (n === 1) return name;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)} ${n}${ext}`;
}

function localTime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function mountOf(file, device) {
  const own = device(file);
  let directory = path.dirname(file);
  for (;;) {
    const parent = path.dirname(directory);
    if (parent === directory || device(parent) !== own) return directory;
    directory = parent;
  }
}

// Each volume keeps its own trash, like the OS: a file never gets copied onto another disk.
function trashFor(file, { platform, home, env, device, uid }) {
  const homeTrash =
    platform === "darwin"
      ? path.join(home, ".Trash")
      : path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "Trash");
  let anchor = homeTrash;
  while (!fs.existsSync(anchor) && path.dirname(anchor) !== anchor)
    anchor = path.dirname(anchor);
  if (device(anchor) === device(file)) return homeTrash;
  const mount = mountOf(file, device);
  return platform === "darwin"
    ? path.join(mount, ".Trashes", String(uid))
    : path.join(mount, `.Trash-${uid}`);
}

function prepare(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`No Trash is available for ${directory}: ${error.message}`);
  }
}

function macTrash(file, trash) {
  prepare(trash);
  for (let n = 1; ; n++) {
    const target = path.join(trash, candidate(path.basename(file), n));
    if (fs.existsSync(target)) continue;
    fs.renameSync(file, target);
    return;
  }
}

// freedesktop.org Trash specification 1.0: reserve the name with its .trashinfo before moving.
function freedesktopTrash(file, trash) {
  const filesDirectory = path.join(trash, "files");
  const infoDirectory = path.join(trash, "info");
  prepare(filesDirectory);
  prepare(infoDirectory);
  const location = file.split(path.sep).map(encodeURIComponent).join("/");
  for (let n = 1; ; n++) {
    const name = candidate(path.basename(file), n);
    const target = path.join(filesDirectory, name);
    const info = path.join(infoDirectory, `${name}.trashinfo`);
    if (fs.existsSync(target)) continue;
    try {
      fs.writeFileSync(
        info,
        `[Trash Info]\nPath=${location}\nDeletionDate=${localTime(new Date())}\n`,
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    }
    try {
      fs.renameSync(file, target);
    } catch (error) {
      fs.rmSync(info, { force: true });
      throw error;
    }
    return;
  }
}

// SendToRecycleBin deletes permanently when the bin is disabled or too small, so those files are refused first.
const RECYCLE = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName Microsoft.VisualBasic",
  "$bins = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume'",
  "$limits = @{}",
  "foreach ($p in (ConvertFrom-Json $env:ARCA_TRASH)) {",
  "  $root = [System.IO.Path]::GetPathRoot($p)",
  "  $drive = [System.IO.DriveInfo]::new($root)",
  "  if ($drive.DriveType -ne 'Fixed') { throw \"No Recycle Bin on $($drive.Name)\" }",
  "  if (-not $limits.ContainsKey($root)) {",
  "    $volume = Get-CimInstance Win32_Volume | Where-Object { $_.DriveLetter -and ($_.DriveLetter + '\\') -eq $root } | Select-Object -First 1",
  "    $limits[$root] = if ($volume) { Get-ItemProperty -Path (Join-Path $bins ($volume.DeviceID -replace '^\\\\\\\\\\?\\\\Volume' -replace '\\\\$')) -ErrorAction SilentlyContinue }",
  "  }",
  "  $bin = $limits[$root]",
  "  if ($bin.NukeOnDelete -eq 1) { throw \"The Recycle Bin is turned off on $root\" }",
  "  if ($bin.MaxCapacity -and (Get-Item -LiteralPath $p).Length -gt [int64]$bin.MaxCapacity * 1MB) { throw \"$p is larger than the Recycle Bin on $root\" }",
  "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
  "}",
].join("\n");

async function recycle(files, env, execute) {
  for (let start = 0; start < files.length; start += 40) {
    const batch = files.slice(start, start + 40);
    await execute(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", RECYCLE],
      {
        env: { ...env, ARCA_TRASH: JSON.stringify(batch) },
        windowsHide: true,
        timeout: 120000,
      },
    ).catch((error) => {
      throw new Error(
        (error.stderr || error.message || "").toString().trim() ||
          "The Recycle Bin did not respond",
      );
    });
    const left = batch.find((file) => fs.existsSync(file));
    if (left) throw new Error(`Could not move ${left} to the Recycle Bin`);
  }
}

export async function moveToTrash(
  files,
  {
    platform = process.platform,
    home = os.homedir(),
    env = process.env,
    execute = run,
    device = (file) => fs.statSync(file).dev,
    uid = process.getuid?.() ?? 0,
  } = {},
) {
  if (!files.length) return;
  if (platform === "win32") return recycle(files, env, execute);
  for (const file of files) {
    const trash = trashFor(file, { platform, home, env, device, uid });
    if (platform === "darwin") macTrash(file, trash);
    else freedesktopTrash(file, trash);
  }
}
