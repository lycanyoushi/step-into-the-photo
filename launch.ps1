param([int]$Port = 5181)
$ErrorActionPreference = 'Stop'
$localPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$sharedPython = Join-Path $PSScriptRoot '..\Match-Cut Relay\.venv-sam2\Scripts\python.exe'
$python = 'python'
if (Test-Path -LiteralPath $localPython) {
    $python = $localPython
} elseif (Test-Path -LiteralPath $sharedPython) {
    $python = $sharedPython
}
& $python (Join-Path $PSScriptRoot 'app.py') --port $Port
exit $LASTEXITCODE
