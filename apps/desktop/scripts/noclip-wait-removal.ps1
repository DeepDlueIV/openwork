# NSIS starts a temporary uninstaller and exits its bootstrap process early.
# Executable removal is also earlier than registry cleanup: wait for BOTH.
function Wait-NoClipRemoval {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][scriptblock]$ReadState,
    [ValidateRange(0, 600)][int]$TimeoutSeconds = 180,
    [ValidateRange(1, 1000)][int]$PollMilliseconds = 250
  )
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    $state = & $ReadState
    if ($null -eq $state -or $state.ExecutableExists -isnot [bool] -or $state.RegistryExists -isnot [bool]) {
      throw 'Removal probe must return boolean ExecutableExists and RegistryExists.'
    }
    if (-not $state.ExecutableExists -and -not $state.RegistryExists) { return }
    if ($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
      throw "NoClip removal timed out: executable=$($state.ExecutableExists), registry=$($state.RegistryExists)."
    }
    Start-Sleep -Milliseconds $PollMilliseconds
  }
}
