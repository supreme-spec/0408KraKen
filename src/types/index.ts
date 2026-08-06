export type Category = string  // динамические категории из БД

export interface PersonCategory {
  code: string
  label: string
  color: string
  bg_color: string
  is_alert: boolean
  alert_sound: string
  alert_volume: number
  detect_enabled: boolean
  sort_order: number
  is_system: boolean
  card_template_json?: string | null
}

export interface PersonPhoto {
  id: number
  photo_path: string
  is_primary: boolean
  created_at: string
}

export interface Person {
  id: number
  name: string
  category: Category
  position?: string | null
  comment?: string | null
  phone?: string | null
  email?: string | null
  birth_date?: string | null
  address?: string | null
  organization?: string | null
  extra_info?: string | null
  photo_path?: string | null
  photos: PersonPhoto[]
  is_active: boolean
  created_at: string
  last_seen_at?: string | null
  visit_count: number
  embedding_count: number
  loyalty_index?: number | null
  total_visits?: number | null
  vip_level?: string | null
  custom_fields_json?: string | null
}

export interface RoiZone {
  x1: number
  y1: number
  x2: number
  y2: number
  label: string
  type?: 'detection' | 'exclusion'
  detector?: string
  det_size?: number
  min_face_size?: number
  min_det_score?: number
}

export interface Camera {
  id: number
  name: string
  source: string
  camera_type: 'USB' | 'RTSP' | 'IP' | 'ONVIF' | 'Hikvision' | 'UNV'
  zone?: string
  is_active: boolean
  created_at: string
  status: 'online' | 'offline' | 'connecting' | 'reconnecting'
  roi_zones?: RoiZone[] | null
  fps?: number | null
  ping_ms?: number | null
  is_smart_recording: boolean
  is_chronicle: boolean
  driver_type?: string | null
  ip_address?: string | null
  ip_port?: number | null
  username?: string | null
  password?: string | null
  use_camera_analytics?: boolean
  enabled_modules?: string | null
  motion_threshold?: number | null
  motion_zones?: string | null
  lpr_enabled?: boolean
  lpr_regions?: string | null
  exclusion_zones?: string | null
  webhookSecret?: string | null
  vendor?: string | null
  model_name?: string | null
  firmware?: string | null
  serial_number?: string | null
  mac_address?: string | null
  onvif_supported?: boolean
  probe_source?: string | null
  probe_updated_at?: string | null
  data_confidence?: string | null
  last_verified_at?: string | null
   stream_profiles?: string | null
   ai_stream_profile_id?: string | null
}

export interface KrakenEvent {
  id: number
  camera_id?: number
  camera_name?: string
  person_id?: number
  event_type: 'RECOGNIZED' | 'UNKNOWN' | 'BLACKLIST_ALERT' | 'VIP_ARRIVAL' | 'RESPONSE_ALERT'
  confidence?: number
  threshold?: number
  snapshot_path?: string | null
  person_name?: string
  person_category?: Category
  person_photo_path?: string   // registered photo from DB
  created_at: string
  needs_operator_confirmation?: boolean
  confirmation_status?: 'pending' | 'confirmed' | 'rejected'
  confirmation_id?: number
}

export interface FaceDetection {
  track_id: number
  bbox: [number, number, number, number]
  person_id?: number
  person_name?: string
  category?: Category
  confidence?: number
  comment?: string
  photo_path?: string
}

export interface FrameMessage {
  type: 'FRAME'
  camera_id: number
  timestamp: number
  frame: string  // base64 JPEG
  faces: FaceDetection[]
}

export interface AlertMessage {
  type: 'ALERT'
  eventId?: number | null
  category: 'BLACKLIST' | 'VIP' | 'RESPONSE' | 'SECURITY' | 'NOT_TODAY' | 'SUITE' | 'CLIENT' | 'STAFF'
  categoryCode?: string
  level?: 'critical' | 'warning' | 'info'
  person_id: number
  person_name: string
  camera_id: number
  doorName?: string
  confidence: number
  threshold?: number
  snapshot_path?: string
  photo_path?: string
  message?: string
  timestamp: string
  at?: string
}

/**
 * «Серая зона» (Human-in-the-Loop): бэкенд прислал кандидата из базы с
 * уверенностью в диапазоне low_threshold..confirmation_threshold. Оператор
 * должен подтвердить (Да/Нет) прямо в живом UI. Соответствует WS-сообщению
 * `{ type: "CONFIRMATION", ... }` из server.ts (handleConfirmationEvent).
 */
export interface ConfirmationMessage {
  type: 'CONFIRMATION'
  confirmation_id: number
  person_id: number
  person_name: string
  category: string
  confidence: number
  camera_id?: number
  temp_photo: string      // захваченный кадр (новое фото лица) — `/confirmations/...jpg`
  existing_photo: string | null  // фото из базы (зарегистрированное) — `/photos/...jpg`
  timestamp?: string
}

export interface PersonVisit {
  id: number
  person_id: number
  camera_id?: number | null
  camera_name?: string | null
  confidence?: number | null
  visit_date: string
  source: string
  created_at: string
}

export interface CategoryTemplateSection {
  key: string
  label: string
  icon?: string
  type: string
}

export interface CategoryTemplateField {
  key: string
  label: string
  type: 'text' | 'number' | 'select' | 'textarea' | 'date' | 'bool'
  group: string
  readonly?: boolean
  options?: string[]
}

export interface CategoryCardTemplate {
  sections: CategoryTemplateSection[]
  fields: CategoryTemplateField[]
}
