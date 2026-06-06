# 贾门 Icebreaker — 公网隧道自动重连
# 如果 serveo.net 断开，自动重试

$urlFile = "$PSScriptRoot\.tunnel_url.txt"

while ($true) {
    Write-Host "🚀 正在建立 serveo.net 隧道..." -ForegroundColor Cyan

    $output = ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ConnectTimeout=10 -R 80:localhost:3000 serveo.net 2>&1

    # Extract URL from output
    if ($output -match 'https://[^\s]+') {
        $url = $matches[0]
        Write-Host "✅ 公网地址: $url" -ForegroundColor Green
        $url | Out-File -FilePath $urlFile -Encoding utf8
    }

    Write-Host "❌ 隧道断开，5秒后重连..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}
