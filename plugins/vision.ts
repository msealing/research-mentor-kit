import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434"
// 本插件路径已参数化，避免绑定单台机器：均可通过环境变量覆盖，或直接修改下面的默认值
const OLLAMA_EXE = process.env.OLLAMA_EXE ?? "ollama" // Windows 常见: C:\Users\<用户名>\AppData\Local\Programs\Ollama\ollama.exe
const OLLAMA_MODELS_DIR = process.env.OLLAMA_MODELS_DIR ?? "" // 留空用 Ollama 默认模型目录
const TMP_DIR = process.env.OPENCODE_VISION_TMP ?? path.join(os.tmpdir(), "opencode-vision")
const ERROR_LOG = path.join(TMP_DIR, "vision-error.log")
const WATCHDOG_SCRIPT = path.join(TMP_DIR, "vision-watchdog.ps1")
const WATCHDOG_PID = path.join(TMP_DIR, "vision-watchdog.pid")
// OpenAI 兼容 /v1 → Ollama /api 中转代理（强制 think:false 关闭思考链，保聊天记忆）
const PROXY_PORT = 11500
const PROXY_HOST = `http://127.0.0.1:${PROXY_PORT}`
const PROXY_SCRIPT = process.env.OLLAMA_PROXY_SCRIPT ?? path.join(TMP_DIR, "ollama-proxy.mjs")
const PROXY_PID = path.join(TMP_DIR, "vision-proxy.pid")
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 3
const MODEL_DEFAULT = "qwen3.5:4b"
const MAX_SIDE = 1024
const NUM_CTX = 4096
const NUM_PREDICT_DEFAULT = 1024
const NUM_PREDICT_SHORT = 512
const DEFAULT_QUESTION =
  "请用中文详细描述这张图片的内容，包括：图片类型、主体内容、坐标轴或图例（如有）、文字内容（如有，请逐字读出）、关键特征。"
const PROMPT_OCR =
  "请逐字提取这张图片中的全部文字内容，按阅读顺序输出为纯文本，保留原文格式（如列表、段落、标题）。只输出提取到的文字，不要添加任何解释、评论或翻译。如果图片中没有文字，只输出：无文字。"
const PROMPT_TABLE =
  "这张图片是一张表格（或含表格）。请识别表格内容并输出为 Markdown 表格，完整保留所有行列与单元格文字，不要合并、省略或编造内容；空单元格保留为空。只输出 Markdown 表格，不要额外解释。"
const PROMPT_CHART =
  "这是一张数据图表。请用中文分析并输出：1) 图表类型（折线图/柱状图/散点图/饼图/雷达图等）；2) 坐标轴、刻度与图例的含义；3) 主要趋势与关键数据点（尽量读出具体数值）；4) 图表传达的核心结论。"
const PROMPT_CHART_CODE =
  PROMPT_CHART + " 5) 额外给出用 Python matplotlib 复现这张图的完整代码（假设数据可从图中估算）。"
const PROMPT_PDF = (page: number) =>
  `这是 PDF 文档第 ${page} 页的渲染图。请用中文详细描述该页内容：标题、正文要点、表格、图表、公式、页码等，页面中的文字请尽量逐字读出。`

const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "powershell.exe"

const visionCache = new Map<string, string>()
let modelSupportsImage = false
let currentModelName = ""
const VISION_SKIP_MODELS = ["mimo", "mimo-v2.5", "mimo-v2.5-free"]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runPowerShell(script: string): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  })
  return {
    ok: res.status === 0,
    stdout: (res.stdout || "") as string,
    stderr: (res.stderr || "") as string,
  }
}

async function ollamaAlive(): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: controller.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

async function waitForOllama(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await ollamaAlive()) return true
    await sleep(1500)
  }
  return false
}

function startOllama(): boolean {
  const script = [
    `$env:OLLAMA_MODELS = '${OLLAMA_MODELS_DIR}'`,
    `$env:OLLAMA_KEEP_ALIVE = '2m'`,
    `Start-Process -FilePath '${OLLAMA_EXE}' -ArgumentList 'serve' -WindowStyle Hidden`,
    `exit 0`,
  ].join("; ")
  const res = runPowerShell(script)
  if (!res.ok) return false
  startWatchdog()
  return true
}

function watchdogAlive(): boolean {
  try {
    if (!fs.existsSync(WATCHDOG_PID)) return false
    const pid = parseInt(fs.readFileSync(WATCHDOG_PID, "utf8").trim(), 10)
    if (!pid) return false
    const res = runPowerShell(`Get-Process -Id ${pid} -ErrorAction SilentlyContinue; exit 0`)
    return res.ok && res.stdout.trim().length > 0
  } catch {
    return false
  }
}

function startWatchdog(): void {
  if (watchdogAlive()) return
  try {
    if (!fs.existsSync(TMP_DIR)) {
      fs.mkdirSync(TMP_DIR, { recursive: true })
    }
    fs.writeFileSync(
      WATCHDOG_SCRIPT,
      `while ($true) { Start-Sleep -Seconds 30; $oc = Get-Process -Name 'OpenCode','opencode' -ErrorAction SilentlyContinue; if (-not $oc) { if (Test-Path '${PROXY_PID}') { $pp = Get-Content '${PROXY_PID}'; Stop-Process -Id $pp -Force -ErrorAction SilentlyContinue }; Get-Process -Name 'ollama','llama-server' -ErrorAction SilentlyContinue | Stop-Process -Force; exit } }`,
      "utf8",
    )
    const res = runPowerShell(
      `$p = Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${WATCHDOG_SCRIPT}'; if ($p) { $p.Id } else { '' }; exit 0`,
    )
    const pid = res.stdout.trim()
    if (res.ok && pid) {
      fs.writeFileSync(WATCHDOG_PID, pid, "utf8")
    }
  } catch {
    // 看门狗失败不影响主流程
  }
}

function stopOllama(): void {
  stopProxy()
  runPowerShell("Get-Process -Name ollama,llama-server -ErrorAction SilentlyContinue | Stop-Process -Force; exit 0")
}

// ---------- Ollama /v1 → /api 中转代理（强制 think:false，保聊天记忆） ----------

function proxyAlive(): boolean {
  try {
    if (!fs.existsSync(PROXY_PID)) return false
    const pid = parseInt(fs.readFileSync(PROXY_PID, "utf8").trim(), 10)
    if (!pid) return false
    const res = runPowerShell(`Get-Process -Id ${pid} -ErrorAction SilentlyContinue; exit 0`)
    return res.ok && res.stdout.trim().length > 0
  } catch {
    return false
  }
}

function startProxy(): void {
  if (proxyAlive()) return
  try {
    if (!fs.existsSync(TMP_DIR)) {
      fs.mkdirSync(TMP_DIR, { recursive: true })
    }
    const res = runPowerShell(
      `$p = Start-Process node -WindowStyle Hidden -PassThru -ArgumentList '${PROXY_SCRIPT}'; if ($p) { $p.Id } else { '' }; exit 0`,
    )
    const pid = res.stdout.trim()
    if (res.ok && pid) {
      fs.writeFileSync(PROXY_PID, pid, "utf8")
    }
  } catch {
    // 代理启动失败不影响主流程（聊天仍会报连接错误而非假成功）
  }
}

function stopProxy(): void {
  try {
    if (fs.existsSync(PROXY_PID)) {
      const pid = parseInt(fs.readFileSync(PROXY_PID, "utf8").trim(), 10)
      if (pid) {
        runPowerShell(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue; exit 0`)
      }
      fs.unlinkSync(PROXY_PID)
    }
  } catch {
    // ignore
  }
}

async function proxyUp(): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    const res = await fetch(`${PROXY_HOST}/v1/models`, { signal: controller.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

async function waitForProxy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await proxyUp()) return true
    await sleep(500)
  }
  return false
}

async function ensureProxy(): Promise<void> {
  if (await proxyUp()) return
  startProxy()
  const ready = await waitForProxy(15_000)
  if (!ready) {
    throw new Error(`Ollama /v1 代理启动失败：无法连接 ${PROXY_HOST}，请检查 ${PROXY_SCRIPT}（可通过环境变量 OLLAMA_PROXY_SCRIPT 指定）与 node 是否可用`)
  }
}

async function ensureOllama(): Promise<void> {
  if (!(await ollamaAlive())) {
    startOllama()
    const ready = await waitForOllama(60_000)
    if (!ready) {
      throw new Error(`Ollama 服务启动失败：无法连接 ${OLLAMA_HOST}，请检查 ${OLLAMA_EXE}（可通过环境变量 OLLAMA_EXE 指定）是否存在`)
    }
  }
  await ensureProxy()
}

async function restartOllama(): Promise<void> {
  stopOllama()
  await sleep(3000)
  startOllama()
  const ready = await waitForOllama(60_000)
  if (!ready) {
    throw new Error("Ollama 服务重启失败：无法连接 127.0.0.1:11434")
  }
  await ensureProxy()
}

function appendErrorLog(detail: string): void {
  try {
    if (!fs.existsSync(TMP_DIR)) {
      fs.mkdirSync(TMP_DIR, { recursive: true })
    }
    fs.appendFileSync(ERROR_LOG, detail, "utf8")
  } catch {
    // 日志失败不影响主流程
  }
}

function shrinkImage(imagePath: string): { b64: string; width: number; height: number } {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true })
  }
  const tmpDir = fs.mkdtempSync(path.join(TMP_DIR, "vision-"))
  const inFile = path.join(tmpDir, "in.json")
  const outFile = path.join(tmpDir, "out.json")
  fs.writeFileSync(inFile, JSON.stringify({ imagePath }), "utf8")
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `try {`,
    `  Add-Type -AssemblyName System.Drawing`,
    `  $cfg = Get-Content -LiteralPath '${inFile}' -Raw -Encoding UTF8 | ConvertFrom-Json`,
    `  try { $src = [System.Drawing.Image]::FromFile($cfg.imagePath) } catch {`,
    `    Add-Type -AssemblyName PresentationCore`,
    `    $bi = New-Object System.Windows.Media.Imaging.BitmapImage`,
    `    $bi.BeginInit(); $bi.UriSource = [Uri]$cfg.imagePath; $bi.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad; $bi.EndInit()`,
    `    $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder`,
    `    $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bi))`,
    `    $convTmp = [System.IO.Path]::GetTempFileName() + '.png'`,
    `    $fs = [IO.File]::Create($convTmp); $enc.Save($fs); $fs.Close()`,
    `    $src = [System.Drawing.Image]::FromFile($convTmp)`,
    `    Remove-Item $convTmp -Force -ErrorAction SilentlyContinue`,
    `  }`,
    `  $maxSide = ${MAX_SIDE}`,
    `  $ratio = [double]$maxSide / [Math]::Max($src.Width, $src.Height)`,
    `  if ($ratio -gt 1) { $ratio = 1 }`,
    `  $nw = [int]($src.Width * $ratio)`,
    `  $nh = [int]($src.Height * $ratio)`,
    `  $tmp = [System.IO.Path]::GetTempFileName() + '.png'`,
    `  $bmp = [System.Drawing.Bitmap]::new($src, $nw, $nh)`,
    `  $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)`,
    `  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($tmp))`,
    `  $out = @{ b64 = $b64; width = $nw; height = $nh } | ConvertTo-Json -Compress`,
    `  [IO.File]::WriteAllText('${outFile}', $out, (New-Object System.Text.UTF8Encoding($false)))`,
    `} catch {`,
    `  [Console]::Error.WriteLine($_.Exception.Message)`,
    `  exit 1`,
    `} finally {`,
    `  Remove-Item $tmp -Force -ErrorAction SilentlyContinue`,
    `  if ($bmp) { $bmp.Dispose() }`,
    `  if ($src) { $src.Dispose() }`,
    `}`,
    `exit 0`,
  ].join("; ")
  const res = runPowerShell(script)
  if (!res.ok) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    const detail = `${new Date().toISOString()} shrinkImage 失败 exit=${String(res.status)} stderr=${res.stderr.trim()} stdout=${res.stdout.trim()}\n`
    appendErrorLog(detail)
    throw new Error(`图片处理失败：${res.stderr.trim() || res.stdout.trim() || "PowerShell 退出码异常"}`)
  }
  if (!fs.existsSync(outFile)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    const detail = `${new Date().toISOString()} shrinkImage 未生成 out.json stderr=${res.stderr.trim()} stdout=${res.stdout.trim()}\n`
    appendErrorLog(detail)
    throw new Error(`图片处理失败：未生成图片数据（PowerShell 输出：${res.stdout.trim() || res.stderr.trim() || "无"}）`)
  }
  const raw = fs.readFileSync(outFile, "utf8")
  fs.rmSync(tmpDir, { recursive: true, force: true })
  const parsed = JSON.parse(raw)
  if (!parsed.b64) throw new Error("图片处理失败：未生成图片数据")
  return { b64: parsed.b64, width: parsed.width, height: parsed.height }
}

async function postGenerate(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    const text = await res.text()
    const parsed = JSON.parse(text)
    return parsed as Record<string, unknown>
  } finally {
    clearTimeout(timer)
  }
}

function isGoodResponse(resp: Record<string, unknown> | null | undefined): boolean {
  if (!resp || typeof resp !== "object") return false
  if (resp.error) return false
  if (resp.done !== true) return false
  const text = String(resp.response ?? "")
  if (!text.trim()) return false
  if (/^@+$/.test(text.trim())) return false
  return true
}

async function generateWithRetry(body: Record<string, unknown>, maxPredict = 4096): Promise<string> {
  let lastError = ""
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await postGenerate(body)
      if (isGoodResponse(resp)) {
        const text = String(resp.response ?? "")
        const doneReason = String(resp.done_reason ?? "stop")
        const opts = body.options as Record<string, unknown>
        const curPredict = Number(opts.num_predict ?? NUM_PREDICT_DEFAULT)
        if (doneReason === "length" && curPredict < maxPredict) {
          const next = Math.min(curPredict * 2, maxPredict)
          opts.num_predict = next
          opts.num_ctx = Math.max(Number(opts.num_ctx ?? NUM_CTX), next + 1024)
          lastError = `输出被截断（done_reason=length），自动加大输出上限到 ${next} 重试`
          continue
        }
        return text
      }
      lastError = `响应异常（${String(resp?.error ?? "生成被中断")}）`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    if (attempt === 1) {
      await sleep(2000)
    } else if (attempt === 2) {
      await restartOllama()
    }
  }
  throw new Error(`视觉模型连续 ${MAX_ATTEMPTS} 次调用失败，最后一次：${lastError}（已自动重启 Ollama 服务，请重试）`)
}

function estimateImageTokens(width: number, height: number): number {
  const patches = Math.ceil(width / 28) * Math.ceil(height / 28)
  return Math.min(patches, 16_000)
}

async function recognizeImage(imagePath: string, prompt: string, tag = "图片识别", numPredict = NUM_PREDICT_DEFAULT): Promise<string> {
  const cacheKey = `${imagePath}\u0000${prompt}`
  const cached = visionCache.get(cacheKey)
  if (cached) return cached
  await ensureOllama()
  const { b64, width, height } = shrinkImage(imagePath)
  const modelName = MODEL_DEFAULT
  const q = prompt?.trim() || DEFAULT_QUESTION
  const ctx = Math.min(16_384, Math.max(NUM_CTX, estimateImageTokens(width, height) + numPredict + 1024))
  const body = {
    model: modelName,
    prompt: q,
    images: [b64],
    stream: false,
    think: false,
    options: { num_predict: numPredict, num_ctx: ctx },
  }
  const answer = await generateWithRetry(body)
  const result = `【${tag} · ${modelName} · ${width}x${height}】\n${answer}`
  visionCache.set(cacheKey, result)
  return result
}

function pdfToPng(pdfPath: string, pageIndex: number): { png: string; pageCount: number } {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true })
  }
  const hash = createHash("sha1").update(pdfPath + "\u0000" + pageIndex).digest("hex").slice(0, 16)
  const outPng = path.join(TMP_DIR, `pdf-${hash}-p${pageIndex + 1}.png`)
  const countFile = path.join(TMP_DIR, `pdf-${hash}.count`)
  if (fs.existsSync(outPng) && fs.existsSync(countFile)) {
    const pageCount = parseInt(fs.readFileSync(countFile, "utf8").trim(), 10) || 1
    return { png: outPng, pageCount }
  }
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `try {`,
    `  Add-Type -AssemblyName System.Runtime.WindowsRuntime`,
    `  [Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime] | Out-Null`,
    `  [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null`,
    `  [Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null`,
    `  [Windows.Storage.Streams.RandomAccessStreamOverStream,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null`,
    `  [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null`,
    `  [Windows.Graphics.Imaging.BitmapEncoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null`,
    `  [Windows.Graphics.Imaging.PixelDataProvider,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null`,
    `  $asTaskOp = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]`,
    `  $asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]`,
    `  function AwaitOp($op, $t) { $task = $asTaskOp.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; return $task.Result }`,
    `  function AwaitAction($op) { $task = $asTaskAction.Invoke($null, @($op)); $task.Wait(-1) | Out-Null }`,
    `  $cfg = @{ pdfPath = '${pdfPath}'; pageIndex = ${pageIndex}; outPng = '${outPng}' }`,
    `  $file = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($cfg.pdfPath)) ([Windows.Storage.StorageFile])`,
    `  $doc = AwaitOp ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])`,
    `  $countFile = '${countFile}'`,
    `  [IO.File]::WriteAllText($countFile, [string]$doc.PageCount, (New-Object System.Text.UTF8Encoding($false)))`,
    `  if ($cfg.pageIndex -ge $doc.PageCount) { throw "页码越界：共 $($doc.PageCount) 页，请求第 $($cfg.pageIndex + 1) 页" }`,
    `  $page = $doc.GetPage([uint32]$cfg.pageIndex)`,
    `  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream`,
    `  $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions`,
    `  $opts.DestinationWidth = [uint32]1600`,
    `  AwaitAction ($page.RenderToStreamAsync($stream, $opts)) | Out-Null`,
    `  $decoder = AwaitOp ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])`,
    `  $pixelData = AwaitOp ($decoder.GetPixelDataAsync()) ([Windows.Graphics.Imaging.PixelDataProvider])`,
    `  $pixels = $pixelData.DetachPixelData()`,
    `  $fileStream = [IO.File]::Create($cfg.outPng)`,
    `  $raStream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($fileStream)`,
    `  $encoder = AwaitOp ([Windows.Graphics.Imaging.BitmapEncoder]::CreateAsync([Windows.Graphics.Imaging.BitmapEncoder]::PngEncoderId, $raStream)) ([Windows.Graphics.Imaging.BitmapEncoder])`,
    `  $encoder.SetPixelData([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, [uint32]$decoder.PixelWidth, [uint32]$decoder.PixelHeight, 96.0, 96.0, $pixels)`,
    `  AwaitAction ($encoder.FlushAsync()) | Out-Null`,
    `  $fileStream.Close()`,
    `} catch {`,
    `  [Console]::Error.WriteLine($_.Exception.Message)`,
    `  exit 1`,
    `}`,
    `exit 0`,
  ].join("; ")
  const res = runPowerShell(script)
  if (!res.ok || !fs.existsSync(outPng)) {
    const detail = `${new Date().toISOString()} pdfToPng 失败 pdf=${pdfPath} page=${pageIndex + 1} stderr=${res.stderr.trim()}\n`
    appendErrorLog(detail)
    throw new Error(`PDF 渲染失败：${res.stderr.trim() || res.stdout.trim() || "未知错误"}（当前系统可能不支持 Windows.Data.Pdf）`)
  }
  const pageCount = fs.existsSync(countFile) ? parseInt(fs.readFileSync(countFile, "utf8").trim(), 10) || 1 : 1
  return { png: outPng, pageCount }
}

async function askLocal(prompt: string): Promise<string> {
  await ensureOllama()
  const body = {
    model: MODEL_DEFAULT,
    prompt,
    stream: false,
    think: false,
    options: { num_predict: NUM_PREDICT_DEFAULT, num_ctx: NUM_CTX },
  }
  return generateWithRetry(body)
}

function dataUrlToFile(dataUrl: string): string | null {
  const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl)
  if (!m) return null
  try {
    const mime = m[1].toLowerCase()
    const ext = mime.includes("png") ? "png" : mime.includes("jpeg") ? "jpg" : mime.includes("gif") ? "gif" : mime.includes("webp") ? "webp" : mime === "application/pdf" ? "pdf" : "bin"
    const file = path.join(TMP_DIR, `drag-${createHash("sha1").update(dataUrl).digest("hex").slice(0, 16)}.${ext}`)
    if (!fs.existsSync(file)) {
      if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })
      fs.writeFileSync(file, Buffer.from(m[2], "base64"))
    }
    return file
  } catch {
    return null
  }
}

function filePathFromPart(part: Part): string | null {
  if (part.type !== "file") return null
  const source = part as unknown as { source?: { path?: string }; url?: string }
  if (source.source?.path) return source.source.path
  if (source.url) {
    const u = source.url
    if (u.startsWith("data:")) return dataUrlToFile(u)
    const f = u.replace(/^file:\/\/\//, "").replace(/^file:\/\//, "")
    if (f) return f
  }
  return null
}

function imagePathFromPart(part: Part): string | null {
  if (part.type !== "file") return null
  const mime = (part.mime || "").toLowerCase()
  if (!mime.startsWith("image/")) return null
  return filePathFromPart(part)
}

function pdfPathFromPart(part: Part): string | null {
  if (part.type !== "file") return null
  const mime = (part.mime || "").toLowerCase()
  if (mime !== "application/pdf") return null
  return filePathFromPart(part)
}

export const Vision: Plugin = async () => {
  return {
    dispose: async () => {
      stopOllama()
      try {
        if (fs.existsSync(TMP_DIR)) {
          for (const f of fs.readdirSync(TMP_DIR)) {
            if (f.startsWith("drag-")) fs.unlinkSync(path.join(TMP_DIR, f))
          }
        }
      } catch {
        /* ignore */
      }
    },
    "chat.params": async (input) => {
      modelSupportsImage = input.model.capabilities?.input?.image === true
      currentModelName = (input.model.name ?? input.model.id ?? "").toLowerCase()
      // 切到本地 Ollama 模型时按需拉起服务（必须 await：等服务就绪后再发请求，否则 ECONNREFUSED）
      if (currentModelName.includes("qwen3.5") || currentModelName.includes("ollama")) {
        await ensureOllama().catch(() => {
          /* 拉起失败留给请求层报连接错误 */
        })
      }
    },
    tool: {
      image_vision: tool({
        description:
          "让 DeepSeek 看懂图片：读取本地图片文件，用本地视觉模型（Ollama + qwen3.5）识别内容并返回文字描述。内置稳定性保障：Ollama 服务未运行会自动启动，调用失败会自动重启服务并重试。适用于：论文图表、截图、照片、示意图等所有本地图片。图片会自动缩放到合适尺寸以加快识别速度。",
        args: {
          image_path: tool.schema
            .string()
            .describe("图片文件的绝对路径（支持 png/jpg/jpeg/bmp/gif，中文路径可用）"),
          question: tool.schema
            .string()
            .optional()
            .describe("想了解图片的什么问题（如『图例有什么』『文字内容是什么』『描述人物动作』）。不给则默认详细描述整张图"),
          model: tool.schema
            .string()
            .optional()
            .describe("视觉模型选择（可选）：'4b'（默认，qwen3.5:4b，快速且能读出小字）"),
        },
        async execute(args) {
          const imagePath = args.image_path
          if (!fs.existsSync(imagePath)) {
            throw new Error(`图片文件不存在：${imagePath}`)
          }
          const result = await recognizeImage(imagePath, args.question?.trim() || DEFAULT_QUESTION)
          return result
        },
      }),
      local_ask: tool({
        description:
          "调用本地 qwen3.5 模型处理低复杂度文本任务（翻译、摘要、分类、信息提取、格式整理、简单问答等），不消耗云端主模型配额，速度快、可离线、隐私安全。适合：批量小任务、敏感内容、主模型限流时。注意：复杂推理、长文写作、写代码等高质量任务请仍用主模型。",
        args: {
          prompt: tool.schema
            .string()
            .describe("要交给本地模型的任务指令，请包含具体上下文内容，写清楚要求"),
        },
        async execute(args) {
          const answer = await askLocal(args.prompt)
          return answer
        },
      }),
      image_ocr: tool({
        description:
          "OCR 文字提取：用本地视觉模型逐字提取图片中的全部文字（论文截图、扫描页、票据、手写体等），返回纯文本。图片自动缩放以加快速度，内置 Ollama 自动启动/重启/重试保障。",
        args: {
          image_path: tool.schema
            .string()
            .describe("图片文件的绝对路径（支持 png/jpg/jpeg/bmp/gif/webp/avif，中文路径可用）"),
        },
        async execute(args) {
          const imagePath = args.image_path
          if (!fs.existsSync(imagePath)) {
            throw new Error(`图片文件不存在：${imagePath}`)
          }
          const result = await recognizeImage(imagePath, PROMPT_OCR, "OCR", NUM_PREDICT_SHORT)
          return result
        },
      }),
      image_table: tool({
        description:
          "表格识别：用本地视觉模型把表格截图/图片转为 Markdown 表格，完整保留所有行列单元格内容。内置 Ollama 自动启动/重启/重试保障。",
        args: {
          image_path: tool.schema
            .string()
            .describe("表格图片文件的绝对路径（支持 png/jpg/jpeg/bmp/gif/webp/avif，中文路径可用）"),
        },
        async execute(args) {
          const imagePath = args.image_path
          if (!fs.existsSync(imagePath)) {
            throw new Error(`图片文件不存在：${imagePath}`)
          }
          const result = await recognizeImage(imagePath, PROMPT_TABLE, "表格识别", NUM_PREDICT_SHORT)
          return result
        },
      }),
      image_chart: tool({
        description:
          "图表解读：用本地视觉模型分析数据图表（折线/柱状/散点/饼图等），输出图表类型、坐标轴与图例含义、主要趋势与关键数值、核心结论，可选生成 matplotlib 复现代码。内置 Ollama 自动启动/重启/重试保障。",
        args: {
          image_path: tool.schema
            .string()
            .describe("图表图片文件的绝对路径（支持 png/jpg/jpeg/bmp/gif/webp/avif，中文路径可用）"),
          question: tool.schema
            .string()
            .optional()
            .describe("想重点了解图表的哪个方面（如『两条曲线何时相交』『X 从 0 到 10 的斜率』）。不给则全面分析"),
          want_code: tool.schema
            .boolean()
            .optional()
            .describe("是否额外给出用 Python matplotlib 复现该图的代码（默认 false）"),
        },
        async execute(args) {
          const imagePath = args.image_path
          if (!fs.existsSync(imagePath)) {
            throw new Error(`图片文件不存在：${imagePath}`)
          }
          const base = args.question?.trim() ? PROMPT_CHART + "\n额外关注：" + args.question.trim() : PROMPT_CHART
          const prompt = args.want_code ? PROMPT_CHART_CODE : base
          const result = await recognizeImage(imagePath, prompt, "图表解读")
          return result
        },
      }),
      image_pdf: tool({
        description:
          "PDF 识图：把 PDF 指定页面渲染成图片，再用本地视觉模型解读该页内容（标题、正文要点、表格、图表、公式）。无需安装任何软件（使用系统内置 Windows.Data.Pdf）。内置 Ollama 自动启动/重启/重试保障。",
        args: {
          pdf_path: tool.schema
            .string()
            .describe("PDF 文件的绝对路径（中文路径可用）"),
          page: tool.schema
            .number()
            .optional()
            .describe("要解读的页码，从 1 开始（默认 1）"),
          question: tool.schema
            .string()
            .optional()
            .describe("想重点了解该页的什么内容（如『摘要说了什么』『实验参数是多少』）。不给则详细描述整页"),
        },
        async execute(args) {
          const pdfPath = args.pdf_path
          if (!fs.existsSync(pdfPath)) {
            throw new Error(`PDF 文件不存在：${pdfPath}`)
          }
          const pageIndex = Math.max(1, Math.floor(args.page ?? 1)) - 1
          const { png, pageCount } = pdfToPng(pdfPath, pageIndex)
          const prompt = args.question?.trim()
            ? PROMPT_PDF(pageIndex + 1) + "\n额外关注：" + args.question.trim()
            : PROMPT_PDF(pageIndex + 1)
          const result = await recognizeImage(png, prompt, "PDF 识图")
          return result
        },
      }),
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      if (modelSupportsImage || VISION_SKIP_MODELS.some((m) => currentModelName.includes(m))) return
      for (const message of output.messages) {
        const imageParts: Array<{ part: Part; index: number; imagePath: string }> = []
        const pdfParts: Array<{ part: Part; index: number; pdfPath: string }> = []
        message.parts.forEach((part, index) => {
          const imagePath = imagePathFromPart(part)
          if (imagePath) {
            imageParts.push({ part, index, imagePath })
            return
          }
          const pdfPath = pdfPathFromPart(part)
          if (pdfPath) {
            pdfParts.push({ part, index, pdfPath })
          }
        })
        const entries: Array<{ index: number; text: string }> = []
        for (let i = 0; i < imageParts.length; i++) {
          const item = imageParts[i]
          const prefix = imageParts.length > 1 ? `\n--- 图片 ${i + 1} ---\n` : ""
          try {
            const desc = await recognizeImage(item.imagePath, DEFAULT_QUESTION)
            entries.push({ index: item.index, text: `${prefix}${desc}` })
          } catch (err) {
            entries.push({
              index: item.index,
              text: `${prefix}【图片自动识别失败】${err instanceof Error ? err.message : String(err)}`,
            })
          }
        }
        for (let i = 0; i < pdfParts.length; i++) {
          const item = pdfParts[i]
          const prefix = pdfParts.length > 1 ? `\n--- PDF ${i + 1} ---\n` : ""
          try {
            const { png, pageCount } = pdfToPng(item.pdfPath, 0)
            const desc = await recognizeImage(png, PROMPT_PDF(1), "PDF 识图")
            const rest = pageCount > 1 ? `。源文件：${item.pdfPath}（共 ${pageCount} 页）——如要解读第 2-${pageCount} 页，请调用 image_pdf 工具逐页继续（参数 pdf_path + page）` : ""
            entries.push({
              index: item.index,
              text: `${prefix}${desc}\n（该 PDF 还有更多页，可用 /pdf 命令指定页码继续解读${rest}）`,
            })
          } catch (err) {
            entries.push({
              index: item.index,
              text: `${prefix}【PDF 自动识别失败】${err instanceof Error ? err.message : String(err)}`,
            })
          }
        }
        const outputParts: Part[] = []
        for (let j = 0; j < message.parts.length; j++) {
          const found = entries.find((e) => e.index === j)
          if (found) {
            outputParts.push({
              id: (message.parts[j] as { id?: string }).id,
              sessionID: (message.parts[j] as { sessionID?: string }).sessionID,
              messageID: (message.parts[j] as { messageID?: string }).messageID,
              type: "text",
              text: found.text,
            })
          } else {
            outputParts.push(message.parts[j])
          }
        }
        message.parts = outputParts
      }
    },
  }
}