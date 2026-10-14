param([int]$Port = 8767)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.cache\native\models\Qwen3.5-2B-Q4_K_M.gguf'))) { throw '先在專案目錄執行 node scripts/prepare-native.mjs' }
$taskPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) { $taskPython = 'python' }
& $taskPython (Join-Path $PSScriptRoot 'backend\llm_server.py') --port $Port
