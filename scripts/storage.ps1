# Shared with storage.py. Reading these paths never creates a directory.
function Get-LlmStateRoot([string]$Root) {
    if ($env:LLMR_STATE_ROOT) { return [IO.Path]::GetFullPath($env:LLMR_STATE_ROOT) }
    return Join-Path $Root 'runtime'
}

function Get-LlmPythonDeps([string]$Root) {
    if ($env:LLMR_PYTHON_DEPS) { return [IO.Path]::GetFullPath($env:LLMR_PYTHON_DEPS) }
    return Join-Path $Root 'runtime\python-deps'
}
