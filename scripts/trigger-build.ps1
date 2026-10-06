<#
.SYNOPSIS
    Trigger the GitHub Actions docker-hub workflow to build & push opencode-gate.

.DESCRIPTION
    Dispatches qq4756283/Actions-buildUtils :: docker-hub.yml (ref=master).
    That repo already carries the DOCKER_HUB_USERNAME / DOCKER_HUB_ACCESS_TOKEN
    secrets, so this repository does not need its own copy.

    NOTE: messages are intentionally ASCII-only. Windows PowerShell 5.1 parses
    .ps1 files as ANSI when there is no UTF-8 BOM, which mangles non-ASCII text
    and can break string terminators.

.EXAMPLE
    scripts\trigger-build.cmd
    scripts\trigger-build.cmd -NoTimeTag
    scripts\trigger-build.cmd -RepoUrl https://github.com/spfnas/opencode2api-free.git
    scripts\trigger-build.cmd -Tags latest,dev -Platforms linux/amd64
#>
[CmdletBinding()]
param(
    [string]$RepoUrl       = 'https://github.com/qq4756283/opencode2api-free.git',
    [string]$RepoBranch    = 'main',
    [string]$ImageName     = 'opencode-gate',
    [string]$DockerFileUrl = 'https://raw.githubusercontent.com/qq4756283/opencode2api-free/main/Dockerfile',
    [string]$Platforms     = 'linux/amd64,linux/arm64',
    [string]$Tags          = 'latest',
    [ValidateSet('none','y-md_H-m-s','y-md_H-m','md_H-m-s','md_H-m')]
    [string]$TimeTag       = 'y-md_H-m-s',
    [string]$TimeTagPrefix = ''
)

$ErrorActionPreference = 'Stop'

$timeFormatMap = @{
    'none'      = 'none'
    'y-md_H-m-s' = [char]0x5E74 + '-' + [char]0x6708 + '-' + [char]0x65E5 + '_' + [char]0x65F6 + '-' + [char]0x5206 + '-' + [char]0x79D2
    'y-md_H-m'   = [char]0x5E74 + '-' + [char]0x6708 + '-' + [char]0x65E5 + '_' + [char]0x65F6 + '-' + [char]0x5206
    'md_H-m-s'   = [char]0x6708 + '-' + [char]0x65E5 + '_' + [char]0x65F6 + '-' + [char]0x5206 + '-' + [char]0x79D2
    'md_H-m'     = [char]0x6708 + '-' + [char]0x65E5 + '_' + [char]0x65F6 + '-' + [char]0x5206
}

function Get-GitHubToken {
    foreach ($v in @($env:GITHUB_TOKEN, $env:GH_TOKEN)) {
        if ($v) { return $v }
    }

    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) {
        $candidates = @(
            'C:\Program Files\Git\cmd\git.exe',
            'C:\Program Files\Git\bin\git.exe'
        ) | Where-Object { Test-Path $_ }
        if ($candidates) { $git = $candidates[0] }
    }
    if (-not $git) {
        throw 'git not found. Set $env:GITHUB_TOKEN and retry.'
    }

    $fill = "protocol=https`nhost=github.com`n`n" | & $git credential fill 2>$null
    if ($fill) {
        $m = $fill | Select-String '^password=(.+)$'
        if ($m) { return $m.Matches[0].Groups[1].Value }
    }
    throw 'No GitHub token found. Set $env:GITHUB_TOKEN (needs repo + workflow scopes).'
}

$token = Get-GitHubToken

$headers = @{
    Authorization          = "Bearer $token"
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent'           = 'opencode2api-trigger'
}

$timeFormat = $timeFormatMap[$TimeTag]
if ($TimeTag -eq 'none') { $timeFormat = -join ([char]0x4E0D, [char]0x751F, [char]0x6210, [char]0x65F6, [char]0x95F4, 'tag') }

$inputs = [ordered]@{
    repoUrl        = $RepoUrl
    repoBranch     = $RepoBranch
    imageName      = $ImageName
    dockerFileUrl  = $DockerFileUrl
    platforms      = $Platforms
    tags           = $Tags
    timeTagsFormat = $timeFormat
    timeTagsPrefix = $TimeTagPrefix
}

$json  = @{ ref = 'master'; inputs = $inputs } | ConvertTo-Json -Depth 5 -Compress
# Windows PowerShell 5.1 sends -Body strings as ANSI, which corrupts the Chinese
# choice values (they become '?????' and GitHub rejects the dispatch with 422).
# Send explicit UTF-8 bytes instead.
$body  = [System.Text.Encoding]::UTF8.GetBytes($json)

Write-Host '>> dispatching qq4756283/Actions-buildUtils :: docker-hub.yml (ref=master)'
foreach ($k in $inputs.Keys) { Write-Host ("   {0,-13}: {1}" -f $k, $inputs[$k]) }
Write-Host ''

$uri = 'https://api.github.com/repos/qq4756283/Actions-buildUtils/actions/workflows/docker-hub.yml/dispatches'
Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $body -ContentType 'application/json; charset=utf-8'

Write-Host 'OK dispatched.'
Write-Host '   https://github.com/qq4756283/Actions-buildUtils/actions'
