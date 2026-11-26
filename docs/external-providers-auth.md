# 外部 AI 平台 CLI 授权刷新与状态检查指南

> 运行位置：运行 SuCanvas Web 的 **Windows 服务器（`3800X`）**，以 **`Raydio` 用户**打开任意 **PowerShell** 或 **命令提示符（CMD）** 窗口执行即可。
> 刷新登录态或更新密钥文件后**无需重启 `SuCanvasServer.exe`**；在网页端「基础设置 -> 外部 AI 平台 CLI」点击 **刷新平台状态** 或直接提交生成即可立即生效。

---

## 1. 即梦（国区 `jimeng-cn`）

- **刷新 / 重新登录**：
  ```powershell
  C:\Users\Raydio\bin\jimeng-cn\dreamina-canvas.exe --profile cn auth login
  ```
- **检查登录状态与过期时间（不消耗积分）**：
  ```powershell
  C:\Users\Raydio\bin\jimeng-cn\dreamina-canvas.exe --profile cn --format json --non-interactive auth status
  ```

---

## 2. 即梦（日区 `dreamina-jp`）

- **刷新 / 重新登录**：
  ```powershell
  C:\Users\Raydio\bin\dreamina-canvas.exe auth login
  ```
- **检查登录状态与过期时间（不消耗积分）**：
  ```powershell
  C:\Users\Raydio\bin\dreamina-canvas.exe --format json --non-interactive auth status
  ```

---

## 3. LibTV（`libtv`）

- **刷新 / 重新登录**：
  ```powershell
  C:\Users\Raydio\.libtv\libtv.exe login
  ```
- **检查登录态与当前绑定工作区（不消耗积分）**：
  ```powershell
  C:\Users\Raydio\.libtv\libtv.exe status
  ```

---

## 4. Lovart（`lovart`）

Lovart 使用 AK / SK 密钥鉴权，通常无需频繁浏览器扫码；如更换或轮换密钥，可使用以下任一方式配置（切勿把密钥提交到 Git）：

1. 服务器系统/用户环境变量：`LOVART_ACCESS_KEY` 与 `LOVART_SECRET_KEY`
2. 密钥文件（二选一）：
   - `C:\Users\Raydio\.lovart\credentials.env`
   - `F:\SuCanvas-Web\data\providers\lovart\credentials.env`

格式示例：

```env
LOVART_ACCESS_KEY=你的AccessKey
LOVART_SECRET_KEY=你的SecretKey
```

- **检查脚本与环境变量（不打印密钥值，不消耗积分）**：
  ```powershell
  python F:\SuCanvas-Web\scripts\providers\lovart_agent_skill.py --help
  Write-Host "LOVART_ENV_SET=AK:$([bool]$env:LOVART_ACCESS_KEY),SK:$([bool]$env:LOVART_SECRET_KEY)"
  ```

---

## 5. 一键零积分巡检脚本（PowerShell）

在服务器 PowerShell 中一次性检查 4 个平台的可用性（自动脱敏账号 ID）：

```powershell
& 'C:\Users\Raydio\bin\jimeng-cn\dreamina-canvas.exe' --profile cn --format json --non-interactive auth status | ForEach-Object { $_ -replace '"userId":"[^"]+"', '"userId":"[redacted]"' }
& 'C:\Users\Raydio\bin\dreamina-canvas.exe' --format json --non-interactive auth status | ForEach-Object { $_ -replace '"userId":"[^"]+"', '"userId":"[redacted]"' }
& 'C:\Users\Raydio\.libtv\libtv.exe' status
Write-Host "LOVART_ENV_SET=AK:$([bool]$env:LOVART_ACCESS_KEY),SK:$([bool]$env:LOVART_SECRET_KEY)"
```
