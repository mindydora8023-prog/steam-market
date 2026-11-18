$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$entry = [IO.Path]::GetFullPath((Join-Path $root 'app\server.mjs'))

function Test-AppProcess($process) {
    if (-not $process -or $process.Name -ine 'node.exe') { return $false }
    # Match a complete quoted/unquoted argument, never an unescaped path regex.
    $match = [regex]::Match($process.CommandLine, '^\s*(?:"[^"]+"|[^\s"]+)\s+(?:"([^"]+)"|([^\s"]+))(?:\s|$)')
    if (-not $match.Success) { return $false }
    $scriptPath = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    # The launcher passes an absolute entry as the first node argument.
    if (-not [IO.Path]::IsPathRooted($scriptPath)) { return $false }
    try { return ([IO.Path]::GetFullPath($scriptPath) -eq $entry) }
    catch { return $false }
}

$owners = @(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
if ($owners.Count -eq 0) {
    Write-Output 'not-running'
    exit 0
}

# Validate every owner first; never feed an array into a CIM ProcessId filter.
$verified = @()
foreach ($ownerPid in $owners) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
    if (-not (Test-AppProcess $process)) {
        Write-Output 'port-owned-by-another-process'
        exit 1
    }
    $verified += $process
}
foreach ($process in $verified) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ProcessId)" -ErrorAction SilentlyContinue
    if (-not (Test-AppProcess $current) -or $current.CreationDate -ne $process.CreationDate) {
        Write-Output 'process-changed'
        exit 1
    }
    Stop-Process -Id $current.ProcessId -Force
    Write-Output "stopped $($current.ProcessId)"
}
exit 0