<#
.SYNOPSIS
    触发 GitHub Actions 构建 opencode-gate 镜像并推送 Docker Hub。

.EXAMPLE
    # 构建本仓库 main 分支（默认）
    pwsh -File scripts/trigger-build.ps1

.EXAMPLE
    # 构建上游仓库 + 指定自定义 Dockerfile
    pwsh -File scripts/trigger-build.ps1 -RepoUrl https://github.com/spfnas/opencode2api-free.git

.EXAMPLE
    # 只推送单个 tag，不打时间 tag
    pwsh -File scripts/trigger-build.ps1 -Tags latest -NoTimeTag
#>
param(
    [string]$RepoUrl      = 'https://github.com/qq4756283/opencode2api-free.git',
    [string]$RepoBranch   = 'main',
    [string]$ImageName    = 'opencode-gate',
    [string]$DockerFileUrl= 'https://raw.githubusercontent.com/qq4756283/opencode2api-free/main/Dockerfile',
    [string]$Platforms    = 'linux/amd64,linux/arm64',
    [string]$Tags         = 'latest',
    [ValidateSet('不生成时间tag','年-月-日_时-分-秒','年-月-日_时-分','月-日_时-分-秒','月-日_时-分')]
    [string]$TimeTagsFormat = '年-月-日_时-分-秒',
    [string]$TimeTagsPrefix = '',
    [switch]$NoTimeTag
)

$ErrorActionPreference = 'Stop'

if ($NoTimeTag) { $TimeTagsFormat = '不生成时间tag' }

# ── 拿 token：优先环境变量，其次 Windows 凭据管理器里的 git credential ──
function Get-GitHubToken {
    if ($env:GITHUB_TOKEN) { return $env:GITHUB_TOKEN }
    if ($env:GH_TOKEN)     { return $env:GH_TOKEN }

    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) {
        $gitPath = 'C:\Program Files\Git\cmd\git.exe'
        if (-not (Test-Path $gitPath)) {
            throw '找不到 git，无法从凭据管理器读取 token。请设置 $env:GITHUB_TOKEN 后重试。'
        }
        $git = $gitPath
    }

    $fill = "protocol=https`nhost=github.com`n`n" | & $git credential fill 2>$null
    $m = $fill | Select-String '^password=(.+)$'
    if ($m) { return $m.Matches[0].Groups[1].Value }
    throw '未找到 GitHub token。请设置 $env:GITHUB_TOKEN（需要 repo + workflow 权限）。'
}

$token = Get-GitHubToken
$headers = @{
    Authorization        = "Bearer $token"
    Accept               = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent'         = 'opencode2api-trigger'
}

$body = @{
    ref                  = 'master'
    inputs               = @{
        repoUrl         = $RepoUrl
        repoBranch      = $RepoBranch
        imageName       = $ImageName
        dockerFileUrl   = $DockerFileUrl
        platforms       = $Platforms
        tags            = $Tags
        timeTagsFormat  = $TimeTagsFormat
        timeTagsPrefix  = $TimeTagsPrefix
    }
} | ConvertTo-Json -Depth 5

Write-Host "→ 触发 qq4756283/Actions-buildUtils :: docker-hub.yml (ref=master)"
Write-Host "  repoUrl      : $RepoUrl"
Write-Host "  repoBranch   : $RepoBranch"
Write-Host "  imageName    : $ImageName"
Write-Host "  dockerFileUrl: $DockerFileUrl"
Write-Host "  platforms    : $Platforms"
Write-Host "  tags         : $Tags"
Write-Host "  timeTags     : $TimeTagsFormat$TimeTagsPrefix"
Write-Host ''

$res = Invoke-RestMethod `
    -Uri 'https://api.github.com/repos/qq4756283/Actions-buildUtils/actions/workflows/docker-hub.yml/dispatches' `
    -Method Post -Headers $headers -Body $body -ContentType 'application/json'

Write-Host '✓ 已触发。查运行状态：'
Write-Host '  gh run list -R qq4756283/Actions-buildUtils'
Write-Host '  或 https://github.com/qq4756283/Actions-buildUtils/actions'
