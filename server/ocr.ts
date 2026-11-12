// Reading the text in images (screenshots, scans, photos of documents), with the operating system's own recognizer: Apple's Vision framework on macOS (through a small
// JavaScript-for-Automation script) and Windows.Media.Ocr on Windows (through a PowerShell script). No extra download, nothing leaves the computer.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAC_SCRIPT = `
ObjC.import("Vision"); ObjC.import("Foundation");
function run(argv) {
  var out = [];
  for (var i = 0; i < argv.length; i++) {
    try {
      var url = $.NSURL.fileURLWithPath(argv[i]);
      var handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $({}));
      var req = $.VNRecognizeTextRequest.alloc.init;
      req.recognitionLevel = 0;            // accurate (about 0.2 s an image; the very first run after a restart takes about a minute while macOS loads its model)
      req.usesLanguageCorrection = true;
      var cls = $.VNClassifyImageRequest.alloc.init;
      var ok = handler.performRequestsError($([req, cls]), $());
      var res = req.results, lines = [];
      for (var j = 0; j < res.count; j++) {
        var c = res.objectAtIndex(j).topCandidates(1);
        if (c.count > 0) lines.push(ObjC.unwrap(c.objectAtIndex(0).string));
      }
      var labels = [], cr = cls.results;
      if (cr) for (var k = 0; k < cr.count; k++) {
        var o = cr.objectAtIndex(k);
        if (o.confidence >= 0.3) labels.push(ObjC.unwrap(o.identifier));
        if (labels.length >= 8) break;
      }
      out.push(ok ? { t: lines.join("\\n"), l: labels } : null);
    } catch (e) { out.push(null); }
  }
  return JSON.stringify(out);
}
`;

const WIN_SCRIPT = `
param([string]$ListFile)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { [Console]::Error.WriteLine("no OCR language installed"); exit 3 }
$paths = @(Get-Content -Raw -Encoding UTF8 $ListFile | ConvertFrom-Json)
$out = New-Object System.Collections.ArrayList
foreach ($p in $paths) {
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    $lines = @($res.Lines | ForEach-Object { $_.Text })
    [void]$out.Add(($lines -join "\`n"))
  } catch { [void]$out.Add($null) }
}
ConvertTo-Json -InputObject @($out) -Compress
`;

/** What counts as "read" in the ocr column: 2 on a Mac (text + picture labels), 1 elsewhere (text only). */
export const OCR_DONE = process.platform === "darwin" ? 2 : 1;
export const ocrSupported = () => process.platform === "darwin" || process.platform === "win32";
let brokenUntil = 0;   // the recognizer failed outright (no language pack, no permission...): leave it alone for a while instead of retrying on every scan
export const ocrBroken = () => Date.now() < brokenUntil;

const tmpFile = (name: string, content: string) => {
  const f = path.join(os.tmpdir(), `yab-${process.pid}-${name}`);
  fs.writeFileSync(f, content, "utf8");
  return f;
};

/** Text (and on a Mac, what the picture shows) found in each image; null = that image could not be read. Throws if the recognizer itself is unavailable. */
export interface Seen { text: string; labels: string[] }
export function ocrBatch(files: string[]): Promise<(Seen | null)[]> {
  return new Promise((resolve, reject) => {
    if (!ocrSupported()) return reject(new Error("no OCR on this system"));
    let cmd: string, args: string[], cleanup: string[] = [];
    if (process.platform === "darwin") {
      const script = tmpFile("ocr.js", MAC_SCRIPT);
      cmd = "osascript"; args = ["-l", "JavaScript", script, ...files]; cleanup = [script];
    } else {
      const script = tmpFile("ocr.ps1", "﻿" + WIN_SCRIPT), list = tmpFile("ocr.json", JSON.stringify(files));
      cmd = "powershell.exe"; args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, list]; cleanup = [script, list];
    }
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 120_000, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      for (const f of cleanup) fs.rm(f, { force: true }, () => {});
      if (err) { brokenUntil = Date.now() + 60 * 60_000; return reject(new Error((stderr || err.message).toString().slice(0, 300))); }
      try {
        const out = JSON.parse(String(stdout).trim() || "[]") as (string | { t: string; l: string[] } | null)[];
        resolve(files.map((_, i) => { const o = out[i]; return typeof o === "string" ? { text: o, labels: [] } : o && typeof o === "object" ? { text: o.t ?? "", labels: (o.l ?? []).map((x) => x.replace(/_/g, " ")) } : null; }));
      } catch { brokenUntil = Date.now() + 60 * 60_000; reject(new Error("unreadable OCR output: " + String(stdout).slice(0, 200))); }
    });
  });
}
