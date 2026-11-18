param(
    [switch]$CheckOnly,
    [switch]$NoOpen,
    [uri]$BaseUrl = 'http://127.0.0.1:8787/'
)

$ErrorActionPreference = 'Stop'
if (-not $BaseUrl.IsAbsoluteUri -or $BaseUrl.Scheme -notin 'http', 'https' -or
    $BaseUrl.UserInfo -or $BaseUrl.Query -or $BaseUrl.Fragment) {
    throw 'BaseUrl must be an absolute HTTP or HTTPS URL without credentials, query, or fragment.'
}
$url = $BaseUrl.AbsoluteUri.TrimEnd('/') + '/'
$health = $url + 'api/health'

function Test-App {
    try {
        $response = Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 8 -MaximumRedirection 0
        $body = $response.Content | ConvertFrom-Json
        return ($response.StatusCode -eq 200 -and $body.ok -is [bool] -and $body.ok -and
            $body.appId -ceq 'steam-market-price' -and
            $body.version -is [string] -and $body.version.Length -gt 0 -and
            ($body.pid -is [int] -or $body.pid -is [long]) -and $body.pid -gt 0 -and
            $body.proxy -is [string] -and ($body.time -is [string] -or $body.time -is [datetime]))
    } catch {
        return $false
    }
}

function Show-Error([string]$message) {
    if ($NoOpen) { [Console]::Error.WriteLine($message); return }
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($message, 'Steam Price Helper')
}

# CheckOnly must have no launch, browser, lock or process side effects.
if ($CheckOnly) {
    if (Test-App) { Write-Output "ready: $url"; exit 0 }
    Write-Output 'not-ready'
    exit 1
}

if (-not (Test-App)) {
    Show-Error 'The server page is not reachable. Connect Tailscale, then try again.'
    exit 1
}
if (-not $NoOpen) { Start-Process $url }
exit 0
