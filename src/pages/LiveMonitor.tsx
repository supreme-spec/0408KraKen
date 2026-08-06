// @ts-nocheck
/**
 * LiveMonitor — свободное расположение блоков.
 * Перемещение: тянешь за любое место блока.
 * Изменение размера: тянешь за любой из 8 краёв (зона 10px по периметру).
 * Раскладка сохраняется в localStorage.
 */
import { useState, useCallback, useEffect, useRef } from 'react'
import LiveVideo from '../components/LiveVideo'
import PersonCard from '../components/PersonCard'
import EventsFeed from '../components/EventsFeed'
import CategoryBadge from '../components/CategoryBadge'
import RoiEditor from '../components/RoiEditor'
import { useDragResize, type Rect } from '../hooks/useDragResize'
import type { FaceDetection, KrakenEvent, Person, Category, Camera } from '../types'
import { apiFetch, apiUpload, PHOTO_BASE, wsUrl } from '../api/client'
import { Search, Plus, Edit2, Trash2, X, Upload, ScanLine, LayoutGrid, Eye, EyeOff, RotateCcw, Camera as CameraIcon, RefreshCw, ImagePlus, Save, FolderOpen, WifiOff } from 'lucide-react'
import ConfirmModal, { AlertModal } from '../components/ConfirmModal'

const CATEGORIES: Category[] = ['VIP', 'CLIENT', 'STAFF', 'BLACKLIST', 'RESPONSE', 'SECURITY']
const CATEGORY_LABELS: Record<string, string> = {
  VIP: 'VIP', CLIENT: 'Клиент', STAFF: 'Персонал',
  BLACKLIST: 'Чёрный список', RESPONSE: 'Реагирование', SECURITY: 'Охрана',
}

// ── Layout ────────────────────────────────────────────────────────────────────

type BlockId = 'video' | 'person' | 'people' | 'events' | 'guest'

interface BlockState { rect: Rect; visible: boolean; zIndex: number }
type Layout = Record<BlockId, BlockState>

const LAYOUT_KEY = 'kraken_free_layout_v2'
const TEMPLATES_KEY = 'kraken_layout_templates_v1'

// ── Templates ─────────────────────────────────────────────────────────────────

interface LayoutTemplate {
  name: string
  layout: Layout
  savedAt: string
}

function loadTemplates(): LayoutTemplate[] {
  try {
    const s = localStorage.getItem(TEMPLATES_KEY)
    if (s) return JSON.parse(s) as LayoutTemplate[]
  } catch {}
  return []
}

function saveTemplates(templates: LayoutTemplate[]) {
  try { localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates)) } catch {}
}

function defaultLayout(cw: number, ch: number): Layout {
  const thirdH = Math.floor(ch * 0.55)
  const bottomH = ch - thirdH - 4
  const guestW = Math.floor(cw * 0.22)
  return {
    video:  { rect: { x: 0, y: 0, w: Math.floor(cw * 0.6), h: thirdH }, visible: true, zIndex: 1 },
    person: { rect: { x: Math.floor(cw * 0.6) + 4, y: 0, w: Math.floor(cw * 0.4) - 4, h: thirdH }, visible: true, zIndex: 1 },
    people: { rect: { x: 0, y: thirdH + 4, w: Math.floor(cw * 0.65) - guestW - 4, h: bottomH }, visible: true, zIndex: 1 },
    events: { rect: { x: Math.floor(cw * 0.65) + 4, y: thirdH + 4, w: Math.floor(cw * 0.35) - 4, h: bottomH }, visible: true, zIndex: 1 },
    guest:  { rect: { x: Math.floor(cw * 0.65) - guestW, y: thirdH + 4, w: guestW - 4, h: bottomH }, visible: true, zIndex: 2 },
  }
}

function sanitizeLayout(parsed: Layout, cw: number, ch: number): Layout {
  const ids: BlockId[] = ['video', 'person', 'people', 'events', 'guest']
  const minW = 120
  const minH = 80
  const safeW = Math.max(cw, 400)
  const safeH = Math.max(ch, 300)

  for (const id of ids) {
    const block = parsed[id]
    if (!block?.rect) return defaultLayout(safeW, safeH)
    block.rect.w = Math.max(minW, Math.min(block.rect.w, safeW))
    block.rect.h = Math.max(minH, Math.min(block.rect.h, safeH))
    block.rect.x = Math.max(0, Math.min(block.rect.x, safeW - block.rect.w))
    block.rect.y = Math.max(0, Math.min(block.rect.y, safeH - block.rect.h))
  }
  if (!ids.some(id => parsed[id].visible)) {
    parsed.video.visible = true
  }
  return parsed
}

function loadLayout(cw: number, ch: number): Layout {
  const safeW = Math.max(cw, 400)
  const safeH = Math.max(ch, 300)
  try {
    const s = localStorage.getItem(LAYOUT_KEY)
    if (s) {
      const parsed = JSON.parse(s) as Layout
      const ids: BlockId[] = ['video', 'person', 'people', 'events', 'guest']
      if (ids.every(id => parsed[id]?.rect)) return sanitizeLayout(parsed, safeW, safeH)
    }
  } catch {}
  return defaultLayout(safeW, safeH)
}

function saveLayout(l: Layout) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(l)) } catch {}
}

// ── Draggable block ───────────────────────────────────────────────────────────

interface BlockProps {
  id: BlockId
  state: BlockState
  containerRef: React.RefObject<HTMLDivElement | null>
  onRectChange: (id: BlockId, rect: Rect) => void
  onFocus: (id: BlockId) => void
  title: string
  children: React.ReactNode
  headerExtra?: React.ReactNode
}

function DraggableBlock({ id, state, containerRef, onRectChange, onFocus, title, children, headerExtra }: BlockProps) {
  const { rect, zIndex } = state

  const handleChange = useCallback((r: Rect) => onRectChange(id, r), [id, onRectChange])
  const { elRef, onMouseDown, onMouseMove } = useDragResize(rect, handleChange, containerRef)

  return (
    <div
      ref={elRef}
      onMouseDown={(e) => { onFocus(id); onMouseDown(e) }}
      onMouseMove={onMouseMove}
      style={{
        position: 'absolute',
        left: rect.x, top: rect.y,
        width: rect.w, height: rect.h,
        zIndex,
        display: 'flex', flexDirection: 'column',
      }}
      className="panel overflow-hidden select-none"
    >
      {/* Заголовок */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-kraken-border flex-shrink-0 bg-kraken-panel/90">
        <span className="text-kraken-disabled text-[10px] select-none">⠿</span>
        <span className="text-kraken-muted text-[10px] font-semibold uppercase tracking-widest flex-shrink-0">
          {title}
        </span>
        {headerExtra && (
          <div className="flex-1 min-w-0 flex items-center gap-2">{headerExtra}</div>
        )}
      </div>
      {/* Контент */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {children}
      </div>
    </div>
  )
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  selectedCameraId: number | null
  cameras: Camera[]
  onSelectCamera: (id: number) => void
  recentEvents: KrakenEvent[]
  onLatestFace?: (face: FaceDetection | null) => void
  onNavigateEvents?: () => void
  onNavigatePeople?: () => void
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function LiveMonitor({
  cameras, selectedCameraId, onSelectCamera,
  recentEvents, onLatestFace, onNavigateEvents, onNavigatePeople,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState({ w: 1200, h: 700 })
  const [layout, setLayout] = useState<Layout>(() => defaultLayout(1200, 700))
  const [showMenu, setShowMenu] = useState(false)
  const [showRoi, setShowRoi] = useState(false)
  const [captureFlash, setCaptureFlash] = useState(false)
  const [captureMsg, setCaptureMsg] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [recordingMsg, setRecordingMsg] = useState('')
  const [confirmState, setConfirmState] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    isDamage?: boolean;
  } | null>(null)
  const [alertState, setAlertState] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
  } | null>(null)
  const selectedCamera = cameras.find(c => c.id === selectedCameraId) ?? null

  // Templates state
  const [templates, setTemplates] = useState<LayoutTemplate[]>(() => loadTemplates())
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [newTemplateName, setNewTemplateName] = useState('')

  // Измеряем контейнер и загружаем layout
  useEffect(() => {
    const measure = () => {
      const el = containerRef.current
      if (!el) return
      const w = el.clientWidth
      const h = el.clientHeight
      if (w < 50 || h < 50) return
      setContainerSize({ w, h })
      setLayout(loadLayout(w, h))
    }
    // Небольшая задержка чтобы контейнер успел отрендериться
    const t = setTimeout(measure, 50)
    const ro = new ResizeObserver(measure)
    if (containerRef.current) ro.observe(containerRef.current)
    return () => { clearTimeout(t); ro.disconnect() }
  }, [])

  // ── Снимок с камеры по клавише S/Ы ─────────────────────────────────────────
  const handleCapture = useCallback(async () => {
    if (!selectedCameraId) return
    setCaptureMsg('')
    // Вспышка камеры
    setCaptureFlash(true)
    setTimeout(() => setCaptureFlash(false), 400)
    try {
      const token = localStorage.getItem('kraken_token')
      const res = await fetch(`/api/cameras/${selectedCameraId}/capture`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || 'Request failed')
      }
      const data = await res.json()
      console.log('Capture success:', data)
      setCaptureMsg('✅ Снимок сохранён в «Мои фото» (фотохроника)')
    } catch (e) {
      console.error('Capture error:', e)
      setCaptureMsg('❌ Ошибка снимка')
    }
    setTimeout(() => setCaptureMsg(''), 3000)
  }, [selectedCameraId])

  // ── W/Ц: нажали — начать запись, отпустили — остановить ─────────────────────
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.repeat) return // не реагировать на автоповтор клавиши

      const key = e.key.toLowerCase()
      const isRecordKey = key === 'w' || key === 'ц' || e.code === 'KeyW'
      const isCaptureKey = key === 's' || key === 'ы' || e.code === 'KeyS'
      if (isRecordKey) {
        if (!selectedCameraId || isRecording) return
        e.preventDefault()
        try {
          const token = localStorage.getItem('kraken_token')
          await fetch(`/api/cameras/${selectedCameraId}/recording/start`, {
            method: 'POST',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          })
          setIsRecording(true)
          setRecordingMsg('🔴 Запись...')
        } catch (e) {
          console.error('Recording start error:', e)
          setRecordingMsg('❌ Ошибка записи')
        }
      }
      // S/Ы — ручное фото
      if (isCaptureKey) {
        if (!selectedCameraId) return
        e.preventDefault()
        handleCapture()
      }
    }

    const handleKeyUp = async (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      const key = e.key.toLowerCase()
      const isRecordKey = key === 'w' || key === 'ц' || e.code === 'KeyW'
      if (isRecordKey) {
        if (!selectedCameraId || !isRecording) return
        e.preventDefault()
        try {
          const token = localStorage.getItem('kraken_token')
          await fetch(`/api/cameras/${selectedCameraId}/recording/stop`, {
            method: 'POST',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          })
          setIsRecording(false)
          setRecordingMsg('⏹️ Запись остановлена')
        } catch (e) {
          console.error('Recording stop error:', e)
        }
        setTimeout(() => setRecordingMsg(''), 2000)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [selectedCameraId, handleCapture, isRecording])

  const updateRect = useCallback((id: BlockId, rect: Rect) => {
    setLayout(prev => {
      const next = { ...prev, [id]: { ...prev[id], rect } }
      saveLayout(next)
      return next
    })
  }, [])

  const bringToFront = useCallback((id: BlockId) => {
    setLayout(prev => {
      const maxZ = Math.max(...Object.values(prev).map(b => b.zIndex))
      const next = { ...prev, [id]: { ...prev[id], zIndex: maxZ + 1 } }
      saveLayout(next)
      return next
    })
  }, [])

  const toggleVis = (id: BlockId) => {
    setLayout(prev => {
      const next = { ...prev, [id]: { ...prev[id], visible: !prev[id].visible } }
      saveLayout(next)
      return next
    })
  }

  const resetLayout = () => {
    const l = defaultLayout(containerSize.w, containerSize.h)
    setLayout(l)
    saveLayout(l)
  }

  const saveTemplate = (name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const newTemplates = [
      { name: trimmed, layout, savedAt: new Date().toISOString() },
      ...templates.filter(t => t.name !== trimmed),
    ].slice(0, 10) // max 10 templates
    setTemplates(newTemplates)
    saveTemplates(newTemplates)
    setShowSaveDialog(false)
    setNewTemplateName('')
  }

  const loadTemplate = (tpl: LayoutTemplate) => {
    setLayout(tpl.layout)
    saveLayout(tpl.layout)
    setShowMenu(false)
  }

  const deleteTemplate = (name: string) => {
    const updated = templates.filter(t => t.name !== name)
    setTemplates(updated)
    saveTemplates(updated)
  }

  // Face detection
  const onLatestFaceRef = useRef(onLatestFace)
  useEffect(() => { onLatestFaceRef.current = onLatestFace }, [onLatestFace])
  const [detectedFace, setDetectedFace] = useState<FaceDetection | null>(null)
  const [detectedPerson, setDetectedPerson] = useState<Person | null>(null)
  const [recognitionThreshold, setRecognitionThreshold] = useState<number>(0.6)

  useEffect(() => {
    apiFetch<any>('/settings/')
      .then(s => {
        if (s?.verification_threshold_pct != null) {
          setRecognitionThreshold(s.verification_threshold_pct / 100)
        }
      })
      .catch(() => {})
  }, [])

  const handleFaceDetected = useCallback((face: FaceDetection) => {
    if (face.track_id === -1) {
      onLatestFaceRef.current?.(null)
      setDetectedFace(null); setDetectedPerson(null)
      return
    }
    onLatestFaceRef.current?.(face)
    setDetectedFace(face)
    if (face.person_id && face.person_name) {
      setDetectedPerson({
        id: face.person_id, name: face.person_name,
        category: (face.category ?? 'CLIENT') as any,
        comment: face.comment ?? null, photo_path: face.photo_path ?? null,
        photos: [], is_active: true, created_at: '', embedding_count: 0,
      })
    } else {
      setDetectedPerson(null)
    }
  }, [])

  // People
  const [people, setPeople] = useState<Person[]>([])
  const [search, setSearch] = useState('')
  const [loadingPeople, setLoadingPeople] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)
  const [editPerson, setEditPerson] = useState<Person | null>(null)

  const fetchPeople = useCallback(async () => {
    setLoadingPeople(true)
    try {
      const queryParts: string[] = []
      if (search) queryParts.push(`search=${encodeURIComponent(search)}`)
      const data = await apiFetch<Person[]>(`/persons/?${queryParts.join('&')}`)
      setPeople(data)
    } catch {}
    finally { setLoadingPeople(false) }
  }, [search])

  useEffect(() => { fetchPeople() }, [fetchPeople])

  const handleDelete = (id: number) => {
    setConfirmState({
      isOpen: true,
      title: 'Удалить человека',
      message: 'Удалить человека из базы?',
      isDamage: true,
      onConfirm: async () => {
        setConfirmState(null)
        try {
          await apiFetch(`/persons/${id}`, { method: 'DELETE' })
          fetchPeople()
        } catch (e: any) {
          setAlertState({ isOpen: true, title: 'Ошибка', message: 'Ошибка удаления: ' + e.message })
        }
      }
    })
  }

  const handleAddPhotoFromCamera = async (personId: number, cameraId: number) => {
    if (!selectedCameraId) {
      alert('Выберите камеру')
      return
    }
    try {
      // Берём snapshot с камеры
      const snap = await apiFetch<{ image: string; content_type: string }>(
        `/cameras/${cameraId}/snapshot`
      )
      // Создаём файл из base64
      const byteStr = atob(snap.image)
      const arr = new Uint8Array(byteStr.length)
      for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i)
      const file = new File([arr], `snap_${Date.now()}.jpg`, { type: 'image/jpeg' })
      
      // Загружаем фото через FormData
      const fd = new FormData()
      fd.append('photos', file)
      await apiUpload(`/persons/${personId}/photos`, fd)
      
      fetchPeople()
      alert('Фото с камеры добавлено! Распознавание улучшено.')
    } catch (e: any) {
      const msg = e.message || 'Неизвестная ошибка'
      alert(`Ошибка: ${msg}\n\nУбедитесь что камера активна и поток запущен.`)
    }
  }

  const BLOCK_TITLES: Record<BlockId, string> = {
    video: 'Видео', person: 'Распознанный человек',
    people: 'База людей', events: 'Последние события',
    guest: 'Последний гость',
  }

  return (
    <div className="flex-1 h-full flex flex-col overflow-hidden">

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 mb-0.5 flex-shrink-0">
        <span className="text-kraken-muted text-xs font-semibold">Камера:</span>
        <div className="flex items-center gap-1 flex-1 flex-wrap">
          {cameras.length === 0 && (
            <span className="text-kraken-disabled text-[10px]">Нет камер в системе</span>
          )}
          {cameras.map(cam => {
            const isOff = cam.status !== 'online' && !cam.is_active
            return (
            <button key={cam.id} onClick={() => onSelectCamera(cam.id)}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors flex items-center gap-1.5 ${
                selectedCameraId === cam.id
                  ? 'bg-kraken-purple text-white'
                  : isOff
                    ? 'bg-kraken-base text-kraken-disabled border border-kraken-border cursor-not-allowed'
                    : 'bg-kraken-hover text-kraken-muted hover:text-kraken-text hover:bg-kraken-border'
              }`}
              title={isOff ? `Камера отключена (статус: ${cam.status})` : cam.name}>
              {isOff && <WifiOff size={10} />}
              {cam.name}
            </button>
          )})}
        </div>

        {selectedCamera && (
          <button onClick={() => setShowRoi(true)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors flex-shrink-0 ${
              selectedCamera.roi_zones?.length
                ? 'bg-kraken-purple/20 text-kraken-purple border border-kraken-purple/40'
                : 'bg-kraken-hover text-kraken-muted hover:text-kraken-purple'
            }`}>
            <ScanLine size={13} />
            {selectedCamera.roi_zones?.length
              ? `${selectedCamera.roi_zones.length} зон${selectedCamera.roi_zones.length === 1 ? 'а' : 'ы'}`
              : 'Зоны'}
          </button>
        )}

        {recordingMsg && (
          <span className={`text-xs font-bold px-2 py-1 rounded-lg ${
            recordingMsg.startsWith('🔴')
              ? 'bg-kraken-red/20 text-kraken-red animate-pulse'
              : 'bg-kraken-hover text-kraken-muted'
          }`}>
            {recordingMsg}
          </span>
        )}
        {captureMsg && (
          <span className={`text-xs font-bold px-2 py-1 rounded-lg ${
            captureMsg.startsWith('✅')
              ? 'bg-kraken-green/20 text-kraken-green'
              : 'bg-kraken-red/20 text-kraken-red'
          }`}>
            {captureMsg}
          </span>
        )}

        <div className="relative flex-shrink-0">
          <button onClick={() => setShowMenu(p => !p)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs bg-kraken-hover text-kraken-muted hover:text-kraken-text transition-colors">
            <LayoutGrid size={13} /> Блоки
          </button>
          {showMenu && (
            <>
              <div className="fixed inset-0 z-[9998]" onClick={() => setShowMenu(false)} />
              <div className="absolute right-0 top-full mt-1 z-[9999] bg-kraken-panel border border-kraken-border rounded-xl shadow-2xl p-3 w-64 animate-fade-in">

                {/* Показать / скрыть блоки */}
                <div className="text-kraken-disabled text-[10px] uppercase tracking-widest mb-2">Показать / скрыть</div>
                {(Object.keys(BLOCK_TITLES) as BlockId[]).map(id => (
                  <button key={id} onClick={() => toggleVis(id)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-kraken-hover text-sm transition-colors">
                    {layout[id].visible
                      ? <Eye size={13} className="text-kraken-green flex-shrink-0" />
                      : <EyeOff size={13} className="text-kraken-disabled flex-shrink-0" />}
                    <span className={layout[id].visible ? 'text-kraken-text' : 'text-kraken-disabled'}>
                      {BLOCK_TITLES[id]}
                    </span>
                  </button>
                ))}

                <div className="border-t border-kraken-border mt-2 pt-2">
                  <button onClick={() => { resetLayout(); setShowMenu(false) }}
                    className="w-full flex items-center justify-center gap-1.5 text-xs text-kraken-muted hover:text-kraken-text py-1 transition-colors">
                    <RotateCcw size={11} /> Сбросить расположение
                  </button>
                </div>

                {/* Шаблоны */}
                <div className="border-t border-kraken-border mt-2 pt-2">
                  <div className="text-kraken-disabled text-[10px] uppercase tracking-widest mb-2">Шаблоны раскладки</div>

                  {/* Сохранить текущий */}
                  {!showSaveDialog ? (
                    <button
                      onClick={() => setShowSaveDialog(true)}
                      className="w-full flex items-center justify-center gap-1.5 text-xs text-kraken-purple hover:text-kraken-purple/80 py-1.5 rounded-lg hover:bg-kraken-purple/10 transition-colors border border-dashed border-kraken-purple/40">
                      <Save size={11} /> Сохранить текущий шаблон
                    </button>
                  ) : (
                    <div className="flex gap-1.5 mb-2">
                      <input
                        autoFocus
                        type="text"
                        value={newTemplateName}
                        onChange={e => setNewTemplateName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveTemplate(newTemplateName); if (e.key === 'Escape') { setShowSaveDialog(false); setNewTemplateName('') } }}
                        placeholder="Название шаблона..."
                        className="flex-1 bg-kraken-base border border-kraken-border text-kraken-text text-xs px-2 py-1.5 rounded-lg focus:outline-none focus:border-kraken-purple"
                      />
                      <button
                        onClick={() => saveTemplate(newTemplateName)}
                        disabled={!newTemplateName.trim()}
                        className="px-2 py-1.5 bg-kraken-purple text-white text-xs rounded-lg hover:bg-kraken-purple/80 disabled:opacity-40 transition-colors">
                        <Save size={11} />
                      </button>
                      <button
                        onClick={() => { setShowSaveDialog(false); setNewTemplateName('') }}
                        className="px-2 py-1.5 bg-kraken-hover text-kraken-muted text-xs rounded-lg hover:text-kraken-text transition-colors">
                        <X size={11} />
                      </button>
                    </div>
                  )}

                  {/* Список шаблонов */}
                  {templates.length > 0 && (
                    <div className="mt-2 flex flex-col gap-1">
                      {templates.map(tpl => (
                        <div key={tpl.name} className="flex items-center gap-1.5 group">
                          <button
                            onClick={() => loadTemplate(tpl)}
                            className="flex-1 flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-kraken-hover text-xs text-kraken-text transition-colors text-left">
                            <FolderOpen size={11} className="text-kraken-muted flex-shrink-0" />
                            <span className="truncate">{tpl.name}</span>
                          </button>
                          <button
                            onClick={() => deleteTemplate(tpl.name)}
                            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-kraken-hover text-kraken-disabled hover:text-kraken-red transition-all">
                            <Trash2 size={10} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {templates.length === 0 && !showSaveDialog && (
                    <p className="text-kraken-disabled text-[10px] text-center mt-1">
                      Нет сохранённых шаблонов
                    </p>
                  )}
                </div>

                <p className="text-kraken-disabled text-[10px] mt-2 text-center leading-relaxed border-t border-kraken-border pt-2">
                  Тяни за любое место — перемещение<br/>
                  Тяни за любой край — изменение размера
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Вспышка камеры ── */}
      <div
        className="fixed inset-0 z-[9999] pointer-events-none transition-opacity duration-300"
        style={{
          background: 'white',
          opacity: captureFlash ? 0.6 : 0,
        }}
      />

      {/* ── Свободный холст ── */}
      <div ref={containerRef} className="flex-1 h-full relative overflow-hidden bg-kraken-base">

        {!layout.video.visible && (
          <div className="absolute top-2 left-2 z-20 bg-kraken-red/90 text-white text-xs px-3 py-1.5 rounded-lg shadow-lg">
            Блок «Видео» скрыт — откройте меню «Блоки» и включите Видео
          </div>
        )}

        {/* Видео */}
        {layout.video.visible && (
          <DraggableBlock id="video" state={layout.video} containerRef={containerRef}
            onRectChange={updateRect} onFocus={bringToFront} title="Видео">
            <LiveVideo cameraId={selectedCameraId} onFaceDetected={handleFaceDetected} />
          </DraggableBlock>
        )}

        {/* Карточка человека */}
        {layout.person.visible && (
          <DraggableBlock id="person" state={layout.person} containerRef={containerRef}
            onRectChange={updateRect} onFocus={bringToFront} title="Распознанный человек">
            <div className="h-full overflow-y-auto">
              <PersonCard
                person={detectedPerson}
                confidence={detectedFace?.confidence}
                onClose={() => { setDetectedPerson(null); setDetectedFace(null) }}
              />
            </div>
          </DraggableBlock>
        )}

        {/* База людей */}
        {layout.people.visible && (
          <DraggableBlock id="people" state={layout.people} containerRef={containerRef}
            onRectChange={updateRect} onFocus={bringToFront} title="База людей"
            headerExtra={
              <>
                <div className="relative flex-1 max-w-[180px]">
                  <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-kraken-muted" />
                  <input type="text" placeholder="Поиск..." value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="w-full bg-kraken-base border border-kraken-border text-kraken-text text-xs pl-6 pr-2 py-1 rounded-lg focus:outline-none focus:border-kraken-purple" />
                </div>
                <button onClick={() => { setEditPerson(null); setShowAddModal(true) }}
                  className="flex items-center gap-1 bg-kraken-purple hover:bg-kraken-purple-hover text-white text-xs px-2 py-1 rounded-lg font-semibold transition-colors flex-shrink-0">
                  <Plus size={11} /> Добавить
                </button>
              </>
            }>
            <div className="h-full flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto">
                <table className="w-full">
                  <thead className="sticky top-0 bg-kraken-panel z-10">
                    <tr className="text-kraken-disabled text-[10px] uppercase tracking-wider border-b border-kraken-border">
                      <th className="px-3 py-1.5 text-left">Фото</th>
                      <th className="px-3 py-1.5 text-left">Имя</th>
                      <th className="px-3 py-1.5 text-left">Категория</th>
                      <th className="px-3 py-1.5 text-left">Комментарий</th>
                      <th className="px-3 py-1.5 text-right">Действия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadingPeople && (
                      <tr><td colSpan={5} className="text-center py-4 text-kraken-disabled text-xs">Загрузка...</td></tr>
                    )}
                    {!loadingPeople && people.length === 0 && (
                      <tr><td colSpan={5} className="text-center py-6">
                        <div className="text-kraken-disabled text-sm mb-1">База пуста</div>
                        <button onClick={() => { setEditPerson(null); setShowAddModal(true) }}
                          className="text-kraken-purple text-xs hover:underline">+ Добавить</button>
                      </td></tr>
                    )}
                    {people.map(p => (
                      <tr key={p.id} className="border-b border-kraken-border hover:bg-kraken-hover transition-colors">
                        <td className="px-3 py-1.5">
                          <div className="w-16 h-16 rounded-lg overflow-hidden bg-kraken-hover border border-kraken-border">
                            {p.photo_path
                              ? <img src={`${PHOTO_BASE}/${p.photo_path}`} alt="" className="w-full h-full object-cover" />
                              : <div className="w-full h-full flex items-center justify-center text-lg">👤</div>}
                          </div>
                        </td>
                        <td className="px-3 py-1.5 text-kraken-text text-sm font-medium">{p.name}</td>
                        <td className="px-3 py-1.5"><CategoryBadge category={p.category} /></td>
                        <td className="px-3 py-1.5 text-kraken-muted text-sm max-w-[120px] truncate">{p.comment ?? '—'}</td>
                        <td className="px-3 py-1.5">
                          <div className="flex items-center gap-1 justify-end">
                            <button onClick={() => { setEditPerson(p); setShowAddModal(true) }}
                              className="p-1 rounded hover:bg-kraken-hover text-kraken-muted hover:text-kraken-purple transition-colors"
                              title="Редактировать">
                              <Edit2 size={14} />
                            </button>
                            {selectedCameraId && (
                              <button
                                onClick={() => handleAddPhotoFromCamera(p.id, selectedCameraId)}
                                className="p-1 rounded hover:bg-kraken-hover text-kraken-muted hover:text-kraken-green transition-colors"
                                title="Обновить фото с текущей камеры"
                              >
                                <ImagePlus size={14} />
                              </button>
                            )}
                            <button onClick={() => handleDelete(p.id)}
                              className="p-1 rounded hover:bg-kraken-hover text-kraken-muted hover:text-kraken-red transition-colors"
                              title="Удалить">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-3 py-1.5 border-t border-kraken-border flex items-center justify-between flex-shrink-0">
                <span className="text-kraken-disabled text-[10px]">Всего: {people.length}</span>
                {onNavigatePeople && (
                  <button onClick={onNavigatePeople} className="text-kraken-purple text-[10px] hover:underline">
                    Полная база →
                  </button>
                )}
              </div>
            </div>
          </DraggableBlock>
        )}

        {/* Последние события */}
        {layout.events.visible && (
          <DraggableBlock id="events" state={layout.events} containerRef={containerRef}
            onRectChange={updateRect} onFocus={bringToFront} title="Последние события">
            <div className="h-full flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto">
                <EventsFeed events={recentEvents} maxItems={30} />
              </div>
              <div className="px-3 py-1.5 border-t border-kraken-border flex-shrink-0">
                <button onClick={onNavigateEvents} className="text-kraken-purple text-[10px] hover:underline">
                  Все события →
                </button>
              </div>
            </div>
          </DraggableBlock>
        )}

        {/* Последний гость */}
        {layout.guest.visible && (
          <DraggableBlock id="guest" state={layout.guest} containerRef={containerRef}
            onRectChange={updateRect} onFocus={bringToFront} title="Последний гость">
            <LastGuestBlock
              person={detectedPerson}
              confidence={detectedFace?.confidence}
              cameraName={cameras.find(c => c.id === selectedCameraId)?.name}
              threshold={recognitionThreshold}
              onPhoto={detectedFace?.photo_path ?? null}
            />
          </DraggableBlock>
        )}
      </div>

      {/* Modals */}
      {showAddModal && (
        <QuickPersonModal
          person={editPerson}
          onClose={() => { setShowAddModal(false); setEditPerson(null) }}
          onSaved={() => { setShowAddModal(false); setEditPerson(null); fetchPeople() }}
        />
      )}
      {showRoi && selectedCamera && (
        <RoiEditor
          cameraId={selectedCamera.id}
          cameraName={selectedCamera.name}
          onClose={() => setShowRoi(false)}
        />
      )}

      {confirmState && (
        <ConfirmModal
          isOpen={confirmState.isOpen}
          title={confirmState.title}
          message={confirmState.message}
          isDamage={confirmState.isDamage}
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      )}

      {alertState && (
        <AlertModal
          isOpen={alertState.isOpen}
          title={alertState.title}
          message={alertState.message}
          onClose={() => setAlertState(null)}
        />
      )}
    </div>
  )
}

// ── LastGuestBlock ────────────────────────────────────────────────────────────

function LastGuestBlock({ person, confidence, cameraName, threshold, onPhoto }: {
  person: Person | null
  confidence?: number
  cameraName?: string
  threshold?: number
  onPhoto?: string | null
}) {
  const [loyalty, setLoyalty] = useState<any>(null)
  const [personDetails, setPersonDetails] = useState<Person | null>(null)
  const [categoryAlert, setCategoryAlert] = useState<string | null>(null)
  const prevCategoryRef = useRef<string | null>(null)

  useEffect(() => {
    if (!person?.id) { setLoyalty(null); setPersonDetails(null); setCategoryAlert(null); prevCategoryRef.current = null; return }
    apiFetch<any>(`/loyalty/${person.id}`)
      .then(r => setLoyalty(r.loyalty))
      .catch(() => {})
    apiFetch<Person>(`/persons/${person.id}`)
      .then(p => {
        setPersonDetails(p)
        // Detect category change
        const prevCat = prevCategoryRef.current
        const currCat = p.category
        if (prevCat && prevCat !== currCat) {
          setCategoryAlert(`Категория изменена: ${prevCat} → ${currCat}`)
          setTimeout(() => setCategoryAlert(null), 8000)
        }
        prevCategoryRef.current = currCat
      })
      .catch(() => setPersonDetails(null))
  }, [person?.id])

  const display = personDetails ?? person
  const lastVisit = personDetails?.last_seen_at ?? null
  const visitCount = personDetails?.visit_count ?? person?.visit_count ?? 0

  if (!person) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-kraken-disabled p-4">
        <div className="text-4xl opacity-20">👤</div>
        <div className="text-xs text-center">Ожидание распознавания...</div>
      </div>
    )
  }

  const pct = confidence != null
    ? Math.round(((Math.max(0.28, Math.min(0.85, confidence)) - 0.28) / (0.85 - 0.28)) * 100)
    : null

  const confColor = confidence == null ? '#9AA6B2'
    : confidence >= 0.55 ? '#00FF94'
    : confidence >= 0.38 ? '#FFB800'
    : '#FF3B3B'

  const fmtDT = (iso: string | null | undefined) => {
    if (!iso) return '—'
    const d = new Date(iso)
    return isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })
  }

  return (
    <div className="h-full flex flex-col overflow-y-auto p-3 gap-3">
      {/* Category alert */}
      {categoryAlert && (
        <div className="bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs px-3 py-2 rounded-lg text-center">
          ⚠ {categoryAlert}
        </div>
      )}

      {/* Фото + имя */}
      <div className="flex items-center gap-3">
        <div className="w-24 h-24 rounded-xl overflow-hidden bg-kraken-hover border-2 flex-shrink-0"
          style={{ borderColor: confColor }}>
          {person.photo_path
            ? <img src={`${PHOTO_BASE}/${person.photo_path}`} alt="" className="w-full h-full object-cover" />
            : <div className="w-full h-full flex items-center justify-center text-3xl">👤</div>}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-kraken-text font-bold text-sm truncate">{display?.name ?? person.name}</div>
          <CategoryBadge category={display?.category ?? person.category} />
          {display?.organization && <div className="text-kraken-disabled text-[10px] truncate mt-0.5">{display.organization}</div>}
        </div>
        {pct != null && (
          <div className="flex flex-col items-end flex-shrink-0">
            <span className="text-xl font-black" style={{ color: confColor }}>{pct}%</span>
            <span className="text-kraken-disabled text-[9px]">совпадение</span>
            {threshold != null && (
              <span className="text-[8px] text-kraken-muted">порог: {(threshold * 100).toFixed(0)}%</span>
            )}
          </div>
        )}
      </div>

      {/* До/После фото */}
      {onPhoto && (
        <div className="flex gap-2">
          <div className="flex-1 rounded-lg overflow-hidden bg-kraken-hover border border-kraken-border">
            <div className="text-kraken-disabled text-[9px] text-center py-1 border-b border-kraken-border">Сейчас</div>
            <img 
              src={onPhoto.startsWith('data:image') ? onPhoto : `${PHOTO_BASE}/${onPhoto}`} 
              alt="current" 
              className="w-full h-20 object-cover" 
            />
          </div>
          {person.photo_path && (
            <div className="flex-1 rounded-lg overflow-hidden bg-kraken-hover border border-kraken-border">
              <div className="text-kraken-disabled text-[9px] text-center py-1 border-b border-kraken-border">Профиль</div>
              <img src={`${PHOTO_BASE}/${person.photo_path}`} alt="profile" className="w-full h-20 object-cover" />
            </div>
          )}
        </div>
      )}

      {/* Прогресс совпадения */}
      {pct != null && (
        <div className="h-1 bg-kraken-hover rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: confColor }} />
        </div>
      )}

      {/* Индекс лояльности */}
      {loyalty && (
        <div className="bg-kraken-hover rounded-xl p-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-kraken-disabled text-[10px] uppercase tracking-wider">⭐ Индекс лояльности</span>
            <div className="flex items-center gap-1.5">
              <span className="text-lg font-black" style={{ color: loyalty.label_color }}>{loyalty.score}</span>
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ color: loyalty.label_color, backgroundColor: loyalty.label_color + '20' }}>{loyalty.label}</span>
            </div>
          </div>
          <div className="h-1.5 bg-kraken-base rounded-full overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${loyalty.score}%`, backgroundColor: loyalty.label_color }} />
          </div>
          <div className="grid grid-cols-4 gap-1 mt-2 text-[10px]">
            <div className="text-center"><div className="text-kraken-disabled">Акт.</div><div className="text-kraken-green font-bold">+{loyalty.activity}</div></div>
            <div className="text-center"><div className="text-kraken-disabled">Реп.</div><div className="text-kraken-blue font-bold">+{loyalty.reputation}</div></div>
            <div className="text-center"><div className="text-kraken-disabled">Риск</div><div className={loyalty.risk > 0 ? 'text-kraken-red font-bold' : 'text-kraken-disabled'}>{loyalty.risk > 0 ? `−${loyalty.risk}` : '0'}</div></div>
            <div className="text-center"><div className="text-kraken-disabled">Восст.</div><div className="text-amber-400 font-bold">+{loyalty.recovery}</div></div>
          </div>
        </div>
      )}

      {/* Информация о визите */}
      <div className="flex flex-col gap-1.5 text-[11px]">
        {cameraName && (
          <div className="flex items-center gap-2">
            <span className="text-kraken-disabled w-20 flex-shrink-0">📷 Камера:</span>
            <span className="text-kraken-text font-medium">{cameraName}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-kraken-disabled w-20 flex-shrink-0">👁 Визитов:</span>
          <span className="text-kraken-text font-bold">{visitCount}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-kraken-disabled w-20 flex-shrink-0">🕐 Последний:</span>
          <span className="text-kraken-text">{fmtDT(lastVisit)}</span>
        </div>
        {person.phone && (
          <div className="flex items-center gap-2">
            <span className="text-kraken-disabled w-20 flex-shrink-0">📞 Тел.:</span>
            <a href={`tel:${person.phone}`} className="text-kraken-blue hover:underline">{person.phone}</a>
          </div>
        )}
        {person.comment && (
          <div className="flex items-start gap-2">
            <span className="text-kraken-disabled w-20 flex-shrink-0 pt-0.5">📝 Заметка:</span>
            <span className="text-kraken-muted italic">{person.comment}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Person Modal — мультифото + камера ───────────────────────────────────────

interface ModalProps { person: Person | null; onClose: () => void; onSaved: () => void }

type PhotoTab = 'upload' | 'camera'
interface PhotoEntry { file: File; preview: string }

// Мини-превью с живой камеры для снимка
function LiveCameraPreview({ cameraId }: { cameraId: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [connected, setConnected] = useState(false)
  const decodingRef = useRef(false)

  useEffect(() => {
    const ws = new WebSocket(wsUrl(`/ws/camera/${cameraId}`))
    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    let lastFrameTime = 0
    ws.onmessage = (e) => {
      if (decodingRef.current) return
      const now = Date.now()
      if (now - lastFrameTime < 80) return
      lastFrameTime = now
      try {
        const msg = JSON.parse(e.data as string)
        if (msg.type !== 'FRAME' || !msg.frame) return
        const binStr = atob(msg.frame as string)
        const arr = new Uint8Array(binStr.length)
        for (let i = 0; i < binStr.length; i++) arr[i] = binStr.charCodeAt(i)
        decodingRef.current = true
        createImageBitmap(new Blob([arr.buffer as ArrayBuffer], { type: 'image/jpeg' }))
          .then(bitmap => {
            const canvas = canvasRef.current
            if (canvas) {
              const ctx = canvas.getContext('2d', { alpha: false })
              if (ctx) {
                if (canvas.width !== bitmap.width) canvas.width = bitmap.width
                if (canvas.height !== bitmap.height) canvas.height = bitmap.height
                ctx.drawImage(bitmap, 0, 0)
              }
            }
            bitmap.close()
          }).catch(() => {}).finally(() => { decodingRef.current = false })
      } catch {}
    }
    const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping') }, 5000)
    return () => { clearInterval(ping); ws.close(); decodingRef.current = false }
  }, [cameraId])

  return (
    <div className="relative w-full rounded-lg overflow-hidden bg-kraken-base border border-kraken-border" style={{ aspectRatio: '4/3' }}>
      <canvas ref={canvasRef} className="w-full h-full object-cover" style={{ display: connected ? 'block' : 'none' }} />
      {!connected && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
          <CameraIcon size={24} className="text-kraken-disabled opacity-40" />
          <span className="text-kraken-disabled text-xs">Подключение...</span>
        </div>
      )}
      {connected && (
        <div className="absolute top-1.5 left-1.5 flex items-center gap-1 bg-black/50 px-1.5 py-0.5 rounded text-[10px]">
          <span className="w-1.5 h-1.5 rounded-full bg-kraken-green animate-pulse" />
          <span className="text-kraken-green font-bold">LIVE</span>
        </div>
      )}
    </div>
  )
}

function QuickPersonModal({ person, onClose, onSaved }: ModalProps) {
  const [name, setName]         = useState(person?.name ?? '')
  const [category, setCategory] = useState<Category>(person?.category ?? 'CLIENT')
  const [comment, setComment]   = useState(person?.comment ?? '')
  const [phone, setPhone]       = useState(person?.phone ?? '')
  const [email, setEmail]       = useState(person?.email ?? '')
  const [birthDate, setBirthDate] = useState(person?.birth_date ?? '')
  const [address, setAddress]   = useState(person?.address ?? '')
  const [organization, setOrganization] = useState(person?.organization ?? '')
  const [extraInfo, setExtraInfo] = useState(person?.extra_info ?? '')
  const [photos, setPhotos]     = useState<PhotoEntry[]>([])
  const [photoTab, setPhotoTab] = useState<PhotoTab>('upload')
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState('')

  // Камера для снимка
  const [camList, setCamList]       = useState<Camera[]>([])
  const [selectedCamId, setSelectedCamId] = useState<number | null>(null)
  const [snapping, setSnapping]     = useState(false)
  const [snapError, setSnapError]   = useState('')

  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (photoTab === 'camera') {
      apiFetch<Camera[]>('/cameras/').then(data => {
        const online = data.filter(c => c.status === 'online' || c.is_active)
        setCamList(online)
        if (online.length > 0) setSelectedCamId(online[0].id)
      }).catch(() => {})
    }
  }, [photoTab])

  const addFiles = (files: FileList | null) => {
    if (!files) return
    Array.from(files).forEach(file => {
      const reader = new FileReader()
      reader.onload = e => setPhotos(prev => [...prev, { file, preview: e.target?.result as string }])
      reader.readAsDataURL(file)
      if (!name.trim()) {
        const auto = file.name.replace(/\.[^/.]+$/, '').replace(/[_\-]+/g, ' ').trim()
        if (auto) setName(auto)
      }
    })
  }

  const removePhoto = (idx: number) => setPhotos(prev => prev.filter((_, i) => i !== idx))

  const handleSnapshot = async () => {
    if (!selectedCamId) return
    setSnapping(true); setSnapError('')
    try {
      const res = await apiFetch<{ image: string; content_type: string }>(`/cameras/${selectedCamId}/snapshot`)
      const byteStr = atob(res.image)
      const arr = new Uint8Array(byteStr.length)
      for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i)
      const file = new File([arr], `snap_${Date.now()}.jpg`, { type: 'image/jpeg' })
      setPhotos(prev => [...prev, { file, preview: `data:${res.content_type};base64,${res.image}` }])
      if (!name.trim()) {
        const cam = camList.find(c => c.id === selectedCamId)
        if (cam) setName(cam.name)
      }
    } catch (e: any) { setSnapError(e.message) }
    finally { setSnapping(false) }
  }

  const handleSave = async () => {
    const finalName = name.trim() || (photos.length > 0
      ? photos[0].file.name.replace(/\.[^/.]+$/, '').replace(/[_\-]+/g, ' ').trim() : '')
    if (!finalName) { setError('Введите имя или добавьте фото'); return }
    setSaving(true); setError('')
    const extraData = {
      name: finalName, category,
      comment: comment || null,
      phone: phone || null,
      email: email || null,
      birth_date: birthDate || null,
      address: address || null,
      organization: organization || null,
      extra_info: extraInfo || null,
    }
    try {
      if (person) {
        await apiFetch(`/persons/${person.id}`, { method: 'PUT', body: JSON.stringify(extraData) })
        if (photos.length > 0) {
          const fd = new FormData()
          photos.forEach(p => fd.append('photos', p.file))
          await apiUpload(`/persons/${person.id}/photos`, fd)
        }
      } else {
        const fd = new FormData()
        Object.entries(extraData).forEach(([k, v]) => { if (v != null) fd.append(k, String(v)) })
        photos.forEach(p => fd.append('photos', p.file))
        await apiUpload('/persons/', fd)
      }
      onSaved()
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70">
      <div className="panel p-5 w-full max-w-lg mx-4 animate-fade-in max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-kraken-text font-bold">{person ? 'Редактировать' : 'Добавить человека'}</h2>
          <button onClick={onClose} className="text-kraken-muted hover:text-kraken-text"><X size={16} /></button>
        </div>

        <div className="flex flex-col gap-4">
          {/* Имя */}
          <div>
            <label className="text-kraken-muted text-xs mb-1 block">
              Имя <span className="text-kraken-disabled">(можно оставить — возьмётся из имени файла)</span>
            </label>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="Подставится из имени файла автоматически"
              className="w-full bg-kraken-hover border border-kraken-border text-kraken-text text-sm px-3 py-2 rounded-lg focus:outline-none focus:border-kraken-purple" />
          </div>

          {/* Категория */}
          <div>
            <label className="text-kraken-muted text-xs mb-1 block">Категория</label>
            <select value={category} onChange={e => setCategory(e.target.value as Category)}
              className="w-full bg-kraken-hover border border-kraken-border text-kraken-text text-sm px-3 py-2 rounded-lg focus:outline-none focus:border-kraken-purple">
              {CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
            </select>
          </div>

          {/* Комментарий */}
          <div>
            <label className="text-kraken-muted text-xs mb-1 block">Комментарий (только для охраны)</label>
            <input type="text" value={comment} onChange={e => setComment(e.target.value)}
              placeholder="Заметки видны только охране..."
              className="w-full bg-kraken-hover border border-kraken-border text-kraken-text text-sm px-3 py-2 rounded-lg focus:outline-none focus:border-kraken-purple" />
          </div>

          {/* Расширенная информация — всегда видима */}
          <div className="border-t border-kraken-border pt-3">
            <div className="text-kraken-disabled text-[10px] uppercase tracking-widest mb-3">Контактная информация</div>
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-kraken-muted text-xs mb-1 block">📞 Телефон</label>
                  <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
                    placeholder="+7 (999) 000-00-00"
                    className="w-full bg-kraken-hover border border-kraken-border text-kraken-text text-sm px-3 py-2 rounded-lg focus:outline-none focus:border-kraken-purple" />
                </div>
                <div>
                  <label className="text-kraken-muted text-xs mb-1 block">✉️ Email</label>
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                    placeholder="example@mail.com"
                    className="w-full bg-kraken-hover border border-kraken-border text-kraken-text text-sm px-3 py-2 rounded-lg focus:outline-none focus:border-kraken-purple" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-kraken-muted text-xs mb-1 block">🎂 Дата рождения</label>
                  <input type="text" value={birthDate} onChange={e => setBirthDate(e.target.value)}
                    placeholder="ДД.ММ.ГГГГ"
                    className="w-full bg-kraken-hover border border-kraken-border text-kraken-text text-sm px-3 py-2 rounded-lg focus:outline-none focus:border-kraken-purple" />
                </div>
                <div>
                  <label className="text-kraken-muted text-xs mb-1 block">🏢 Организация</label>
                  <input type="text" value={organization} onChange={e => setOrganization(e.target.value)}
                    placeholder="Компания / должность"
                    className="w-full bg-kraken-hover border border-kraken-border text-kraken-text text-sm px-3 py-2 rounded-lg focus:outline-none focus:border-kraken-purple" />
                </div>
              </div>
              <div>
                <label className="text-kraken-muted text-xs mb-1 block">📍 Адрес</label>
                <input type="text" value={address} onChange={e => setAddress(e.target.value)}
                  placeholder="Город, улица, дом"
                  className="w-full bg-kraken-hover border border-kraken-border text-kraken-text text-sm px-3 py-2 rounded-lg focus:outline-none focus:border-kraken-purple" />
              </div>
              <div>
                <label className="text-kraken-muted text-xs mb-1 block">📝 Доп. информация</label>
                <textarea value={extraInfo} onChange={e => setExtraInfo(e.target.value)}
                  placeholder="Любая дополнительная информация..."
                  rows={2}
                  className="w-full bg-kraken-hover border border-kraken-border text-kraken-text text-sm px-3 py-2 rounded-lg focus:outline-none focus:border-kraken-purple resize-none" />
              </div>
            </div>
          </div>

          {/* Фото */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-kraken-muted text-xs">
                Фото <span className="text-kraken-disabled">(несколько — точнее распознавание)</span>
              </label>
              {photos.length > 0 && (
                <span className="text-kraken-green text-xs font-bold">{photos.length} фото</span>
              )}
            </div>

            {/* Табы */}
            <div className="flex gap-1 mb-3 bg-kraken-base rounded-lg p-1">
              <button onClick={() => setPhotoTab('upload')}
                className={`flex-1 flex items-center justify-center gap-1.5 text-xs py-1.5 rounded-md transition-colors ${
                  photoTab === 'upload' ? 'bg-kraken-panel text-kraken-text' : 'text-kraken-muted hover:text-kraken-text'
                }`}>
                <Upload size={12} /> Загрузить файлы
              </button>
              <button onClick={() => setPhotoTab('camera')}
                className={`flex-1 flex items-center justify-center gap-1.5 text-xs py-1.5 rounded-md transition-colors ${
                  photoTab === 'camera' ? 'bg-kraken-panel text-kraken-text' : 'text-kraken-muted hover:text-kraken-text'
                }`}>
                <CameraIcon size={12} /> Сфотографировать
              </button>
            </div>

            {/* Загрузка файлов */}
            {photoTab === 'upload' && (
              <>
                <label className="border border-dashed border-kraken-border rounded-lg p-3 text-center cursor-pointer hover:border-kraken-purple transition-colors mb-2 block">
                  <div className="flex items-center justify-center gap-2 text-kraken-muted text-sm">
                    <ImagePlus size={15} /> Нажмите для выбора (можно несколько)
                  </div>
                  <div className="text-kraken-disabled text-xs mt-0.5">JPG, PNG, WEBP</div>
                  <input type="file" accept="image/*" multiple className="hidden"
                    onChange={e => addFiles(e.target.files)} />
                </label>
              </>
            )}

            {/* Камера */}
            {photoTab === 'camera' && (
              <div className="flex flex-col gap-2 mb-2">
                {camList.length === 0 ? (
                  <div className="text-kraken-disabled text-sm text-center py-3 border border-kraken-border rounded-lg">
                    Нет активных камер
                  </div>
                ) : (
                  <>
                    {camList.length > 1 && (
                      <select value={selectedCamId ?? ''} onChange={e => setSelectedCamId(Number(e.target.value))}
                        className="w-full bg-kraken-hover border border-kraken-border text-kraken-text text-sm px-3 py-2 rounded-lg focus:outline-none focus:border-kraken-purple">
                        {camList.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    )}
                    {selectedCamId && <LiveCameraPreview cameraId={selectedCamId} />}
                    <button onClick={handleSnapshot} disabled={snapping || !selectedCamId}
                      className="w-full flex items-center justify-center gap-2 bg-kraken-purple hover:bg-kraken-purple-hover text-white py-2.5 rounded-lg font-bold text-sm transition-colors disabled:opacity-50">
                      {snapping
                        ? <><RefreshCw size={14} className="animate-spin" /> Снимаем...</>
                        : <><CameraIcon size={14} /> Сделать снимок</>}
                    </button>
                    {snapError && <div className="text-kraken-red text-xs">{snapError}</div>}
                  </>
                )}
              </div>
            )}

            {/* Превью фото */}
            {photos.length > 0 && (
              <div className="grid grid-cols-4 gap-2 mt-2">
                {photos.map((p, i) => (
                  <div key={i} className="relative group">
                    <img src={p.preview} alt=""
                      className={`w-full aspect-square object-cover rounded-lg border-2 ${
                        i === 0 ? 'border-kraken-green' : 'border-kraken-border'
                      }`} />
                    {i === 0 && (
                      <div className="absolute bottom-0 left-0 right-0 bg-kraken-green/80 text-black text-[9px] text-center font-bold rounded-b-lg py-0.5">
                        ГЛАВНОЕ
                      </div>
                    )}
                    <button onClick={() => removePhoto(i)}
                      className="absolute top-1 right-1 bg-black/70 rounded-full p-0.5 text-white opacity-0 group-hover:opacity-100 transition-opacity">
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {photos.length === 0 && (
              <p className="text-kraken-disabled text-xs text-center py-1">
                Без фото человек не будет распознаваться
              </p>
            )}
          </div>

          {error && <div className="text-kraken-red text-sm">{error}</div>}

          <div className="flex gap-3">
            <button onClick={onClose} className="btn-ghost flex-1 text-sm py-2">Отмена</button>
            <button onClick={handleSave} disabled={saving} className="btn-primary flex-1 text-sm py-2">
              {saving ? 'Сохранение...' : person ? 'Сохранить' : `Добавить${photos.length > 0 ? ` (${photos.length} фото)` : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
