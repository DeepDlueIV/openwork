$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/noclip-wait-removal.ps1')
# Regression: removal of the EXE does not mean the NSIS child has finished.
$probe = @{ Calls = 0 }
Wait-NoClipRemoval -PollMilliseconds 1 -ReadState {
  $probe.Calls++
  [pscustomobject]@{ ExecutableExists = ($probe.Calls -lt 2); RegistryExists = ($probe.Calls -lt 4) }
}
if ($probe.Calls -ne 4) { throw 'Returned before registry cleanup completed.' }
$probe.Calls = 0
Wait-NoClipRemoval -PollMilliseconds 1 -ReadState {
  $probe.Calls++
  [pscustomobject]@{ ExecutableExists = ($probe.Calls -lt 3); RegistryExists = $false }
}
if ($probe.Calls -ne 3) { throw 'Returned while the executable still existed.' }
foreach ($state in @(
  [pscustomobject]@{ ExecutableExists = $false; RegistryExists = $true },
  [pscustomobject]@{ ExecutableExists = $true; RegistryExists = $false }
)) {
  $rejected = $false
  try { Wait-NoClipRemoval -TimeoutSeconds 0 -ReadState { $state } }
  catch {
    if ($_.Exception.Message -notlike 'NoClip removal timed out:*') { throw }
    $rejected = $true
  }
  if (-not $rejected) { throw 'A permanent leftover must fail the check.' }
}
Wait-NoClipRemoval -TimeoutSeconds 0 -ReadState {
  [pscustomobject]@{ ExecutableExists = $false; RegistryExists = $false }
}
Write-Host 'Removal regression checks passed (delayed registry, delayed executable, both timeout cases, already removed).'
