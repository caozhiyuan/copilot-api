import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { useLanguage } from '../contexts/LanguageContext'
import {
  IMAGE_QUALITIES,
  IMAGE_SIZES,
  MAX_TOTAL_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  UPLOAD_MIME_TYPES,
  VIDEO_MODEL,
  VIDEO_RATIOS,
  VIDEO_RESOLUTIONS,
  type CreatedImage,
  type ImageCreationInput,
  type MediaUpload,
  type VideoCreationInput,
  type VideoCreationResult,
} from '../types/media'

type Mode = 'generate' | 'edit' | 'video'
const fieldClass =
  'w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50'
const buttonClass =
  'rounded-lg border border-line px-3 py-2 text-[13px] text-ink-soft hover:bg-sunken disabled:opacity-40'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-soft">
      {label}
      {children}
    </label>
  )
}

function UploadPreview({
  file,
  onRemove,
  removeLabel,
}: {
  file: File
  onRemove: () => void
  removeLabel: string
}) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const preview = URL.createObjectURL(file)
    setUrl(preview)
    return () => URL.revokeObjectURL(preview)
  }, [file])
  return (
    <div className="group relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-line bg-sunken">
      {url && (
        <img src={url} alt={file.name} className="h-full w-full object-cover" />
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`${removeLabel}: ${file.name}`}
        className="absolute right-1 top-1 rounded bg-black/70 px-1.5 text-white"
      >
        ×
      </button>
    </div>
  )
}

async function serializeFile(file: File): Promise<MediaUpload> {
  return {
    name: file.name,
    type: file.type,
    bytes: new Uint8Array(await file.arrayBuffer()),
  }
}

export default function MediaStudioPage({
  serverRunning,
}: {
  serverRunning: boolean
}) {
  const { t } = useLanguage()
  const formId = useId()
  const [mode, setMode] = useState<Mode>('generate')
  const [provider, setProvider] =
    useState<ImageCreationInput['provider']>('default')
  const [model, setModel] = useState('gpt-image-2')
  const [prompts, setPrompts] = useState<Record<Mode, string>>({
    generate: '',
    edit: '',
    video: '',
  })
  const prompt = prompts[mode]
  const [size, setSize] = useState<ImageCreationInput['size']>('auto')
  const [quality, setQuality] = useState<ImageCreationInput['quality']>('auto')
  const [count, setCount] = useState(1)
  const [editFiles, setEditFiles] = useState<File[]>([])
  const [firstFrame, setFirstFrame] = useState<File[]>([])
  const [duration, setDuration] = useState(8)
  const [aspectRatio, setAspectRatio] =
    useState<VideoCreationInput['aspectRatio']>('16:9')
  const [resolution, setResolution] =
    useState<VideoCreationInput['resolution']>('720p')
  const [audio, setAudio] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [images, setImages] = useState<CreatedImage[]>([])
  const [resultPrompt, setResultPrompt] = useState('')
  const [video, setVideo] = useState<VideoCreationResult | null>(null)
  const [polling, setPolling] = useState(false)
  const [pollError, setPollError] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const generationRequest = useRef<string | null>(null)
  const pollRequest = useRef<string | null>(null)
  const uploadInput = useRef<HTMLInputElement>(null)
  const files = mode === 'video' ? firstFrame : editFiles

  function stopWaiting() {
    const id = generationRequest.current
    generationRequest.current = null
    if (id) void window.electronAPI.cancelMediaRequest(id).catch(() => {})
    setBusy(false)
  }

  useEffect(() => {
    if (!serverRunning) {
      stopWaiting()
      setPolling(false)
    }
  }, [serverRunning])

  useEffect(
    () => () => {
      for (const id of [generationRequest.current, pollRequest.current]) {
        if (id) void window.electronAPI.cancelMediaRequest(id).catch(() => {})
      }
      generationRequest.current = null
    },
    [],
  )

  useEffect(() => {
    const requestId = video?.requestId
    if (!polling || !serverRunning || video?.status !== 'pending' || !requestId)
      return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const check = async () => {
      const id = crypto.randomUUID()
      pollRequest.current = id
      try {
        const result = await window.electronAPI.getVideo(id, requestId)
        if (!active) return
        setVideo({ ...result, requestId })
        setPollError('')
        if (result.status !== 'pending') {
          setPolling(false)
          return
        }
        timer = setTimeout(() => void check(), 5000)
      } catch (cause) {
        if (active) {
          setPollError(
            cause instanceof Error ? cause.message : t('studio.failed'),
          )
          setPolling(false)
        }
      } finally {
        if (pollRequest.current === id) pollRequest.current = null
      }
    }
    timer = setTimeout(() => void check(), 5000)
    return () => {
      active = false
      clearTimeout(timer)
      const id = pollRequest.current
      if (id) void window.electronAPI.cancelMediaRequest(id).catch(() => {})
      pollRequest.current = null
    }
  }, [polling, serverRunning, video?.requestId, video?.status])

  function addFiles(selected: File[]) {
    const next = [...files, ...selected]
    const limit = mode === 'video' ? 1 : 5
    if (
      next.length > limit
      || next.some(
        (file) =>
          !UPLOAD_MIME_TYPES.includes(file.type)
          || !file.size
          || file.size > MAX_UPLOAD_BYTES,
      )
      || next.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_UPLOAD_BYTES
    ) {
      setError(t('studio.uploadError'))
      return
    }
    if (mode === 'video') setFirstFrame(next)
    else setEditFiles(next)
    setError('')
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (
      busy
      || !serverRunning
      || !prompt.trim()
      || (mode === 'edit' && !editFiles.length)
      || (mode === 'video' && video?.status === 'pending')
    )
      return
    const id = crypto.randomUUID()
    generationRequest.current = id
    setBusy(true)
    setError('')
    setNotice('')
    setSaved(null)
    try {
      const uploads = await Promise.all(
        (mode === 'generate' ? [] : files).map(serializeFile),
      )
      if (generationRequest.current !== id) return
      if (mode === 'video') {
        const result = await window.electronAPI.createVideo(id, {
          prompt,
          duration,
          aspectRatio,
          resolution,
          generateAudio: audio,
          image: uploads[0],
        })
        if (generationRequest.current !== id) return
        setVideo(result)
        setPollError('')
        setPolling(result.status === 'pending')
      } else {
        const result = await window.electronAPI.createImages(id, {
          mode,
          provider,
          model,
          prompt,
          size,
          quality,
          n: count,
          images: uploads,
        })
        if (generationRequest.current !== id) return
        setImages(result)
        setResultPrompt(prompt)
      }
    } catch (cause) {
      if (generationRequest.current === id)
        setError(cause instanceof Error ? cause.message : t('studio.failed'))
    } finally {
      if (generationRequest.current === id) {
        generationRequest.current = null
        setBusy(false)
      }
    }
  }

  async function save(url: string, kind: 'image' | 'video') {
    if (saving) return
    setSaving(url)
    setError('')
    try {
      if (await window.electronAPI.saveMedia({ url, kind })) setSaved(url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('studio.failed'))
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden px-5 pb-5 pt-3 sm:px-6 sm:pb-6">
      <div className="mb-5 shrink-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          {t('studio.title')}
        </h1>
        <p className="mt-1 text-[13px] leading-5 text-ink-faint">
          {t('studio.description')}
        </p>
      </div>
      {!serverRunning && (
        <p
          role="status"
          className="mb-4 shrink-0 rounded-lg border border-amber-300/40 bg-amber-500/10 p-3 text-[13px] text-ink"
        >
          {t('studio.stopped')}
        </p>
      )}
      <div className="grid min-h-0 flex-1 gap-5 md:grid-cols-[340px_minmax(0,1fr)]">
        <form
          id={formId}
          onSubmit={submit}
          className="flex min-h-0 flex-col gap-3 overflow-hidden rounded-2xl border border-line-soft bg-surface p-3 shadow-sm"
        >
          <div
            className="flex shrink-0 gap-1 rounded-lg bg-sunken p-1"
            role="tablist"
            aria-label={t('studio.title')}
          >
            {(['generate', 'edit', 'video'] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={mode === item}
                disabled={busy}
                onClick={() => {
                  setMode(item)
                  setError('')
                  setNotice('')
                }}
                className={`flex-1 rounded-md px-1 py-1.5 text-xs transition-colors ${mode === item ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-ink-soft'}`}
              >
                {t(`studio.${item}`)}
              </button>
            ))}
          </div>
          <fieldset
            disabled={busy}
            className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto disabled:opacity-70"
          >
            {mode !== 'video' ?
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-3">
                <Field label={t('studio.provider')}>
                  <select
                    aria-label={t('studio.provider')}
                    className={fieldClass}
                    value={provider}
                    onChange={(e) => {
                      const next = e.target
                        .value as ImageCreationInput['provider']
                      setProvider(next)
                      setModel(
                        next === 'xai' ?
                          'grok-imagine-image-2.0'
                        : 'gpt-image-2',
                      )
                    }}
                  >
                    <option value="default">{t('studio.gateway')}</option>
                    <option value="codex">Codex</option>
                    <option value="xai">xAI</option>
                  </select>
                </Field>
                <Field label={t('studio.model')}>
                  <input
                    className={fieldClass}
                    required
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  />
                </Field>
              </div>
            : <p className="break-all rounded-lg bg-sunken px-3 py-2 font-mono text-xs text-ink-soft">
                {VIDEO_MODEL}
              </p>
            }
            {mode !== 'generate' && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-ink-soft">
                  {t(mode === 'video' ? 'studio.firstFrame' : 'studio.upload')}
                </p>
                <input
                  ref={uploadInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple={mode === 'edit'}
                  className="hidden"
                  aria-label={t('studio.upload')}
                  onChange={(e) => {
                    addFiles(Array.from(e.target.files ?? []))
                    e.target.value = ''
                  }}
                />
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (!busy) addFiles(Array.from(e.dataTransfer.files))
                  }}
                  className="rounded-lg border border-dashed border-line p-3"
                >
                  <div className="flex flex-wrap gap-2">
                    {files.map((file, index) => (
                      <UploadPreview
                        key={`${file.name}-${index}`}
                        file={file}
                        removeLabel={t('studio.remove')}
                        onRemove={() =>
                          mode === 'video' ?
                            setFirstFrame([])
                          : setEditFiles(
                              editFiles.filter((_, i) => i !== index),
                            )
                        }
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    className={`${buttonClass} mt-2 w-full`}
                    onClick={() => uploadInput.current?.click()}
                  >
                    + {t('studio.upload')}
                  </button>
                  <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
                    {t(
                      mode === 'video' ?
                        'studio.firstFrameHint'
                      : 'studio.uploadHint',
                    )}
                  </p>
                </div>
              </div>
            )}
            {mode !== 'video' ?
              <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.7fr)] gap-2">
                <Field label={t('studio.size')}>
                  <select
                    className={fieldClass}
                    value={size}
                    onChange={(e) =>
                      setSize(e.target.value as ImageCreationInput['size'])
                    }
                  >
                    {IMAGE_SIZES.map((item) => (
                      <option key={item} value={item}>
                        {item === 'auto' ? t('studio.auto') : item}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('studio.quality')}>
                  <select
                    className={fieldClass}
                    value={quality}
                    onChange={(e) =>
                      setQuality(
                        e.target.value as ImageCreationInput['quality'],
                      )
                    }
                  >
                    {IMAGE_QUALITIES.map((item) => (
                      <option key={item} value={item}>
                        {t(`studio.${item}`)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('studio.count')}>
                  <input
                    type="number"
                    min={1}
                    max={4}
                    value={count}
                    required
                    onChange={(e) => setCount(Number(e.target.value))}
                    className={fieldClass}
                  />
                </Field>
              </div>
            : <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('studio.duration')}>
                    <input
                      type="number"
                      min={1}
                      max={15}
                      value={duration}
                      required
                      onChange={(e) => setDuration(Number(e.target.value))}
                      className={fieldClass}
                    />
                  </Field>
                  <Field label={t('studio.resolution')}>
                    <select
                      className={fieldClass}
                      value={resolution}
                      onChange={(e) =>
                        setResolution(
                          e.target.value as VideoCreationInput['resolution'],
                        )
                      }
                    >
                      {VIDEO_RESOLUTIONS.map((item) => (
                        <option key={item}>{item}</option>
                      ))}
                    </select>
                  </Field>
                </div>
                {!firstFrame.length && (
                  <Field label={t('studio.ratio')}>
                    <select
                      className={fieldClass}
                      value={aspectRatio}
                      onChange={(e) =>
                        setAspectRatio(
                          e.target.value as VideoCreationInput['aspectRatio'],
                        )
                      }
                    >
                      {VIDEO_RATIOS.map((item) => (
                        <option key={item}>{item}</option>
                      ))}
                    </select>
                  </Field>
                )}
                <label className="flex items-center gap-2 text-[13px] text-ink-soft">
                  <input
                    type="checkbox"
                    checked={audio}
                    onChange={(e) => setAudio(e.target.checked)}
                  />
                  {t('studio.audio')}
                </label>
              </>
            }
          </fieldset>
          <div className="shrink-0 space-y-2 border-t border-line-soft pt-3">
            <p className="text-[11px] leading-4 text-ink-faint">
              {t(mode === 'video' ? 'studio.videoHint' : 'studio.gatewayHint')}
            </p>
            {error && (
              <p
                role="alert"
                className="max-h-24 overflow-y-auto break-words rounded-lg bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-400"
              >
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="text-xs text-ink-soft">
                {notice}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={
                  busy
                  || !serverRunning
                  || !prompt.trim()
                  || (mode !== 'video' && !model.trim())
                  || (mode === 'edit' && !editFiles.length)
                  || (mode === 'video' && video?.status === 'pending')
                }
                className="flex-1 rounded-lg bg-accent-strong px-4 py-2.5 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? t('studio.creating') : t('studio.create')}
              </button>
              {busy && (
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => {
                    stopWaiting()
                    setNotice(t('studio.cancelled'))
                  }}
                >
                  {t('studio.cancel')}
                </button>
              )}
            </div>
          </div>
        </form>
        <div className="flex min-h-0 min-w-0 flex-col gap-3">
          <section
            className={`flex min-h-0 flex-col rounded-2xl border border-line-soft bg-surface p-4 shadow-sm ${images.length || video ? 'flex-[2]' : 'flex-1'}`}
            aria-label={t('studio.prompt')}
          >
            <label className="flex min-h-0 flex-1 flex-col gap-2 text-sm font-semibold text-ink">
              {t('studio.prompt')}
              <textarea
                key={mode}
                form={formId}
                required
                disabled={busy}
                rows={6}
                value={prompt}
                onChange={(e) => {
                  const value = e.target.value
                  setPrompts((current) => ({
                    ...current,
                    [mode]: value,
                  }))
                }}
                placeholder={t(
                  mode === 'generate' ? 'studio.imagePrompt'
                  : mode === 'edit' ? 'studio.editPrompt'
                  : 'studio.videoPrompt',
                )}
                className={`${fieldClass} min-h-0 flex-1 resize-none font-normal`}
              />
            </label>
          </section>
          {(images.length > 0 || video) && (
            <section
              className="flex min-h-0 min-w-0 flex-[3] flex-col overflow-y-auto rounded-2xl border border-line-soft bg-surface p-4 shadow-sm"
              aria-label={t('studio.results')}
            >
              <h2 className="mb-4 shrink-0 text-sm font-semibold text-ink">
                {t('studio.results')}
              </h2>
              {video && (
                <div className="mb-4 shrink-0 space-y-3 rounded-lg border border-line bg-sunken p-3">
                  {video.requestId && (
                    <p className="break-all font-mono text-[11px] text-ink-soft">
                      {t('studio.requestId')}: {video.requestId}
                    </p>
                  )}
                  {video.status === 'pending' && (
                    <>
                      <p role="status" className="text-[13px] text-ink-soft">
                        {t(polling ? 'studio.pending' : 'studio.paused')}
                      </p>
                      {pollError && (
                        <p role="alert" className="text-xs text-red-500">
                          {pollError}
                        </p>
                      )}
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={!serverRunning}
                        onClick={() => {
                          setPollError('')
                          setPolling(!polling)
                        }}
                      >
                        {t(polling ? 'studio.pause' : 'studio.resume')}
                      </button>
                      <button
                        type="button"
                        className={`${buttonClass} ml-2`}
                        onClick={() => {
                          setPolling(false)
                          setVideo(null)
                          setPollError('')
                        }}
                      >
                        {t('studio.discard')}
                      </button>
                    </>
                  )}
                  {(video.status === 'failed'
                    || video.status === 'expired') && (
                    <p role="alert" className="text-xs text-red-500">
                      {video.error ?? t('studio.videoFailed')}
                    </p>
                  )}
                  {video.status === 'done' && video.url && (
                    <>
                      <video
                        src={video.url}
                        controls
                        preload="metadata"
                        className="max-h-[420px] w-full rounded-lg bg-black"
                      />
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={saving !== null}
                        onClick={() => void save(video.url!, 'video')}
                      >
                        {saving === video.url ?
                          t('studio.saving')
                        : saved === video.url ?
                          t('studio.saved')
                        : t('studio.save')}
                      </button>
                    </>
                  )}
                </div>
              )}
              <div className="grid shrink-0 gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                {images.map((image, index) => (
                  <figure
                    key={index}
                    className="min-w-0 overflow-hidden rounded-lg border border-line bg-sunken"
                  >
                    <img
                      src={image.url}
                      alt={resultPrompt}
                      className="max-h-[520px] w-full object-contain"
                    />
                    <figcaption className="flex flex-col gap-2 p-3">
                      <button
                        type="button"
                        disabled={saving !== null}
                        className={buttonClass}
                        onClick={() => void save(image.url, 'image')}
                      >
                        {saving === image.url ?
                          t('studio.saving')
                        : saved === image.url ?
                          t('studio.saved')
                        : t('studio.save')}
                      </button>
                      {image.revisedPrompt && (
                        <p className="line-clamp-3 text-xs text-ink-soft">
                          {image.revisedPrompt}
                        </p>
                      )}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
