$ErrorActionPreference='Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$destination=Join-Path $PWD 'artifacts/regression-0.1.10/resources.json'
$report=Join-Path $PWD 'artifacts/regression-0.1.10/chapter-threads.json'
$nativeProcess=Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object CommandLine -Like '*native-benchmark-service.py*' | Select-Object -First 1
$previous=@{};$samples=[System.Collections.Generic.List[object]]::new();$clock=[Diagnostics.Stopwatch]::StartNew();$lastTime=0
do {
 $now=$clock.Elapsed.TotalSeconds;$interval=$now-$lastTime;$rows=@(Get-Process -Name chrome -ErrorAction SilentlyContinue)
 $nativeRows=if($nativeProcess){@(Get-Process -Id $nativeProcess.ProcessId -ErrorAction SilentlyContinue)}else{@()}
 $reading=@{}
 foreach($group in @(@{name='allChrome';rows=$rows},@{name='nativeBenchmark';rows=$nativeRows})){
  $cpu=0.0;$ws=0L;$private=0L
  foreach($process in $group.rows){try{$seconds=$process.TotalProcessorTime.TotalSeconds;$key=[string]$process.Id;if($previous.ContainsKey($key)){$cpu+=[Math]::Max(0,$seconds-$previous[$key])};$previous[$key]=$seconds;$ws+=$process.WorkingSet64;$private+=$process.PrivateMemorySize64}catch{}}
  $reading[$group.name]=@{processes=$group.rows.Count;cpuCorePercent=if($interval -gt 0){100*$cpu/$interval}else{0};workingSetBytes=$ws;privateBytes=$private}
 }
 $lastTime=$now;$samples.Add(@{at=[DateTimeOffset]::UtcNow.ToString('o');elapsedSeconds=$now;reading=$reading})
 if($samples.Count%15 -eq 0){@{scope='All Chrome processes, includes unrelated tabs; summed working set can share pages. Native benchmark process only.';samples=$samples}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $destination -Encoding utf8}
 $finished=$false
 if(Test-Path -LiteralPath $report){try{$state=Get-Content -LiteralPath $report -Raw|ConvertFrom-Json;$finished=$state.status -in @('passed','failed')}catch{}}
 if(-not $finished){Start-Sleep -Seconds 2}
}while(-not $finished)
@{scope='All Chrome processes, includes unrelated tabs; summed working set can share pages. Native benchmark process only.';samples=$samples}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $destination -Encoding utf8
Write-Output ('Resource samples recorded: '+$samples.Count)
