$ErrorActionPreference = 'Stop'
# Never install or remove applications on a developer's personal machine.
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) { throw 'Run only on the disposable GitHub Actions runner.' }
. (Join-Path $PSScriptRoot 'noclip-wait-removal.ps1')
$output = Join-Path $env:GITHUB_WORKSPACE 'apps/desktop/dist-electron'
$oldOutput = Join-Path $env:GITHUB_WORKSPACE 'apps/desktop/dist-electron-upgrade-from'
$installers = @(Get-ChildItem -LiteralPath $output -Filter 'noclip-win-x64-*.exe' -File)
$olderInstallers = @(Get-ChildItem -LiteralPath $oldOutput -Filter 'noclip-win-x64-*.exe' -File)
if ($installers.Count -ne 1 -or $olderInstallers.Count -ne 1) { throw 'Expected one installer of each version.' }
if (-not $env:TEST_APP_VERSION -or -not $env:UPGRADE_FROM_VERSION) { throw 'Both package versions are required.' }
$destination = Join-Path $env:RUNNER_TEMP 'noclip install smoke'
$executable = Join-Path $destination 'NoClip.exe'
$registryRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
function Get-NoClipEntries {
  # A fresh account has no per-user uninstall root until its first install.
  # Missing is empty; access/enumeration errors must still fail the check.
  if (-not (Test-Path -LiteralPath $registryRoot)) { return @() }
  @(Get-ChildItem -LiteralPath $registryRoot | Get-ItemProperty | Where-Object { $_.DisplayName -eq 'NoClip' })
}
if ((Test-Path -LiteralPath $destination) -or @(Get-NoClipEntries).Count) { throw 'Refusing to overwrite an existing installation.' }
$originalShortcut = Join-Path $env:RUNNER_TEMP 'original-openwork-shortcut.lnk'
$shortcutRecord = Join-Path $env:APPDATA 'com.differentai.openwork/windows-brand-shortcut.txt'
$originalFixtures = @(
  $originalShortcut, $shortcutRecord,
  (Join-Path $env:APPDATA 'openwork/noclip-original-sentinel.txt'),
  (Join-Path $env:USERPROFILE '.config/opencode/noclip-original-sentinel.txt'),
  (Join-Path $env:USERPROFILE '.local/share/opencode/noclip-original-sentinel.txt')
)
$profile = Join-Path $env:USERPROFILE '.noclip'
$profileFixtures = @(
  (Join-Path $profile 'desktop/noclip-retention-test.json'),
  (Join-Path $profile 'runtime/config/server.json'),
  (Join-Path $profile 'runtime/config/tokens.json'),
  (Join-Path $profile 'runtime/opencode/data/opencode.db')
)
$fixtures = @($originalFixtures) + @($profileFixtures)
foreach ($file in $fixtures) { if (Test-Path -LiteralPath $file) { throw "Refusing to overwrite fixture: $file" } }
function Run-CheckedInstaller($file, $arguments) {
  Write-Host "Running installer: $([System.IO.Path]::GetFileName($file))"
  $process = Start-Process -FilePath $file -ArgumentList $arguments -PassThru
  if (-not $process.WaitForExit(300000)) { throw "Installer bootstrap timed out: $file" }
  $process.Refresh()
  if ($process.ExitCode -ne 0) { throw "Installer failed ($($process.ExitCode)): $file" }
}
function Assert-FixturesUnchanged($before, $stage) {
  foreach ($file in $fixtures) {
    if (-not (Test-Path -LiteralPath $file)) { throw "$stage deleted fixture: $file" }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $before[$file]) { throw "$stage changed fixture: $file" }
  }
}
function Assert-InstalledVersion($version, $packageOutput) {
  if (-not (Test-Path -LiteralPath $executable)) { throw 'NoClip.exe was not installed in the original location.' }
  $entries = @(Get-NoClipEntries)
  if ($entries.Count -ne 1) { throw "Expected one NoClip uninstall entry, found $($entries.Count)." }
  if ($entries[0].DisplayVersion -ne $version) { throw "Registry version $($entries[0].DisplayVersion) does not match $version." }
  # electron-builder writes InstallLocation to its separate install key, NOT
  # the Windows uninstall entry. Check the registered command and real payload.
  $uninstaller = Join-Path $destination 'Uninstall NoClip.exe'
  $expectedCommand = '"{0}" /currentuser' -f $uninstaller
  if ([string]$entries[0].UninstallString -ne $expectedCommand) { throw 'Registered uninstaller does not match the original installation path and scope.' }
  if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Registered uninstaller is missing.' }
  $installedArchive = Join-Path $destination 'resources/app.asar'
  $expectedArchive = Join-Path $packageOutput 'win-unpacked/resources/app.asar'
  if ((Get-FileHash -LiteralPath $installedArchive -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $expectedArchive -Algorithm SHA256).Hash) {
    throw "Installed application payload does not match the package for $version."
  }
  return $entries[0].PSPath
}
function Remove-TestInstallation($entryPath) {
  $uninstaller = Join-Path $destination 'Uninstall NoClip.exe'
  if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'NoClip uninstaller is missing.' }
  # Match Windows' registered quiet uninstall scope; never execute registry text.
  Run-CheckedInstaller $uninstaller @('/currentuser', '/S')
  Wait-NoClipRemoval -ReadState {
    [pscustomobject]@{
      ExecutableExists = [bool](Test-Path -LiteralPath $executable)
      RegistryExists = [bool](Test-Path -LiteralPath $entryPath)
    }
  }
  if (@(Get-NoClipEntries).Count -ne 0) { throw 'An additional NoClip uninstall entry remains.' }
}
try {
  Run-CheckedInstaller $olderInstallers[0].FullName @('/S', "/D=$destination")
  $initialEntry = Assert-InstalledVersion $env:UPGRADE_FROM_VERSION $oldOutput
  # Fixture bytes stand in for settings, credentials and a database. The GUI
  # is not launched here; this checks preservation, not database migrations.
  foreach ($file in $fixtures) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
    Set-Content -LiteralPath $file -Value '{"fixture":"preserve this exact data"}' -Encoding utf8 -NoNewline
  }
  Set-Content -LiteralPath $shortcutRecord -Value $originalShortcut -Encoding ascii -NoNewline
  $before = @{}
  foreach ($file in $fixtures) { $before[$file] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }

  # No manual uninstall and no /D: the new installer must discover and replace
  # the existing application, keeping a single identity and its original path.
  Run-CheckedInstaller $installers[0].FullName @('/S')
  $upgradedEntry = Assert-InstalledVersion $env:TEST_APP_VERSION $output
  if ($upgradedEntry -ne $initialEntry) { throw 'Upgrade changed the application identity.' }
  Assert-FixturesUnchanged $before 'Upgrade'

  Remove-TestInstallation $upgradedEntry
  Assert-FixturesUnchanged $before 'Uninstall'
  Run-CheckedInstaller $installers[0].FullName @('/S', "/D=$destination")
  $reinstalledEntry = Assert-InstalledVersion $env:TEST_APP_VERSION $output
  Assert-FixturesUnchanged $before 'Reinstall'
  Remove-TestInstallation $reinstalledEntry
  Assert-FixturesUnchanged $before 'Final uninstall'
  [ordered]@{
    ok = $true; upgradeFrom = $env:UPGRADE_FROM_VERSION; upgradeTo = $env:TEST_APP_VERSION
    inPlaceUpgrade = $true; sameRegistryIdentity = $true; installedPayloadVerified = $true; reinstall = $true; uninstalled = $true
    originalFixturesPreserved = $originalFixtures.Count; profileFixturesPreserved = $profileFixtures.Count
    olderInstallerUsesSameSource = $true; guiLaunchTested = $false; databaseMigrationTested = $false
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'INSTALL-SMOKE.json') -Encoding utf8
  Write-Host 'Install, in-place version upgrade, uninstall and reinstall passed; all fixture and installed payload hashes match.'
} finally {
  # Delete only the exact test fixtures, never a user's profile tree or registry.
  foreach ($file in $fixtures) { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force } }
}
