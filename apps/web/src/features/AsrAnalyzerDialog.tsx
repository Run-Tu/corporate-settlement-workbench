import { useEffect, useRef, useState } from "react";
import { loadDemoInterviewAudio, transcribeAudio } from "../services/asr";
import type { AsrTranscriptionResult } from "../services/asr";

const AUDIO_ACCEPT = ".wav,.mp3,.m4a,.aac,.flac,.ogg,.opus,.webm,audio/*";
const MAX_AUDIO_BYTES = 7 * 1024 * 1024;

export function AsrAnalyzerDialog({
  customerName,
  initialResult,
  onAnalysisComplete,
  onClose,
}: {
  customerName: string;
  initialResult?: AsrTranscriptionResult;
  onAnalysisComplete: (result: AsrTranscriptionResult) => void;
  onClose: () => void;
}) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [result, setResult] = useState<AsrTranscriptionResult | null>(initialResult ?? null);
  const [status, setStatus] = useState<"idle" | "transcribing" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [loadingDemo, setLoadingDemo] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  function selectFile(file: File | null) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (file && file.size > MAX_AUDIO_BYTES) {
      setSelectedFile(null);
      setPreviewUrl("");
      setResult(null);
      setStatus("error");
      setError("音频文件超过 7 MB，请压缩码率或截取 5 分钟以内的演示片段后重试。");
      setCopied(false);
      return;
    }
    setSelectedFile(file);
    setPreviewUrl(file ? URL.createObjectURL(file) : "");
    setResult(null);
    setStatus("idle");
    setError("");
    setCopied(false);
  }

  async function startTranscription() {
    if (!selectedFile) {
      setError("请先选择一份本地音频文件。");
      setStatus("error");
      return;
    }
    setStatus("transcribing");
    setError("");
    try {
      const nextResult = await transcribeAudio(selectedFile, customerName);
      setResult(nextResult);
      onAnalysisComplete(nextResult);
      setStatus("done");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "音频识别失败。");
      setStatus("error");
    }
  }

  async function useDemoAudio() {
    setLoadingDemo(true);
    setError("");
    try {
      selectFile(await loadDemoInterviewAudio());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "演示录音加载失败。");
      setStatus("error");
    } finally {
      setLoadingDemo(false);
    }
  }

  async function copyTranscript() {
    if (!result) return;
    await navigator.clipboard.writeText(result.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="statement-modal asr-modal" role="dialog" aria-modal="true" aria-label="客户访谈录音分析工具">
      <button className="statement-modal-backdrop" type="button" aria-label="关闭客户访谈录音分析工具" onClick={onClose} />
      <section className="statement-modal-panel asr-modal-panel">
        <header className="statement-modal-head">
          <div>
            <p className="eyebrow">客户访谈录音分析工具</p>
            <h2>{customerName}</h2>
          </div>
          <button type="button" aria-label="关闭客户访谈录音分析工具" onClick={onClose}>×</button>
        </header>
        <div className="asr-modal-body">
          <section className="asr-upload-panel">
            <button
              type="button"
              className="statement-dropzone asr-dropzone"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                selectFile(event.dataTransfer.files[0] ?? null);
              }}
            >
              <span className="asr-wave-icon" aria-hidden="true">▥</span>
              <strong>{selectedFile ? selectedFile.name : "选择或拖入客户访谈录音"}</strong>
              <span>wav / mp3 / m4a / aac / flac / ogg / opus / webm</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={AUDIO_ACCEPT}
              onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
              hidden
            />
            <button type="button" className="asr-demo-audio-button" disabled={loadingDemo || status === "transcribing"} onClick={useDemoAudio}>
              <span>✦</span>
              <div><strong>{loadingDemo ? "正在载入演示录音" : "使用资金需求演示录音"}</strong><small>多校区归集、闲置资金与流动性安排</small></div>
            </button>
            {selectedFile && (
              <div className="asr-file-meta">
                <span>本地文件</span>
                <strong>{formatFileSize(selectedFile.size)}</strong>
              </div>
            )}
            {previewUrl && <audio className="asr-audio-player" controls preload="metadata" src={previewUrl} />}
            <button type="button" className="primary-button" disabled={status === "transcribing"} onClick={startTranscription}>
              {status === "transcribing" ? "正在识别，请稍候..." : "开始语音识别"}
            </button>
            {error && <p className="statement-error">{error}</p>}
          </section>
          <section className="asr-result-panel">
            {result ? (
              <>
                <div className="asr-result-head">
                  <div>
                    <p className="eyebrow">识别完成</p>
                    <h3>客户原话转写</h3>
                  </div>
                  <button type="button" onClick={copyTranscript}>{copied ? "已复制" : "复制全文"}</button>
                </div>
                <div className="asr-summary-grid">
                  <div><span>音频时长</span><strong>{result.durationSeconds ?? "-"} 秒</strong></div>
                  <div><span>文本长度</span><strong>{result.text.length} 字</strong></div>
                  <div><span>词级片段</span><strong>{result.words.length} 个</strong></div>
                </div>
                <article className="asr-transcript">{result.text}</article>
                <div className="asr-result-foot">
                  <span>模型：{result.model}</span>
                  <span>请求编号：{result.requestId || "-"}</span>
                </div>
                <div className="asr-business-note">
                  <div className="asr-business-note-head">
                    <div><span>{result.insight.generatedBy === "llm" ? "GLM-5.2 业务凝练" : "业务规则兜底"}</span><strong>{result.insight.needType}</strong></div>
                    <em>{Math.round(result.insight.confidence * 100)}%</em>
                  </div>
                  <p>{result.insight.summary}</p>
                  <dl>
                    <div><dt>补充场景</dt><dd>{result.insight.scenarioName}</dd></div>
                    <div><dt>判断理由</dt><dd>{result.insight.rationale}</dd></div>
                    <div><dt>下一步核实</dt><dd>{result.insight.nextQuestion}</dd></div>
                  </dl>
                  <footer>
                    <span>{result.insight.generatedBy === "llm" ? `模型：${result.insight.sourceModel}` : "模型不可用，本次采用规则兜底"}</span>
                    <strong>✓ 已补充到下方场景画布</strong>
                  </footer>
                </div>
              </>
            ) : (
              <div className={`asr-empty-state ${status === "transcribing" ? "is-loading" : ""}`}>
                <span className="asr-empty-orbit" aria-hidden="true" />
                <strong>{status === "transcribing" ? "正在听取并识别录音" : "等待客户访谈录音"}</strong>
                <p>{status === "transcribing" ? "本地文件已安全提交到后端，识别完成后将在这里展示完整文本。" : "上传音频后，系统将在这里展示识别文字、音频时长和请求信息。"}</p>
              </div>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}
