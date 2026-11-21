[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$WorkerName = "worker",

    [Parameter(Mandatory = $false)]
    [string]$Workdir = (Get-Location).Path,

    [Parameter(Mandatory = $false)]
    [string]$Prompt = "",

    [Parameter(Mandatory = $false)]
    [string]$PromptFile = "",

    [Parameter(Mandatory = $false)]
    [ValidateSet("exec", "review", "resume", "fork", "post")]
    [string]$Mode = "exec",

    [Parameter(Mandatory = $false)]
    [string]$SwarmTitle = "",

    [Parameter(Mandatory = $false)]
    [string]$To = "",

    [Parameter(Mandatory = $false)]
    [ValidateSet("", "workspace-write", "read-only", "danger-full-access")]
    [string]$Sandbox = "",

    [Parameter(Mandatory = $false)]
    [switch]$FullAccess,

    [Parameter(Mandatory = $false)]
    [switch]$Worktree,

    [Parameter(Mandatory = $false)]
    [string]$SessionId = "",

    [Parameter(Mandatory = $false)]
    [string]$Model = "",

    [Parameter(Mandatory = $false)]
    [string]$ReasoningEffort = "",

    [Parameter(Mandatory = $false)]
    [switch]$Uncommitted,

    [Parameter(Mandatory = $false)]
    [string]$BaseBranch = "",

    [Parameter(Mandatory = $false)]
    [string]$CommitSha = "",

    [Parameter(Mandatory = $false)]
    [switch]$Ephemeral,

    [Parameter(Mandatory = $false)]
    [switch]$PersistSession,

    [Parameter(Mandatory = $false)]
    [switch]$AutoVerify,

    [Parameter(Mandatory = $false)]
    [switch]$NoAutoVerify,

    [Parameter(Mandatory = $false)]
    [switch]$WithArchitect,

    [Parameter(Mandatory = $false)]
    [int]$MaxRounds = 0,

    [Parameter(Mandatory = $false)]
    [switch]$UseWsl,

    [Parameter(Mandatory = $false)]
    [string]$OutDir = "$HOME\.gemini\antigravity\plugin_data\codex-swarm"
)

$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = $utf8NoBom
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom

if (-not $OutDir) {
    $runtimeConfig = Join-Path $PSScriptRoot "..\..\..\runtime-config.json"
    $OutDir = if (Test-Path $runtimeConfig) {
        (Get-Content -LiteralPath $runtimeConfig -Raw -Encoding UTF8 | ConvertFrom-Json).dataDir
    } else {
        "$HOME\.gemini\antigravity\plugin_data\codex-swarm"
    }
}

if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

$settingsPath = Join-Path $OutDir "settings.json"
$membersPath  = Join-Path $OutDir "members.json"
$boardPath    = Join-Path $OutDir "board.jsonl"

# Load UI settings from settings.json
$uiSettings = @{
    swarmTitle = "Codex Swarm 协作看板"
    defaultModel = "gpt-6.1-terra"
    defaultReasoningEffort = "high"
    verifierModel = "gpt-6.2-sol"
    verifierReasoningEffort = "high"
    defaultSandbox = "workspace-write"
    defaultRuntime = "auto"
    ephemeral = $true
    worktree = $false
    autoVerify = $true
    maxRounds = 3
    presets = @()
}
if (Test-Path $settingsPath) {
    try {
        $loaded = Get-Content -Raw -Encoding UTF8 $settingsPath | ConvertFrom-Json
        if ($loaded.defaultModel) { $uiSettings.defaultModel = $loaded.defaultModel }
        if ($loaded.defaultReasoningEffort) { $uiSettings.defaultReasoningEffort = $loaded.defaultReasoningEffort }
        if ($loaded.verifierModel) { $uiSettings.verifierModel = $loaded.verifierModel }
        if ($loaded.verifierReasoningEffort) { $uiSettings.verifierReasoningEffort = $loaded.verifierReasoningEffort }
        if ($loaded.defaultSandbox) { $uiSettings.defaultSandbox = $loaded.defaultSandbox }
        if ($loaded.defaultRuntime) { $uiSettings.defaultRuntime = $loaded.defaultRuntime }
        if ($null -ne $loaded.ephemeral) { $uiSettings.ephemeral = [bool]$loaded.ephemeral }
        if ($null -ne $loaded.worktree) { $uiSettings.worktree = [bool]$loaded.worktree }
        if ($null -ne $loaded.autoVerify) { $uiSettings.autoVerify = [bool]$loaded.autoVerify }
        if ($loaded.maxRounds) { $uiSettings.maxRounds = [int]$loaded.maxRounds }
        if ($loaded.presets) { $uiSettings.presets = $loaded.presets }
        if ($loaded.swarmTitle) { $uiSettings.swarmTitle = $loaded.swarmTitle }
    } catch {}
}

function Invoke-WithBoardLock([scriptblock]$Action) {
    $mutex = New-Object System.Threading.Mutex($false, "Global\CodexSwarmBoardMutex")
    $acquired = $false
    try {
        $acquired = $mutex.WaitOne(5000)
        & $Action
    } finally {
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Add-BoardPost([hashtable]$Post) {
    $script:lastPostedSeq = 0
    Invoke-WithBoardLock {
        $maxSeq = 0
        if (Test-Path $boardPath) {
            $lines = [System.IO.File]::ReadAllLines($boardPath, $utf8NoBom)
            foreach ($l in $lines) {
                if ($l.Trim()) {
                    try {
                        $obj = $l | ConvertFrom-Json
                        if ([int]$obj.seq -gt $maxSeq) { $maxSeq = [int]$obj.seq }
                    } catch {}
                }
            }
        }
        $Post["seq"] = $maxSeq + 1
        $script:lastPostedSeq = $Post["seq"]
        $Post["ts"] = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        $jsonLine = ($Post | ConvertTo-Json -Compress -Depth 5) + "`n"
        [System.IO.File]::AppendAllText($boardPath, $jsonLine, $utf8NoBom)
    }
    return $script:lastPostedSeq
}

function Update-MemberState([string]$Name, [hashtable]$Props) {
    Invoke-WithBoardLock {
        $map = @{}
        if (Test-Path $membersPath) {
            try {
                $rawObj = Get-Content -Raw -Encoding UTF8 $membersPath | ConvertFrom-Json
                if ($rawObj) {
                    foreach ($prop in $rawObj.PSObject.Properties) {
                        $entry = @{}
                        foreach ($sub in $prop.Value.PSObject.Properties) {
                            $entry[$sub.Name] = $sub.Value
                        }
                        $map[$prop.Name] = $entry
                    }
                }
            } catch {}
        }
        if (-not $map.ContainsKey($Name)) {
            $map[$Name] = @{ name = $Name }
        }
        foreach ($k in $Props.Keys) {
            $map[$Name][$k] = $Props[$k]
        }
        $json = $map | ConvertTo-Json -Depth 6
        [System.IO.File]::WriteAllText($membersPath, $json, $utf8NoBom)
    }
}

if ($SwarmTitle) {
    Invoke-WithBoardLock {
        if (Test-Path $settingsPath) {
            try {
                $sObj = Get-Content -Raw -Encoding UTF8 $settingsPath | ConvertFrom-Json
                $sObj | Add-Member -NotePropertyName "swarmTitle" -NotePropertyValue $SwarmTitle -Force
                [System.IO.File]::WriteAllText($settingsPath, ($sObj | ConvertTo-Json -Depth 6), $utf8NoBom)
            } catch {}
        }
    }
}

$promptText = $Prompt
if ($PromptFile -and (Test-Path $PromptFile)) {
    $promptText = [System.IO.File]::ReadAllText((Resolve-Path $PromptFile).Path, $utf8NoBom)
}

if ($Mode -eq "post") {
    $targets = if ($To) { @($To -split ',') } else { @("all") }
    Add-BoardPost @{
        from = $WorkerName
        to = $targets
        role = if ($WorkerName -eq "coordinator") { "coordinator" } else { "worker" }
        type = "note"
        status = ""
        text = $promptText
    } | Out-Null
    Write-Host "[Codex Swarm Board] Posted message from @$WorkerName to $($targets -join ', ')"
    exit 0
}

if (-not $promptText -and $Mode -ne "review") {
    throw "Prompt or PromptFile must be provided for Mode '$Mode'."
}

function Get-PresetByName([string]$TargetName) {
    if ($uiSettings.presets) {
        foreach ($p in $uiSettings.presets) {
            if ($p.name -eq $TargetName) { return $p }
        }
    }
    return $null
}

$matchedPreset = Get-PresetByName $WorkerName
$isVerifierRole = ($Mode -eq "review") -or ($WorkerName -match "verifier|review")

$effectiveModel = if ($Model) {
    $Model
} elseif ($matchedPreset -and $matchedPreset.model) {
    $matchedPreset.model
} elseif ($isVerifierRole) {
    $uiSettings.verifierModel
} else {
    $uiSettings.defaultModel
}

$effectiveEffort = if ($ReasoningEffort) {
    $ReasoningEffort
} elseif ($matchedPreset -and $matchedPreset.reasoningEffort) {
    $matchedPreset.reasoningEffort
} elseif ($isVerifierRole) {
    $uiSettings.verifierReasoningEffort
} else {
    $uiSettings.defaultReasoningEffort
}

$effectiveSandbox = if ($Sandbox) {
    $Sandbox
} elseif ($matchedPreset -and $matchedPreset.sandbox) {
    $matchedPreset.sandbox
} else {
    $uiSettings.defaultSandbox
}

$effectiveEphemeral = if ($PersistSession.IsPresent) {
    $false
} elseif ($Ephemeral.IsPresent) {
    $true
} else {
    [bool]$uiSettings.ephemeral
}

$effectiveWorktree = $Worktree.IsPresent -or ([bool]$uiSettings.worktree)

# AutoVerify applies to write-capable worker exec tasks unless -NoAutoVerify is passed
$effectiveAutoVerify = if ($NoAutoVerify.IsPresent -or $isVerifierRole -or ($Mode -ne "exec") -or ($effectiveSandbox -eq "read-only" -and -not $FullAccess.IsPresent)) {
    $false
} elseif ($AutoVerify.IsPresent) {
    $true
} else {
    [bool]$uiSettings.autoVerify
}

$effectiveMaxRounds = if ($MaxRounds -gt 0) { $MaxRounds } elseif ($uiSettings.maxRounds -gt 0) { [int]$uiSettings.maxRounds } else { 3 }

$wslUncPattern = '^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)?$'
$wslDistro = if ($Workdir -match $wslUncPattern) { $Matches[1] }
$isWslTarget = $UseWsl.IsPresent -or ($uiSettings.defaultRuntime -eq "wsl") -or $wslDistro -or ($Workdir -match '^/')
$wslArgs = if ($wslDistro) { @('--distribution', $wslDistro, '--') } else { @('--') }
$runtimeLabel = if (-not $isWslTarget) { "Windows Native" } elseif ($wslDistro) { "WSL ($wslDistro)" } else { "WSL (default)" }

function Get-WindowsCodexPath {
    $extCandidates = Get-ChildItem "$HOME\.vscode\extensions\openai.chatgpt-*\bin\windows-x86_64\codex.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
    if ($extCandidates -and $extCandidates.Count -gt 0) {
        return $extCandidates[0].FullName
    }
    $sandboxBin = "$HOME\.codex\.sandbox-bin\codex.exe"
    if (Test-Path $sandboxBin) {
        return $sandboxBin
    }
    $cmd = Get-Command codex -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw "Could not find codex.exe in VS Code extensions, ~/.codex/.sandbox-bin, or PATH."
}

function ConvertTo-WslPath([string]$winOrWslPath) {
    if ($winOrWslPath -match '^/') {
        return $winOrWslPath
    }
    if ($winOrWslPath -match $wslUncPattern) {
        $pathDistro = $Matches[1]
        $linuxPath = $Matches[2]
        $activeDistro = if ($wslDistro) { $wslDistro } else { (wsl @wslArgs printenv WSL_DISTRO_NAME).Trim() }
        if ($pathDistro -ne $activeDistro) {
            throw "WSL path belongs to a different distribution: $winOrWslPath"
        }
        if (-not $linuxPath) { return '/' }
        return ($linuxPath -replace '\\', '/')
    }
    $normalized = $winOrWslPath -replace '\\', '/'
    $converted = (wsl @wslArgs wslpath -u "$normalized" 2>$null)
    if ($LASTEXITCODE -eq 0 -and $converted) {
        return $converted.Trim()
    }
    throw "Failed to convert path '$winOrWslPath' to WSL path."
}

# Helper to run a single Codex CLI invocation and return @{ ExitCode; Elapsed; Summary; LogFile }
function Invoke-CodexTurn {
    param(
        [string]$AgentName,
        [string]$AgentRole,
        [string]$TurnMode,
        [string]$TurnPrompt,
        [string]$TurnModel,
        [string]$TurnEffort,
        [string]$TurnSandbox,
        [bool]$TurnFullAccess
    )

    $safeAgent = ($AgentName -replace '[^a-zA-Z0-9_\-]', '_')
    $ts = Get-Date -Format "yyyyMMdd-HHmmss"
    $turnBriefFile = Join-Path $OutDir "$safeAgent-brief.md"
    $turnSummaryFile = Join-Path $OutDir "$safeAgent-summary.md"
    $turnLogFile = Join-Path $OutDir "$safeAgent-$ts.log"

    if (Test-Path $turnSummaryFile) {
        Remove-Item $turnSummaryFile -Force -ErrorAction SilentlyContinue
    }
    if ($TurnPrompt) {
        [System.IO.File]::WriteAllText($turnBriefFile, $TurnPrompt, $utf8NoBom)
    }

    Update-MemberState -Name $AgentName -Props @{
        name = $AgentName
        role = $AgentRole
        status = "working"
        model = $TurnModel
        reasoningEffort = $TurnEffort
        sandbox = $(if ($TurnFullAccess) { "danger-full-access" } else { $TurnSandbox })
        runtime = $runtimeLabel
        workdir = $Workdir
        ephemeral = $effectiveEphemeral
        brief = $(if ($TurnPrompt) { $TurnPrompt } else { "[Code Review]" })
        logFile = $turnLogFile
        summaryFile = $turnSummaryFile
        startedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    }

    $turnStart = Get-Date
    $turnExit = 1

    if (-not $isWslTarget) {
        $codexExe = Get-WindowsCodexPath
        if (-not (Test-Path $Workdir)) {
            New-Item -ItemType Directory -Path $Workdir -Force | Out-Null
        }

        $argsList = New-Object System.Collections.Generic.List[string]
        if ($TurnMode -eq "exec") {
            $argsList.Add("exec")
            $argsList.Add("-C")
            $argsList.Add($Workdir)
            if ($TurnFullAccess) {
                $argsList.Add("--dangerously-bypass-approvals-and-sandbox")
            } else {
                $argsList.Add("-s")
                $argsList.Add($TurnSandbox)
            }
            if ($effectiveWorktree -and $AgentRole -ne "verifier") {
                $argsList.Add("--worktree")
            } else {
                $argsList.Add("--skip-git-repo-check")
            }
            if ($effectiveEphemeral) {
                $argsList.Add("--ephemeral")
            }
            if ($TurnModel) {
                $argsList.Add("-m")
                $argsList.Add($TurnModel)
            }
            if ($TurnEffort) {
                $argsList.Add("-c")
                $argsList.Add("model_reasoning_effort=`"$TurnEffort`"")
            }
            $argsList.Add("--color")
            $argsList.Add("never")
            $argsList.Add("-o")
            $argsList.Add($turnSummaryFile)
            $argsList.Add("-")
        }
        elseif ($TurnMode -eq "resume" -or $TurnMode -eq "fork") {
            $argsList.Add("exec")
            $argsList.Add($TurnMode)
            if ($SessionId) { $argsList.Add($SessionId) } else { $argsList.Add("--last") }
            if ($TurnFullAccess) { $argsList.Add("--dangerously-bypass-approvals-and-sandbox") }
            if ($effectiveWorktree) { $argsList.Add("--worktree") } else { $argsList.Add("--skip-git-repo-check") }
            if ($TurnModel) { $argsList.Add("-m"); $argsList.Add($TurnModel) }
            if ($TurnEffort) { $argsList.Add("-c"); $argsList.Add("model_reasoning_effort=`"$TurnEffort`"") }
            $argsList.Add("-o")
            $argsList.Add($turnSummaryFile)
            $argsList.Add("-")
        }
        elseif ($TurnMode -eq "review") {
            $argsList.Add("review")
            if ($TurnModel) { $argsList.Add("-c"); $argsList.Add("model=`"$TurnModel`"") }
            if ($TurnEffort) { $argsList.Add("-c"); $argsList.Add("model_reasoning_effort=`"$TurnEffort`"") }
            if ($Uncommitted -or (-not $BaseBranch -and -not $CommitSha)) { $argsList.Add("--uncommitted") }
            if ($BaseBranch) { $argsList.Add("--base"); $argsList.Add($BaseBranch) }
            if ($CommitSha) { $argsList.Add("--commit"); $argsList.Add($CommitSha) }
            if ($TurnPrompt) { $argsList.Add("-") }
        }

        Push-Location $Workdir
        try {
            $prevEap = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            [System.IO.File]::WriteAllText($turnLogFile, "", $utf8NoBom)
            if ($TurnPrompt) {
                $TurnPrompt | & $codexExe @argsList 2>&1 | ForEach-Object {
                    $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
                    [System.IO.File]::AppendAllText($turnLogFile, ($line + "`n"), $utf8NoBom)
                    Write-Output $line
                }
            } else {
                $null | & $codexExe @argsList 2>&1 | ForEach-Object {
                    $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
                    [System.IO.File]::AppendAllText($turnLogFile, ($line + "`n"), $utf8NoBom)
                    Write-Output $line
                }
            }
            $turnExit = $LASTEXITCODE
            $ErrorActionPreference = $prevEap
        }
        finally {
            Pop-Location
        }
    }
    else {
        $wslWorkdir = ConvertTo-WslPath $Workdir
        $wslSummaryFile = ConvertTo-WslPath $turnSummaryFile
        $wslBriefFile = if ($TurnPrompt) { ConvertTo-WslPath $turnBriefFile } else { "" }

        $cmdParts = New-Object System.Collections.Generic.List[string]
        $cmdParts.Add('$HOME/.local/bin/codex')

        if ($TurnMode -eq "exec") {
            $cmdParts.Add("exec")
            $cmdParts.Add("-C")
            $cmdParts.Add("'$wslWorkdir'")
            if ($TurnFullAccess) {
                $cmdParts.Add("--dangerously-bypass-approvals-and-sandbox")
            } else {
                $cmdParts.Add("-s")
                $cmdParts.Add($TurnSandbox)
            }
            if ($effectiveWorktree -and $AgentRole -ne "verifier") {
                $cmdParts.Add("--worktree")
            } else {
                $cmdParts.Add("--skip-git-repo-check")
            }
            if ($effectiveEphemeral) { $cmdParts.Add("--ephemeral") }
            if ($TurnModel) { $cmdParts.Add("-m"); $cmdParts.Add("'$TurnModel'") }
            if ($TurnEffort) { $cmdParts.Add("-c"); $cmdParts.Add("'model_reasoning_effort=`"$TurnEffort`"'") }
            $cmdParts.Add("--color")
            $cmdParts.Add("never")
            $cmdParts.Add("-o")
            $cmdParts.Add("'$wslSummaryFile'")
            $cmdParts.Add("-")
        }
        elseif ($TurnMode -eq "resume" -or $TurnMode -eq "fork") {
            $cmdParts.Add("exec")
            $cmdParts.Add($TurnMode)
            if ($SessionId) { $cmdParts.Add("'$SessionId'") } else { $cmdParts.Add("--last") }
            if ($TurnFullAccess) { $cmdParts.Add("--dangerously-bypass-approvals-and-sandbox") }
            if ($effectiveWorktree) { $cmdParts.Add("--worktree") } else { $cmdParts.Add("--skip-git-repo-check") }
            $cmdParts.Add("-o")
            $cmdParts.Add("'$wslSummaryFile'")
            $cmdParts.Add("-")
        }
        elseif ($TurnMode -eq "review") {
            $cmdParts.Add("review")
            if ($TurnModel) { $cmdParts.Add("-c"); $cmdParts.Add("'model=`"$TurnModel`"'") }
            if ($TurnEffort) { $cmdParts.Add("-c"); $cmdParts.Add("'model_reasoning_effort=`"$TurnEffort`"'") }
            if ($Uncommitted -or (-not $BaseBranch -and -not $CommitSha)) { $cmdParts.Add("--uncommitted") }
            if ($BaseBranch) { $cmdParts.Add("--base"); $cmdParts.Add("'$BaseBranch'") }
            if ($CommitSha) { $cmdParts.Add("--commit"); $cmdParts.Add("'$CommitSha'") }
            if ($TurnPrompt) { $cmdParts.Add("-") }
        }

        $joinedCmd = ($cmdParts -join " ")
        $bashScript = if ($wslBriefFile) {
            "mkdir -p '$wslWorkdir' && cd '$wslWorkdir' && $joinedCmd < '$wslBriefFile'"
        } else {
            "cd '$wslWorkdir' && $joinedCmd </dev/null"
        }

        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        [System.IO.File]::WriteAllText($turnLogFile, "", $utf8NoBom)
        wsl @wslArgs bash -lc $bashScript 2>&1 | ForEach-Object {
            $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
            [System.IO.File]::AppendAllText($turnLogFile, ($line + "`n"), $utf8NoBom)
            Write-Output $line
        }
        $turnExit = $LASTEXITCODE
        $ErrorActionPreference = $prevEap
    }

    $turnElapsed = [math]::Round(((Get-Date) - $turnStart).TotalSeconds, 1)
    $turnSummary = ""
    if (Test-Path $turnSummaryFile) {
        $turnSummary = (Get-Content -Raw -Encoding UTF8 $turnSummaryFile).Trim()
    } elseif (Test-Path $turnLogFile) {
        $lines = Get-Content -Encoding UTF8 $turnLogFile | Select-Object -Last 30
        $turnSummary = ($lines -join "`n").Trim()
    }

    $turnStatus = if ($turnExit -eq 0) { "done" } else { "failed" }
    Update-MemberState -Name $AgentName -Props @{
        status = $turnStatus
        exitCode = $turnExit
        elapsedSec = $turnElapsed
        summary = $turnSummary
        finishedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    }

    return @{
        ExitCode = $turnExit
        Elapsed = $turnElapsed
        Summary = $turnSummary
        LogFile = $turnLogFile
        Status = $turnStatus
    }
}

# =========================================================================
# Stage 0 (Optional): @architect pre-analysis -> hands off blueprint to @$WorkerName
# =========================================================================
$architectBlueprint = ""
if ($WithArchitect.IsPresent -and $Mode -eq "exec" -and $WorkerName -ne "architect") {
    $archPreset = Get-PresetByName "architect"
    $archModel = if ($archPreset -and $archPreset.model) { $archPreset.model } else { $uiSettings.verifierModel }
    $archEffort = if ($archPreset -and $archPreset.reasoningEffort) { $archPreset.reasoningEffort } else { "high" }

    Add-BoardPost @{
        from = "coordinator"
        to = @("architect")
        role = "coordinator"
        type = "assign"
        status = "working"
        model = $archModel
        reasoningEffort = $archEffort
        sandbox = "read-only"
        runtime = $runtimeLabel
        workdir = $Workdir
        ephemeral = $effectiveEphemeral
        text = "[架构预研派单 -> 完成后自动交接给 @$WorkerName]`n$promptText"
    } | Out-Null

    $archPrompt = @"
你是 Codex Swarm 的架构师 (@architect)，当前处于只读模式 (read-only)。
请针对以下任务快速阅读并分析工作区 ($Workdir) 的关键文件，输出一份简明扼要、可直接供执行子 Agent (@$WorkerName) 落地的【实施蓝图与关键注意事项】（不要自己修改文件）：

$promptText
"@
    $archRes = Invoke-CodexTurn -AgentName "architect" -AgentRole "worker" -TurnMode "exec" -TurnPrompt $archPrompt -TurnModel $archModel -TurnEffort $archEffort -TurnSandbox "read-only" -TurnFullAccess $false
    $architectBlueprint = $archRes.Summary

    Add-BoardPost @{
        from = "architect"
        to = @($WorkerName)
        role = "worker"
        type = "assign"
        status = "done"
        exitCode = $archRes.ExitCode
        elapsedSec = $archRes.Elapsed
        model = $archModel
        reasoningEffort = $archEffort
        sandbox = "read-only"
        runtime = $runtimeLabel
        workdir = $Workdir
        ephemeral = $effectiveEphemeral
        text = "[架构蓝图交接 -> @$WorkerName]`n$architectBlueprint"
    } | Out-Null
}

# =========================================================================
# Stage 1 & 2: Main Worker Execution + Autonomous @worker <-> @verifier Loop
# =========================================================================
$roleLabel = if ($isVerifierRole) { "verifier" } else { "worker" }
$briefDisplay = if ($promptText) { $promptText } else { "[Code Review] 审查当前仓库未提交变更 (--uncommitted)" }

if (-not $WithArchitect.IsPresent) {
    $assignSeq = Add-BoardPost @{
        from = "coordinator"
        to = @($WorkerName)
        role = "coordinator"
        type = "assign"
        status = "working"
        model = $effectiveModel
        reasoningEffort = $effectiveEffort
        sandbox = $(if ($FullAccess) { "danger-full-access" } else { $effectiveSandbox })
        runtime = $runtimeLabel
        workdir = $Workdir
        ephemeral = $effectiveEphemeral
        text = $briefDisplay
    }
}

Write-Host "=========================================================="
Write-Host "[Codex Swarm Worker] @$WorkerName"
Write-Host "  Mode       : $Mode ($roleLabel)"
Write-Host "  Model      : $effectiveModel (Reasoning Effort: $effectiveEffort)"
Write-Host "  AutoVerify : $effectiveAutoVerify (MaxRounds: $effectiveMaxRounds)"
Write-Host "  Ephemeral  : $effectiveEphemeral (不污染 Codex 桌面版会话)"
Write-Host "  Workdir    : $Workdir"
Write-Host "  Runtime    : $runtimeLabel"
Write-Host "=========================================================="

$currentWorkerPrompt = if ($architectBlueprint) {
    "$promptText`n`n[来自 @architect 的架构蓝图与实施建议]`n$architectBlueprint"
} else {
    $promptText
}

$verifierPreset = Get-PresetByName "verifier"
$vModel = if ($verifierPreset -and $verifierPreset.model) { $verifierPreset.model } else { $uiSettings.verifierModel }
$vEffort = if ($verifierPreset -and $verifierPreset.reasoningEffort) { $verifierPreset.reasoningEffort } else { $uiSettings.verifierReasoningEffort }

$round = 1
$finalWorkerRes = $null
$finalVerifierRes = $null

while ($round -le $effectiveMaxRounds) {
    Write-Host "--- [@$WorkerName] Executing Round $round ---"
    $workerRes = Invoke-CodexTurn -AgentName $WorkerName -AgentRole $roleLabel -TurnMode $Mode -TurnPrompt $currentWorkerPrompt -TurnModel $effectiveModel -TurnEffort $effectiveEffort -TurnSandbox $effectiveSandbox -TurnFullAccess $FullAccess.IsPresent
    $finalWorkerRes = $workerRes

    if (-not $effectiveAutoVerify -or $workerRes.ExitCode -ne 0) {
        # Direct report back to @coordinator
        $prefix = if ($workerRes.ExitCode -eq 0) { "[done] " } else { "[error (exit $($workerRes.ExitCode))] " }
        Add-BoardPost @{
            from = $WorkerName
            to = @("coordinator")
            role = $roleLabel
            type = $workerRes.Status
            status = $workerRes.Status
            exitCode = $workerRes.ExitCode
            elapsedSec = $workerRes.Elapsed
            model = $effectiveModel
            reasoningEffort = $effectiveEffort
            sandbox = $(if ($FullAccess) { "danger-full-access" } else { $effectiveSandbox })
            runtime = $runtimeLabel
            workdir = $Workdir
            ephemeral = $effectiveEphemeral
            text = ($prefix + $workerRes.Summary)
        } | Out-Null
        break
    }

    # Peer-to-peer handoff: @$WorkerName -> @verifier
    $workerPostSeq = Add-BoardPost @{
        from = $WorkerName
        to = @("verifier")
        role = $roleLabel
        type = "assign"
        status = "done"
        exitCode = $workerRes.ExitCode
        elapsedSec = $workerRes.Elapsed
        model = $effectiveModel
        reasoningEffort = $effectiveEffort
        sandbox = $(if ($FullAccess) { "danger-full-access" } else { $effectiveSandbox })
        runtime = $runtimeLabel
        workdir = $Workdir
        ephemeral = $effectiveEphemeral
        text = "[第 $round 轮完成，提请 @verifier 独立核验]`n$($workerRes.Summary)"
    }

    Write-Host "--- [@verifier] Auto-verifying @$WorkerName (Round $round, Post #$workerPostSeq) ---"
    $verifierPrompt = @"
你是 Codex Swarm 的独立验证官 (@verifier，只读核验，严禁亲自修改任何工程文件)。
请全面核验 #$workerPostSeq (@$WorkerName 的第 $round 轮修改) 在工作区 ($Workdir) 中的实际落地情况。

[原始任务要求]
$promptText

[@$WorkerName 第 $round 轮汇报 (#$workerPostSeq)]
$($workerRes.Summary)

请你直接检查工作区中的实际文件 / git diff 或运行只读校验命令，核查是否存在遗漏、语法错误、未同步修改、越界修改或未满足的验收条件。

【输出格式要求（必须严格遵守）】
1. 如果所有检查项全部通过、0 阻断缺陷：请务必在回复的第一行以 `[PASS]` 开头，随后写出你的核验通过报告。
2. 如果检出任何需要 @$WorkerName 修复的问题：请务必在回复的第一行以 `[REWORK]` 开头，并逐项列出具体问题、文件路径及修复要求，以便自动打回给 @$WorkerName 重修。
"@

    $verRes = Invoke-CodexTurn -AgentName "verifier" -AgentRole "verifier" -TurnMode "exec" -TurnPrompt $verifierPrompt -TurnModel $vModel -TurnEffort $vEffort -TurnSandbox "read-only" -TurnFullAccess $false
    $finalVerifierRes = $verRes

    $verText = $verRes.Summary
    $needsRework = ($verText -match '\[REWORK\]') -and ($verText -notmatch '^\s*\[PASS\]')

    if (-not $needsRework) {
        # Verification PASSED -> @verifier reports final [done] to @coordinator
        Add-BoardPost @{
            from = "verifier"
            to = @("coordinator")
            role = "verifier"
            type = "done"
            status = "done"
            exitCode = $verRes.ExitCode
            elapsedSec = $verRes.Elapsed
            model = $vModel
            reasoningEffort = $vEffort
            sandbox = "read-only"
            runtime = $runtimeLabel
            workdir = $Workdir
            ephemeral = $effectiveEphemeral
            text = "[done] 已完成对 #$workerPostSeq (@$WorkerName 第 $round 轮提交) 的独立核验，全部 PASS：`n$verText"
        } | Out-Null
        break
    }

    if ($round -lt $effectiveMaxRounds) {
        # Verification found issues -> @verifier posts directly to @$WorkerName for rework!
        $reworkSeq = Add-BoardPost @{
            from = "verifier"
            to = @($WorkerName)
            role = "verifier"
            type = "assign"
            status = "working"
            exitCode = $verRes.ExitCode
            elapsedSec = $verRes.Elapsed
            model = $vModel
            reasoningEffort = $vEffort
            sandbox = "read-only"
            runtime = $runtimeLabel
            workdir = $Workdir
            ephemeral = $effectiveEphemeral
            text = "[检出问题 -> 打回 @$WorkerName 第 $($round + 1) 轮返工修复]`n$verText"
        }

        $currentWorkerPrompt = @"
[来自独立验证官 @verifier 的返工要求 (#$reworkSeq)]
你在第 $round 轮提交的修改经 @verifier 核验检出以下问题，请立即在工作区 ($Workdir) 中逐项修复（修复后请自测确认）：

$verText

---
[附：原始任务要求]
$promptText
"@
        $round++
    }
    else {
        # Reached max rounds -> report to @coordinator
        Add-BoardPost @{
            from = "verifier"
            to = @("coordinator")
            role = "verifier"
            type = "done"
            status = "failed"
            exitCode = $verRes.ExitCode
            elapsedSec = $verRes.Elapsed
            model = $vModel
            reasoningEffort = $vEffort
            sandbox = "read-only"
            runtime = $runtimeLabel
            workdir = $Workdir
            ephemeral = $effectiveEphemeral
            text = "[已达最大自动互审轮数 $effectiveMaxRounds，仍有待处理项，提请 @coordinator 介入]`n$verText"
        } | Out-Null
        break
    }
}

Write-Host ""
Write-Host "=========================================================="
Write-Host "[Codex Swarm] @$WorkerName workflow finished (Rounds: $round)"
Write-Host "=========================================================="
if ($finalWorkerRes -and $finalWorkerRes.Summary) {
    Write-Host "--- @$WorkerName Final Summary ---"
    Write-Host $finalWorkerRes.Summary
}
if ($finalVerifierRes -and $finalVerifierRes.Summary) {
    Write-Host ""
    Write-Host "--- @verifier Final Review ---"
    Write-Host $finalVerifierRes.Summary
}
exit $(if ($finalWorkerRes) { $finalWorkerRes.ExitCode } else { 0 })
