# Starts a game through build\TyranoPatcher.exe for testing, without touching the player's saves:
#  - the game folder is mirrored (minus *.sav and any old TyranoPatcher.exe) to %TEMP%\TyranoPatcherTest\<game>
#    (incremental, so later runs are fast), and the fresh build is copied in;
#  - the game's Local Storage (%APPDATA%\<app> and %LOCALAPPDATA%\<app>) is backed up right now, for
#    test-stop.ps1 to restore. The copy shares that storage with the real game (same app name).
# Prints the DevTools port, taken from the copy's own process (never from %TEMP%\TyranoPatcher.log,
# which the player's own launches overwrite).
#
#   powershell -File tools\test-start.ps1 -Game <game folder>
param(
  [Parameter(Mandatory)] [string]$Game,
  [string]$AppName  # Local Storage folder name; default: "name" from the game's package.json
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$Game = (Resolve-Path $Game).Path
$name = Split-Path $Game -Leaf
$work = Join-Path $env:TEMP "TyranoPatcherTest"
$copy = Join-Path $work $name
$backup = Join-Path $work "$name.storage-backup"

if (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$copy\*" }) {
  throw "A test copy of $name is already running; run test-stop.ps1 first."
}

if (-not $AppName) {
  $asar = Join-Path $Game 'resources\app.asar'
  if (-not (Test-Path $asar)) { throw "No resources\app.asar; pass -AppName." }
  $AppName = (node "$PSScriptRoot\asar-pick.mjs" $asar - '^package\.json$' | ConvertFrom-Json).name
}

robocopy $Game $copy /MIR /XF *.sav TyranoPatcher.exe TyranoPatcher.ini /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
Copy-Item "$root\build\TyranoPatcher.exe" $copy -Force
if (Test-Path "$Game\TyranoPatcher.ini") { Copy-Item "$Game\TyranoPatcher.ini" $copy -Force }

# Fresh backup, every run (the player may have played since the last one).
if (Test-Path $backup) { Remove-Item $backup -Recurse -Force }
New-Item -ItemType Directory $backup | Out-Null
foreach ($base in @($env:APPDATA, $env:LOCALAPPDATA)) {
  $ls = Join-Path $base "$AppName\Local Storage"
  if (Test-Path $ls) {
    $dst = Join-Path $backup ($(if ($base -eq $env:APPDATA) { 'Roaming' } else { 'Local' }))
    Copy-Item $ls $dst -Recurse
  }
}
Set-Content (Join-Path $backup 'appname.txt') $AppName

Start-Process (Join-Path $copy 'TyranoPatcher.exe')
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  $p = Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -like "$copy\*" -and $_.CommandLine -match '--remote-debugging-port=(\d+)' }
  if ($p) { $port = [regex]::Match(@($p)[0].CommandLine, '--remote-debugging-port=(\d+)').Groups[1].Value; break }
}
if (-not $port) { throw "Game did not start with a debugging port." }
"copy:  $copy"
"app:   $AppName"
"port:  $port"
