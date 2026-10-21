$ErrorActionPreference = 'Stop'
# This script installs/uninstalls only on a disposable hosted CI worker.
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) { throw 'Run this check only on the disposable GitHub Actions runner.' }
$output = Join-Path $env:GITHUB_WORKSPACE 'apps/desktop/dist-electron'
$installers = @(Get-ChildItem -LiteralPath $output -Filter 'noclip-win-x64-*.exe' -File)
if ($installers.Count -ne 1) { throw 'Expected one NoClip installer.' }
$destination = Join-Path $env:RUNNER_TEMP 'noclip-install-smoke'
if (Test-Path -LiteralPath $destination) { throw 'Smoke install directory must be new.' }
$originalData = Join-Path $env:APPDATA 'com.differentai.openwork'
$originalShortcut = Join-Path $env:RUNNER_TEMP 'original-openwork-shortcut.lnk'
$shortcutRecord = Join-Path $originalData 'windows-brand-shortcut.txt'
$fixtures = @(
  $originalShortcut,
  $shortcutRecord,
  (Join-Path $env:APPDATA 'openwork/noclip-original-sentinel.txt'),
  (Join-Path $env:USERPROFILE '.config/opencode/noclip-original-sentinel.txt'),
  (Join-Path $env:USERPROFILE '.local/share/opencode/noclip-original-sentinel.txt')
)
foreach ($file in $fixtures) { if (Test-Path -LiteralPath $file) { throw "Refusing to overwrite existing fixture: $file" } }
function Run-CheckedInstaller($file, $arguments) {
  $process = Start-Process -FilePath $file -ArgumentList $arguments -PassThru
  if (-not $process.WaitForExit(180000)) { throw "Installer timed out: $file" }
  if ($process.ExitCode -ne 0) { throw "Installer failed ($($process.ExitCode)): $file" }
}
try {
  foreach ($file in $fixtures) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
    Set-Content -LiteralPath $file -Value 'original OpenWork data must survive' -Encoding utf8 -NoNewline
  }
  Set-Content -LiteralPath $shortcutRecord -Value $originalShortcut -Encoding ascii -NoNewline
  $before = @{}
  foreach ($file in $fixtures) { $before[$file] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
  Run-CheckedInstaller $installers[0].FullName @('/S', "/D=$destination")
  if (-not (Test-Path -LiteralPath (Join-Path $destination 'NoClip.exe'))) { throw 'NoClip.exe was not installed.' }
  $entry = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Get-ItemProperty | Where-Object { $_.DisplayName -eq 'NoClip' })
  if ($entry.Count -ne 1) { throw 'NoClip must have its own uninstall registry entry.' }
  $uninstaller = Join-Path $destination 'Uninstall NoClip.exe'
  if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'NoClip uninstaller is missing.' }
  Run-CheckedInstaller $uninstaller @('/S')
  $deadline = (Get-Date).AddSeconds(60)
  while ((Test-Path -LiteralPath (Join-Path $destination 'NoClip.exe')) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
  if (Test-Path -LiteralPath (Join-Path $destination 'NoClip.exe')) { throw 'NoClip executable remains after uninstall.' }
  foreach ($file in $fixtures) {
    if (-not (Test-Path -LiteralPath $file)) { throw "Original OpenWork fixture was deleted: $file" }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $before[$file]) { throw "Original OpenWork fixture was changed: $file" }
  }
  $remaining = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Get-ItemProperty | Where-Object { $_.DisplayName -eq 'NoClip' })
  if ($remaining.Count -ne 0) { throw 'NoClip uninstall registry entry remains.' }
  [ordered]@{ ok = $true; installed = 'NoClip.exe'; uninstalled = $true; originalFixturesPreserved = $fixtures.Count; guiLaunchTested = $false } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'INSTALL-SMOKE.json') -Encoding utf8
} finally {
  foreach ($file in $fixtures) { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force } }
}
