$ErrorActionPreference = "Continue"

$suites = @(
    "suite_nav_topbar.js",
    "suite_compose_transport.js",
    "suite_compose_timeline.js",
    "suite_compose_viewer.js",
    "suite_sources.js",
    "suite_capture.js",
    "suite_graph.js",
    "suite_export.js",
    "suite_shortcuts.js"
)

$results = @()
$totalWatch = [System.Diagnostics.Stopwatch]::StartNew()
$exe = ".\build\Release\ffmpeg-bro-headless.exe"

foreach ($suite in $suites) {
    if (Test-Path "ui/.storage.json") {
        Remove-Item -Force "ui/.storage.json"
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & $exe ui/ "tests/actuate/$suite"
    $code = $LASTEXITCODE
    $sw.Stop()

    $duration = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    $status = if ($code -eq 0) { "PASS" } else { "FAIL" }

    $results += [PSCustomObject]@{
        Suite = $suite
        Status = $status
        Duration = "${duration}s"
        ExitCode = $code
    }
}

if (Test-Path "ui/.storage.json") {
    Remove-Item -Force "ui/.storage.json"
}

$totalWatch.Stop()
$totalDuration = [math]::Round($totalWatch.Elapsed.TotalSeconds, 2)

Write-Host ""
Write-Host "Actuation Test Results:"
$results | Format-Table -AutoSize | Out-String | Write-Host
Write-Host "Total Duration: ${totalDuration}s"

$passed = ($results | Where-Object { $_.ExitCode -eq 0 }).Count
$failed = ($results | Where-Object { $_.ExitCode -ne 0 }).Count

Write-Host "Suites Passed: $passed, Failed: $failed"

if ($failed -gt 0) {
    exit 1
}
exit 0
