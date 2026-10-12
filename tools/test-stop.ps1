# Stops a test copy started by test-start.ps1 (only processes running from the copy's folder; the
# player may have the real game open) and restores the Local Storage backup taken by that start.
# The restore is skipped when another instance of the game is running, since it would overwrite
# what that instance is writing.
#
#   powershell -File tools\test-stop.ps1 -Game <game folder>
param([Parameter(Mandatory)] [string]$Game)
$ErrorActionPreference = 'Stop'
$name = Split-Path (Resolve-Path $Game).Path -Leaf
$work = Join-Path $env:TEMP "TyranoPatcherTest"
$copy = Join-Path $work $name
$backup = Join-Path $work "$name.storage-backup"

$mine = { Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$copy\*" } }
foreach ($p in & $mine) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }
for ($i = 0; $i -lt 20 -and (& $mine); $i++) { Start-Sleep -Milliseconds 250 }
if (& $mine) { throw "Test processes are still running." }

if (-not (Test-Path "$backup\appname.txt")) { "No backup to restore."; return }
$AppName = (Get-Content "$backup\appname.txt").Trim()
$exes = Get-ChildItem (Resolve-Path $Game).Path -Filter *.exe | Where-Object Name -ne 'TyranoPatcher.exe' | ForEach-Object Name
$others = Get-CimInstance Win32_Process | Where-Object { $exes -contains $_.Name }
if ($others) {
  "Another instance of the game is running (" + (@($others)[0].ExecutablePath) + "): Local Storage NOT restored."
  return
}
foreach ($kind in 'Roaming', 'Local') {
  $src = Join-Path $backup $kind
  if (-not (Test-Path $src)) { continue }
  $base = if ($kind -eq 'Roaming') { $env:APPDATA } else { $env:LOCALAPPDATA }
  $dst = Join-Path $base "$AppName\Local Storage"
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  Copy-Item $src $dst -Recurse
  "Restored $dst"
}
Remove-Item $backup -Recurse -Force
