# Creates the label set foreman routes on. Idempotent: safe to re-run.
# Usage: .\scripts\setup-labels.ps1 -Repo "owner/name"

param([Parameter(Mandatory = $true)][string]$Repo)

$ErrorActionPreference = "Stop"

$labels = @(
    @{ name = "lane:claude";        color = "5436DA"; desc = "Needs Claude Code: skills, repo context or judgement" },
    @{ name = "lane:any";           color = "0E8A16"; desc = "Specified tightly enough for any agent" },
    @{ name = "status:draft";       color = "BFBFBF"; desc = "Still being written. Never dispatched." },
    @{ name = "status:ready";       color = "1D76DB"; desc = "Dispatchable" },
    @{ name = "status:running";     color = "FBCA04"; desc = "A Run has it" },
    @{ name = "status:review";      color = "D93F0B"; desc = "Pull request open, waiting on Jack" },
    @{ name = "status:needs-human"; color = "B60205"; desc = "Out of attempts. Nothing retries it." },
    @{ name = "complexity:high";     color = "3F2B96"; desc = "Needs the strongest model: design, judgement, unfamiliar ground" },
    @{ name = "complexity:standard"; color = "6E7781"; desc = "Ordinary feature work against a clear spec" },
    @{ name = "complexity:low";      color = "C5DEF5"; desc = "Mechanical: renames, bumps, test backfills, config" }
)

foreach ($l in $labels) {
    gh label create $l.name --repo $Repo --color $l.color --description $l.desc --force
    if ($LASTEXITCODE -ne 0) { throw "failed creating label $($l.name) on $Repo" }
}

Write-Output "labels ready on $Repo"
