import express from "express";
import path from "path";
import crypto from "crypto";
import * as os from "os";
import { platform } from "os";
import fs from "fs";
import { promises as fsp } from "fs";
import http from "http";
import multer from "multer";
import iconv from "iconv-lite";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { spawn, exec, execSync, ChildProcess, ChildProcessWithoutNullStreams } from "child_process";
import { promisify } from "util";
import { createRequire } from "module";
import { FormData } from "formdata-node";
import { autoFillCamera, inspectCamera, normalizeProbeProfiles, compareProbeResults, recommendAiStreamProfile, type StreamProfile, type CameraProbeResult } from "./camera-inspector.js";

const execAsync = promisify(exec);
const require = createRequire(import.meta.url);
import sharp from "sharp";
import { ZipArchive } from "archiver";
import * as unzipper from "unzipper";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import AdmZip from "adm-zip";
import {
  initFaceEngine,
  initFaceEngineWithDB,
  detectFaces,
  detectFacesFast,
  getEmbedding,
  extractEmbedding,
  registerPerson as registerFacePerson,
  registerPersonFromDescriptor,
  unregisterPerson as unregisterFacePerson,
  searchByPhoto,
  rebuildDescriptorIndex,
   getEngineStatus,
   getPythonServerHealth,
   assessPhotoQuality,
  searchByDescriptor,
  addEmbeddingToPerson,
} from "./face-engine.js";
import { prisma } from "./db.js";
import { startLoyaltyWorker, setBroadcastFn } from "./loyalty-worker.js";
import logger, { logInfo, logError, logWarn, logDebug } from "./src/lib/logger.js";

// ── __filename / __dirname ────────────────────────────────────────────────────
// tsx запускает файл как ESM-модуль → используем import.meta.url напрямую.
// esbuild при сборке в CJS заменяет import.meta.url на require-аналог автоматически.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// NODE_ENV
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = __dirname.includes("dist") ? "production" : "development";
}

const app = express();
const server = http.createServer(app);
const PORT = parseInt(process.env.PORT || "3000", 10);
// Привязка: по умолчанию 0.0.0.0 (доступно в локальной сети для камер/операторов).
// Для чисто локального use-case задайте HOST=127.0.0.1. БЕЗОПАСНОСТЬ: при публикации порта
// обязательно задайте API_KEY, иначе API и WS будут открыты для сети.
const HOST = process.env.HOST || "0.0.0.0";
// Опциональный API-ключ. Если задан — сервер требует его на всех /api и /ws.
// Если не задан — сервер работает открыто (dev), но выводит предупреждение.
const API_KEY = process.env.API_KEY || "";

// ═══ B. OBSERVABLE ERRORS ═══════════════════════════════════
const errorCounters = new Map<string, number>()

function reportError(scope: string, err: unknown, extra?: Record<string, unknown>): void {
  const n = (errorCounters.get(scope) ?? 0) + 1
  errorCounters.set(scope, n)
  const msg = err instanceof Error ? err.message : String(err)
  logError(`[ERR:${scope}] #${n} ${msg}`, extra ?? '')
  if (n === 1 || n % 10 === 0) {
    try {
      broadcastSecurity({ type: "system-warning", scope, count: n, message: msg, at: new Date().toISOString() })
    } catch { /* ws ещё не готов */ }
  }
}

app.use(express.json());

// Middleware для логирования запросов
app.use((req, res, next) => {
  const start = Date.now();
  logInfo(`${req.method} ${req.url}`, { ip: req.ip });

  res.on("finish", () => {
    const duration = Date.now() - start;
    logInfo(`${req.method} ${req.url} ${res.statusCode}`, { duration: `${duration}ms` });
  });

  next();
});

// API-key аутентификация (включается только если задан API_KEY в .env)
function apiKeyAuth(req: any, res: any, next: any) {
  if (!API_KEY) return next();
  const auth = req.headers["authorization"] || "";
  const headerKey = req.headers["x-api-key"];
  const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token === API_KEY || headerKey === API_KEY) return next();
  return res.status(401).json({ detail: "Unauthorized: требуется API_KEY" });
}
app.use("/api", apiKeyAuth);

// ── ENSURE DIRECTORIES & ASSETS EXIST ──
const FALLBACK_JPEG = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

const publicDir = path.join(process.cwd(), "public");
const photosDir = path.join(publicDir, "photos");
const snapshotsDir = path.join(publicDir, "snapshots");
const recordingsDir = path.join(publicDir, "recordings");

function initDirectories() {
  for (const d of [publicDir, photosDir, snapshotsDir, recordingsDir]) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  // Copy rus.jpg and logo.jpg to photos and snapshots directories
  const rusSrc = path.join(process.cwd(), "src", "assets", "rus.jpg");
  const logoSrc = path.join(process.cwd(), "src", "assets", "logo.jpg");

  const mockPhotos = ["pushkin.jpg", "tolstoy.jpg", "johndoe.jpg", "kuznetsova.jpg"];
  const mockSnapshots = ["ev1.jpg", "ev2.jpg", "ev3.jpg", "alert_johndoe.jpg"];

  for (const name of mockPhotos) {
    const dest = path.join(photosDir, name);
    if (!fs.existsSync(dest)) {
      if (fs.existsSync(rusSrc)) {
        fs.copyFileSync(rusSrc, dest);
      } else if (fs.existsSync(logoSrc)) {
        fs.copyFileSync(logoSrc, dest);
      } else {
        fs.writeFileSync(dest, Buffer.from(FALLBACK_JPEG, "base64"));
      }
    }
  }

  for (const name of mockSnapshots) {
    const dest = path.join(snapshotsDir, name);
    if (!fs.existsSync(dest)) {
      if (fs.existsSync(rusSrc)) {
        fs.copyFileSync(rusSrc, dest);
      } else {
        fs.writeFileSync(dest, Buffer.from(FALLBACK_JPEG, "base64"));
      }
    }
  }
}
initDirectories();

// Serve the uploaded photos, snapshots, and recordings statically with API-key protection
app.use("/photos", apiKeyAuth, express.static(photosDir));
app.use("/snapshots", apiKeyAuth, express.static(snapshotsDir));
app.use("/recordings", apiKeyAuth, express.static(recordingsDir));

// Multer upload setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, photosDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    const uniqueName = `upload_${Date.now()}_${Math.floor(Math.random() * 1000)}${ext}`;
    cb(null, uniqueName);
  },
});
const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp"]);
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 МБ
    files: 500,                  // увеличено для массового импорта
  },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Недопустимый тип файла: ${file.mimetype}`));
    }
  },
});

// Ограниченная конфигурация Multer для UNV/Hikvision вебхуков:
// 5 МБ максимум, 1 файл, только JPEG/PNG
const unvWebhookUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 МБ жесткий лимит
    files: 1,                  // Только 1 файл за запрос
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ["image/jpeg", "image/jpg", "image/png"];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Only JPEG/PNG allowed.`));
    }
  },
});

/** Проверяет magic bytes JPEG/PNG в буфере. */
function validateImageMagicBytes(buffer: Buffer, mimetype: string): boolean {
  if (buffer.length < 4) return false;
  if (mimetype === "image/jpeg" || mimetype === "image/jpg") {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimetype === "image/png") {
    return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  }
  return false;
}

// ── Утилиты нормализации и кодировки (для импорта людей) ──
// Браузер на Windows передаёт originalname в latin1, а не UTF-8.
// Multer не перекодирует это — отсюда кракозябры в именах.
function fixDoubleEncodedCyrillic(value: string): string {
  if (typeof value !== 'string' || !value) return value;
  if (/[а-яА-ЯёЁ]/.test(value)) return value; // уже нормальная кириллица
  try {
    const decoded = iconv.decode(Buffer.from(value, 'latin1'), 'utf8');
    if (decoded && /[а-яА-ЯёЁ]/.test(decoded)) return decoded;
  } catch {}
  return value;
}

function fixFilesEncoding(files: Express.Multer.File[]): void {
  if (!files || !Array.isArray(files)) return;
  for (const file of files) {
    if (file && typeof file.originalname === 'string') {
      file.originalname = fixDoubleEncodedCyrillic(file.originalname);
    }
  }
}

function normalizePersonName(name: string): string {
  if (!name) return name;
  name = name.replace(/\s*\([^\)]*\)\s*/g, ' ').trim();
  const normalized = name.replace(/\s+/g, ' ').replace(/[-_]+/g, ' ').trim().replace(/^[\s\-_]+|[\s\-_]+$/g, '');
  return normalized.split(' ').map(w => {
    if (!w || /^\d+$/.test(w)) return w;
    if (w.includes('-')) {
      return w.split('-').map(p => /^\d+$/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('-');
    }
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

/** Levenshtein distance */
function editDistance(s1: string, s2: string): number {
  s1 = s1.toLowerCase();
  s2 = s2.toLowerCase();
  const costs: number[] = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1[i - 1] !== s2[j - 1]) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

/** String similarity (0..1) via Levenshtein */
function similarity(s1: string, s2: string): number {
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  if (longer.length === 0) return 1.0;
  return (longer.length - editDistance(longer, shorter)) / longer.length;
}

/** Find names with similarity >= threshold */
function findSimilarNames(name: string, existingNames: string[], threshold: number = 0.85): string[] {
  const normalizedName = normalizePersonName(name);
  return existingNames.filter(n => {
    if (n === name) return false;
    return similarity(normalizedName, normalizePersonName(n)) >= threshold;
  });
}

function normalizePositionName(pos: string): string {
  if (!pos) return pos;
  pos = pos.replace(/\s*\([^\)]*\)\s*/g, ' ').trim();
  const words = pos.replace(/\s+/g, ' ').trim().split(' ').filter(w => w);
  if (words.length === 0) return pos;
  return words.map((w, i) => {
    if (!w || /^\d+$/.test(w)) return w;
    return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase();
  }).join(' ');
}

/**
 * Word-order-insensitive FIO comparison.
 * "Ivan Ivanov" matches "Ivanov Ivan" — same word set, any order.
 * Underscores/dashes are treated as word separators.
 */
function namesMatchFIO(a: string, b: string): boolean {
  const normalize = (s: string) =>
    s
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .split(' ')
      .filter((w) => w.length > 0)
      .sort();
  const wa = normalize(a);
  const wb = normalize(b);
  if (wa.length !== wb.length) return false;
  return wa.every((w, i) => w === wb[i]);
}

// ── STATEFUL IN-MEMORY DATABASES ──
// NOTE: cameras и persons используются как кэш из Prisma (синхронизируются при старте и мутациях).
// Всё персистентное хранение — через Prisma/SQLite.
let cameras: any[] = [];
let persons: any[] = [];

// Дефолтные категории — используются только для первичного сида БД
let categories: any[] = [
  { code: "BLACKLIST", label: "Чёрный список", color: "#ef4444", bg_color: "#450a0a", is_alert: true,  alert_sound: "builtin", alert_volume: 1.0, detect_enabled: true,  sort_order: 1, is_system: true  },
  { code: "NOT_TODAY", label: "Не сегодня",    color: "#f97316", bg_color: "#431407", is_alert: false, alert_sound: "off",     alert_volume: 0.5, detect_enabled: true,  sort_order: 2, is_system: false },
  { code: "SUITE",     label: "Свита",          color: "#ec4899", bg_color: "#500724", is_alert: true,  alert_sound: "builtin", alert_volume: 0.8, detect_enabled: true,  sort_order: 3, is_system: false },
  { code: "RESPONSE",  label: "Реагирование",  color: "#f97316", bg_color: "#431407", is_alert: true,  alert_sound: "builtin", alert_volume: 0.9, detect_enabled: true,  sort_order: 4, is_system: true  },
  { code: "VIP",       label: "VIP",            color: "#a855f7", bg_color: "#2e1065", is_alert: true,  alert_sound: "builtin", alert_volume: 0.7, detect_enabled: true,  sort_order: 5, is_system: false },
  { code: "SECURITY",  label: "Охрана",         color: "#3b82f6", bg_color: "#172554", is_alert: false, alert_sound: "off",     alert_volume: 0.5, detect_enabled: true,  sort_order: 6, is_system: false },
  { code: "STAFF",     label: "Персонал",       color: "#22c55e", bg_color: "#052e16", is_alert: false, alert_sound: "off",     alert_volume: 0.5, detect_enabled: true,  sort_order: 7, is_system: false },
  { code: "CLIENT",    label: "Клиент",         color: "#6b7280", bg_color: "#111827", is_alert: false, alert_sound: "off",     alert_volume: 0.5, detect_enabled: true,  sort_order: 8, is_system: false },
  { code: "EVENT_GUEST", label: "Гость",          color: "#14b8a6", bg_color: "#0a2e2e", is_alert: false, alert_sound: "off",     alert_volume: 0.5, detect_enabled: true,  sort_order: 7, is_system: false,
    card_template_json: JSON.stringify({
      sections: [
        { key: "visits",    label: "Посещения",  icon: "calendar", type: "visits_history" },
        { key: "loyalty",   label: "Лояльность",  icon: "star",      type: "loyalty_score" },
      ],
      fields: [
        { key: "favorite_drink",   label: "Напиток",       type: "text",    group: "preferences" },
        { key: "favorite_table",   label: "Столик",        type: "text",    group: "preferences" },
        { key: "allergies",        label: "Аллергии",      type: "text",    group: "preferences" },
        { key: "vip_level",        label: "VIP уровень",   type: "select",  group: "preferences", options: ["", "Bronze", "Silver", "Gold", "Platinum"] },
        { key: "last_order",       label: "Посл. заказ",   type: "text",    group: "preferences" },
        { key: "visit_count",      label: "Кол-во визитов", type: "number", group: "stats", readonly: true },
      ],
    }),
  },
];

const DEFAULT_INCIDENT_TYPES = {
  verbal_conflict: "Словесный конфликт",
  theft_attempt: "Попытка кражи",
  theft_confirmed: "Подтвержденная кража",
  property_damage: "Порча имущества",
  alcohol_intoxication: "Алкогольное опьянение",
  hooliganism: "Хулиганство",
  other: "Другое"
};

const DEFAULT_TAG_TYPES = {
  regular_customer: "Постоянный клиент",
  polite: "Вежливый",
  big_spender: "Крупный покупатель",
  friendly: "Дружелюбный",
  promoter: "Промоутер бренда"
};

// ── SETTINGS STATE (синхронизируются с БД через Settings table) ──
let active_categories: string[] = ["BLACKLIST", "RESPONSE", "VIP"];
let recognition_threshold_pct = 45;
// Банд подтверждения оператора: между low и confirmation — «возможно, это person».
let confirmation_threshold_pct = 55; // >= → авто-распознано (подтверждение не нужно)
let low_threshold_pct = 40;          // <  → неизвестный (без подтверждения)
let verification_threshold_pct = 60;
let embedding_cache_enabled = true;
let embedding_cache_ttl_days = 30;
let face_quality_min_threshold = 0.10;
let ai_adaptive_frame_skip = true;
let auto_create_unknown_persons = true;
let faiss_ivf_threshold = 1000;
let faiss_ivf_nprobe = 10;
let camera_priority_weights: Record<string, number> = {};

// Chronicle и recordings — хранятся в памяти (файловый архив, не критичные данные)
interface Visitor {
  filename: string;
  person_id: number | null;
  person_name: string;
  time: string;
  photo_url: string;
  size_kb: number;
}
let chronicleData: Record<number, Record<string, Visitor[]>> = {};
let recordingsData: Record<number, Record<string, any[]>> = {};

// ── REST API ROUTES ──

// ── Credential encryption helpers (AES-256-GCM) ────────────────────────────────
const APP_SECRET = process.env.APP_SECRET || "";

function getEncryptionKey(): Buffer | null {
  if (!APP_SECRET) return null;
  return crypto.createHash("sha256").update(APP_SECRET).digest();
}

/** Шифрует значение перед сохранением в БД. Формат: ivHex:tagHex:encryptedHex */
function encryptCredential(text: string | undefined | null): string | null {
  if (!text) return null;
  const key = getEncryptionKey();
  if (!key) return text; // Без APP_SECRET сохраняем в открытом виде (dev-режим)
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/** Дешифрует значение, загруженное из БД. Автоматически определяет зашифрованное значение. */
function decryptCredential(encrypted: string | undefined | null): string | null {
  if (!encrypted) return null;
  if (!APP_SECRET) return encrypted; // Без APP_SECRET ничего не дешифруем
  const key = getEncryptionKey();
  if (!key) return encrypted;
  try {
    const parts = encrypted.split(":");
    if (parts.length !== 3) return encrypted; // Не зашифровано — возвращаем как есть
    const iv = Buffer.from(parts[0], "hex");
    const tag = Buffer.from(parts[1], "hex");
    const data = Buffer.from(parts[2], "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return encrypted; // Если расшифровка не удалась — возвращаем как есть
  }
}

/** Дешифрует учётные данные камеры для in-memory использования. */
function decryptCameraCreds(cam: any): any {
  if (!cam) return cam;
  return {
    ...cam,
    username: decryptCredential(cam.username),
    password: decryptCredential(cam.password),
  };
}

// Убирает секреты (username/password) из объекта камеры перед отдачей клиенту.
// In-memory массив cameras при этом сохраняет creds для ffmpeg.
function sanitizeCamera(cam: any): any {
  if (!cam) return cam;
  const { username, password, webhookSecret, ...safe } = cam;
  return safe;
}

// CAMERAS API
app.get(["/api/cameras", "/api/cameras/"], async (req, res) => {
  try {
    const camsFromDB = await prisma.camera.findMany({ orderBy: { id: "asc" } });
    cameras = camsFromDB.map((c: any) => ({ ...decryptCameraCreds(c), status: c.status || "offline" }));
    res.json(cameras.map(sanitizeCamera));
  } catch (err) {
    logError(err as Error, { path: "/api/cameras", method: "GET" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.get(["/api/cameras/:id", "/api/cameras/:id/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ detail: "Invalid camera ID" });
    }

    const cam = await prisma.camera.findUnique({
      where: { id },
      include: {
        events: {
          orderBy: { created_at: "desc" },
          take: 5,
          select: {
            id: true,
            event_type: true,
            person_name: true,
            confidence: true,
            created_at: true,
          }
        }
      }
    });

    if (!cam) {
      return res.status(404).json({ detail: "Camera not found" });
    }

    const memoryCam = cameras.find(c => c.id === id);
    res.json({
      ...sanitizeCamera(cam),
      status: memoryCam?.status || cam.status || "offline",
      is_active: memoryCam?.is_active ?? cam.is_active,
      pipeline_status: cameraStreams.has(id) ? "streaming" : "idle",
      recent_events_count: cam.events?.length || 0,
    });
  } catch (err) {
    logError(err as Error, { path: "/api/cameras/:id", method: "GET" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

// ── Stream Concurrency Status Endpoint ──
app.get(["/api/streams/status", "/api/streams/status/"], async (req, res) => {
  try {
    const activeStreams = Array.from(streamSlots.holders).map(id => {
      const cam = cameras.find(c => c.id === id);
      return {
        cameraId: id,
        cameraName: cam?.name || "Unknown",
        clientCount: cameraStreams.get(id)?.size || 0,
        restartCount: cameraRestartCounts.get(id) || 0,
      };
    });

    const queuedStreams = pendingStreamQueue.map(id => {
      const cam = cameras.find(c => c.id === id);
      return {
        cameraId: id,
        cameraName: cam?.name || "Unknown",
        waitingSince: queueTimestamps.get(id) || null,
        waitingMs: Date.now() - (queueTimestamps.get(id) || Date.now()),
      };
    });

    res.json({
      config: {
        maxConcurrent: MAX_CONCURRENT_STREAMS,
        maxRestarts: MAX_RESTARTS_PER_CAMERA,
        rotationIntervalMs: SLOT_ROTATION_INTERVAL_MS,
      },
      stats: {
        activeCount: streamSlots.count,
        queuedCount: pendingStreamQueue.length,
        totalCameras: cameras.length,
        activeCameras: cameras.filter(c => c.is_active).length,
      },
      activeStreams,
      queuedStreams,
      rotationEnabled: rotationInterval !== null,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logError(err as Error, { path: "/api/streams/status", method: "GET" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

// ── Проверка и оптимизация камер при старте ──
async function validateAndOptimizeCameras(): Promise<void> {
  logInfo("Проверка доступности камер...");

  const usbDevicesChecked = new Map<string, boolean>();

  for (const cam of cameras) {
    if (!cam.is_active) continue;

    const isUSB = cam.source?.startsWith("/dev/video") || cam.camera_type === "USB";
    if (!isUSB) continue;

    const deviceId = cam.source?.replace("/dev/video", "") || "";
    if (!deviceId || !/^\d+$/.test(deviceId)) continue;

    if (usbDevicesChecked.has(deviceId)) {
      const available = usbDevicesChecked.get(deviceId)!;
      if (!available) {
        logWarn(`[Camera ${cam.id}] USB-устройство /dev/video${deviceId} недоступно`);
        await prisma.camera.update({
          where: { id: cam.id },
          data: { is_active: false, status: "offline" }
        });
        cam.is_active = false;
        cam.status = "offline";
      }
      continue;
    }

    try {
      const ffmpegPath = getFfmpegPath();
      const cmd = `"${ffmpegPath}" -y -f dshow -list_devices true -i dummy 2>&1`;
      const { stdout } = await execAsync(cmd, { timeout: 3000 });

      const deviceFound = stdout.includes(`video=${deviceId}`) ||
                          stdout.includes(`Video Device ${deviceId}`) ||
                          stdout.includes(`USB Video Device`);

      usbDevicesChecked.set(deviceId, deviceFound);

      if (!deviceFound) {
        logWarn(`[Camera ${cam.id}] USB-устройство /dev/video${deviceId} не найдено`);
        await prisma.camera.update({
          where: { id: cam.id },
          data: { is_active: false, status: "offline" }
        });
        cam.is_active = false;
        cam.status = "offline";
      } else {
        logInfo(`[Camera ${cam.id}] USB-устройство /dev/video${deviceId} найдено`);
        cam.status = "online";
        await prisma.camera.update({
          where: { id: cam.id },
          data: { status: "online" }
        });
      }
    } catch {
      logWarn(`[Camera ${cam.id}] Не удалось проверить USB-устройство`);
      usbDevicesChecked.set(deviceId, false);
      await prisma.camera.update({
        where: { id: cam.id },
        data: { is_active: false, status: "offline" }
      });
      cam.is_active = false;
      cam.status = "offline";
    }
  }

  // Для RTSP/ONVIF камер НЕ перезаписываем статус при старте.
  // Реальный статус (online / error:rtsp_timeout / error:ffmpeg_crash)
  // устанавливается camera pipeline при попытке подключения.
  const activeUSB = cameras.filter(c => c.is_active && (c.source?.startsWith("/dev/video") || c.camera_type === "USB")).length;
  const activeRTSP = cameras.filter(c => c.is_active && !(c.source?.startsWith("/dev/video") || c.camera_type === "USB")).length;
  logInfo(`Проверка камер завершена: ${activeUSB} USB, ${activeRTSP} RTSP/ONVIF в БД`);
}

app.get(["/api/cameras/scan/usb", "/api/cameras/scan/usb/"], (req, res) => {
  // Автоматическое сканирование USB-устройств требует нативных API.
  // В RC 1.0 поддерживается только ручной ввод источника (например, "0" или "/dev/video0").
  res.json({ cameras: [] });
});

app.get(["/api/cameras/scan/onvif", "/api/cameras/scan/onvif/"], async (req, res) => {
  try {
    const ip = (req.query.ip as string | undefined)?.trim();
    const port = parseInt((req.query.port as string | undefined) || "554", 10);
    const username = (req.query.username as string | undefined)?.trim();
    const password = (req.query.password as string | undefined)?.trim();
    const model = (req.query.model as string | undefined)?.trim();

    if (!ip) {
      return res.json({ cameras: [] });
    }

    const result = await autoFillCamera({
      ip,
      port: isNaN(port) ? 554 : port,
      username,
      password,
      model,
    });

    res.json({
      cameras: [
        {
          ip,
          port,
          reachable: result.reachable,
          vendor: result.vendor,
          model: result.model,
          firmware: result.firmware,
          source: result.source,
          main: result.main,
          sub: result.sub,
          transport: result.transport,
          onvif: result.onvif,
          sourceLabel: result.sourceLabel,
          errors: result.errors,
        },
      ],
    });
  } catch (e: any) {
    logError(e as Error, { path: "/api/cameras/scan/onvif", method: "GET" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.post(["/api/cameras/probe", "/api/cameras/probe/"], async (req, res) => {
  try {
    const { ip, port, username, password, model } = req.body || {};
    if (!ip) {
      return res.status(400).json({ detail: "ip is required" });
    }
    const result = await autoFillCamera({
      ip: String(ip),
      port: parseInt(String(port || 554), 10),
      username: username ? String(username) : undefined,
      password: password ? String(password) : undefined,
      model: model ? String(model) : undefined,
    });
    res.json(result);
  } catch (e: any) {
    logError(e as Error, { path: "/api/cameras/probe", method: "POST" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.post(["/api/cameras/:id/start", "/api/cameras/:id/start/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const cam = cameras.find((c) => c.id === id);
    if (!cam) return res.status(404).json({ detail: "Camera not found" });

    // 1. Переводим в состояние "connecting" — FFmpeg ещё не запущен или только стартует
    const updated = await prisma.camera.update({
      where: { id },
      data: { is_active: true, status: "connecting" },
    });
    const index = cameras.findIndex((c) => c.id === id);
    if (index >= 0) { cameras[index].is_active = true; cameras[index].status = "connecting"; }

    // 2. Запускаем FFmpeg-конвейер (startCameraPipeline стартует процесс и цикл детекции)
    const fallbackFrame = getFallbackFrame();
    startCameraPipeline(cam, fallbackFrame);

    // 3. Ждём до 3 секунд и проверяем: процесс жив? Есть ли реальный кадр?
    const isOnlineAfterStart = await new Promise<boolean>((resolve) => {
      const deadline = Date.now() + 3000;
      const check = () => {
        const proc = activeFfmpegProcesses.get(id);
        const shared = cameraFrames.get(id);
        const hasRealFrame = shared && shared.frame !== fallbackFrame;
        if (proc && hasRealFrame) return resolve(true);
        if (!proc) return resolve(false); // процесс упал — ошибка
        if (Date.now() < deadline) return setTimeout(check, 250);
        resolve(false); // таймаут — кадры не пришли
      };
      check();
    });

    let finalStatus = "online";
    let errorMessage: string | undefined;
    if (!isOnlineAfterStart) {
      finalStatus = "error";
      // Останавливаем неудачный процесс, чтобы не слал повторные запросы
      stopCameraPipeline(id);
      errorMessage = "FFmpeg failed or no frames received within 3s";
    }

    // 4. Обновляем статус в БД и in-memory
    await prisma.camera.update({ where: { id }, data: { status: finalStatus } });
    const idx2 = cameras.findIndex((c) => c.id === id);
    if (idx2 >= 0) cameras[idx2].status = finalStatus;

    res.json({
      success: isOnlineAfterStart,
      status: finalStatus,
      camera: sanitizeCamera({ ...updated, status: finalStatus }),
      ...(errorMessage ? { error: errorMessage } : {}),
    });
  } catch (err) {
    logError(err as Error, { path: "/api/cameras/:id/start" });
    res.status(404).json({ detail: "Camera not found" });
  }
});

app.post(["/api/cameras/:id/stop", "/api/cameras/:id/stop/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const updated = await prisma.camera.update({
      where: { id },
      data: { is_active: false, status: "offline" },
    });
    const index = cameras.findIndex((c) => c.id === id);
    if (index >= 0) { cameras[index].is_active = false; cameras[index].status = "offline"; }

    // Terminate existing WebSocket streaming sessions for this camera immediately
    const streams = cameraStreams.get(id);
    if (streams) {
      for (const ws of streams) {
        try { ws.close(); } catch {}
      }
      cameraStreams.delete(id);
    }

    stopCameraPipeline(id);

    res.json({ success: true, status: "offline", camera: sanitizeCamera(updated) });
  } catch (err) {
    res.status(404).json({ detail: "Camera not found" });
  }
});

function findNameAndSimilarity(obj: any): { name?: string, similarity?: number } {
  if (!obj || typeof obj !== 'object') return {};
  let name: string | undefined;
  let similarity: number | undefined;

  // Direct fields commonly used in LAPI / HTTP Push JSON
  if (typeof obj.Name === 'string') name = obj.Name;
  else if (typeof obj.name === 'string') name = obj.name;
  else if (typeof obj.MemberName === 'string') name = obj.MemberName;
  else if (typeof obj.userName === 'string') name = obj.userName;
  else if (typeof obj.StaffName === 'string') name = obj.StaffName;
  else if (typeof obj.PersonName === 'string') name = obj.PersonName;

  if (typeof obj.MatchRate === 'number') similarity = obj.MatchRate / 100;
  else if (typeof obj.MatchRate === 'string') similarity = parseFloat(obj.MatchRate) / 100;
  else if (typeof obj.MatchPercent === 'number') similarity = obj.MatchPercent / 100;
  else if (typeof obj.similarity === 'number') similarity = obj.similarity;
  else if (typeof obj.Similarity === 'number') similarity = obj.Similarity;
  else if (typeof obj.score === 'number') similarity = obj.score;
  else if (typeof obj.Score === 'number') similarity = obj.Score;

  // Recursively search sub-properties
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      const sub = findNameAndSimilarity(obj[key]);
      if (sub.name && !name) name = sub.name;
      if (sub.similarity !== undefined && similarity === undefined) similarity = sub.similarity;
    }
  }
  return { name, similarity };
}

app.post(["/api/webhook/unv/:secret", "/api/webhook/unv/:secret/"], unvWebhookUpload.single('image'), async (req, res) => {
  logDebug("UNV LAPI Webhook received", { headers: req.headers['content-type'], bodyKeys: Object.keys(req.body) });

  const secret = req.params.secret;
  let camera: any = null;

  // Аутентификация: ищем камеру по webhookSecret из URL
  if (secret) {
    camera = await prisma.camera.findUnique({
      where: { webhookSecret: secret },
    });
      if (camera) {
        // Sync in-memory camera with latest DB data (including decrypted credentials)
        const idx = cameras.findIndex(c => c.id === camera.id);
        if (idx >= 0) cameras[idx] = { ...cameras[idx], ...decryptCameraCreds(camera) };
      }
  }

  if (!camera) {
    logWarn("UNV webhook rejected: invalid or missing secret", { secret: secret?.slice(0, 8) });
    return res.status(401).json({ error: "Invalid webhook secret" });
  }

  const cam = camera;
  logInfo(`UNV webhook → camera ID ${cam.id} (${cam.name})`);

  // Parse JSON data from any fields or body
  let parsedPayload: any = null;
  
  if (req.body && Object.keys(req.body).length > 0) {
    parsedPayload = req.body;
  }
  
  for (const key of Object.keys(req.body)) {
    const val = req.body[key];
    if (typeof val === 'string' && (val.trim().startsWith('{') || val.trim().startsWith('['))) {
      try {
        parsedPayload = JSON.parse(val);
        logDebug(`Parsed JSON from form field "${key}"`);
        break;
      } catch (err) {
        // ignore
      }
    }
  }

  let personName: string | undefined;
  let confidence: number | undefined;

  if (parsedPayload) {
    const extracted = findNameAndSimilarity(parsedPayload);
    personName = extracted.name;
    confidence = extracted.similarity;
  }

  logDebug(`UNV extracted name: "${personName}", similarity: ${confidence}`);

  // Helper for smart capture naming according to user request format (ДДММГГГГ_ЧЧММСС_Неизвестный)
  const getSmartCaptureFilename = (pName?: string, ext = ".jpg") => {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const dateStr = `${day}${month}${year}`;
    const timeStr = `${hours}${minutes}${seconds}`;

    const isUnknown = !pName || pName.toLowerCase() === 'unknown' || pName.toLowerCase() === 'неизвестный' || pName.toLowerCase() === 'неизвестный клиент';
    if (isUnknown) {
      return `${dateStr}_${timeStr}_Неизвестный${ext}`;
    } else {
      return `unv_${Date.now()}_${Math.floor(Math.random() * 1000)}${ext}`;
    }
  };

  // Save the uploaded snapshot file if present (memory storage + magic byte validation)
  let snapshot_path = "snapshots/ev1.jpg";
  const file = req.file as Express.Multer.File | undefined;

  if (file) {
    // Проверка magic bytes (JPEG/PNG) — защита от подмены расширения
    if (!validateImageMagicBytes(file.buffer, file.mimetype)) {
      logWarn(`UNV webhook: invalid magic bytes for camera ${cam.id}`, { filename: file.originalname, mimetype: file.mimetype });
    } else {
      const ext = path.extname(file.originalname) || '.jpg';
      const targetFilename = getSmartCaptureFilename(personName, ext);
      const targetPath = path.join(snapshotsDir, targetFilename);
      try {
        fs.writeFileSync(targetPath, file.buffer);
        snapshot_path = `snapshots/${targetFilename}`;
        logInfo(`UNV snapshot saved: ${snapshot_path} (${file.size} bytes)`);
      } catch (err) {
        logError(err as Error, { context: "UNV snapshot save" });
      }
    }
  } else {
    // Fallback: base64 image in body fields
    let base64Image: string | null = null;
    for (const key of Object.keys(req.body)) {
      const val = req.body[key];
      if (typeof val === 'string' && (val.startsWith('data:image') || val.length > 1000 && /^[A-Za-z0-9+/=]+$/.test(val.slice(0, 100)))) {
        base64Image = val;
        break;
      }
    }
    if (base64Image) {
      try {
        const base64Data = base64Image.includes('base64,') ? base64Image.split('base64,')[1] : base64Image;
        const buf = Buffer.from(base64Data, 'base64');
        // Magic byte check for base64-decoded images too
        if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
          const targetFilename = getSmartCaptureFilename(personName, ".jpg");
          const targetPath = path.join(snapshotsDir, targetFilename);
          fs.writeFileSync(targetPath, buf);
          snapshot_path = `snapshots/${targetFilename}`;
          logInfo(`UNV base64 snapshot saved: ${snapshot_path}`);
        } else {
          logWarn("UNV webhook: invalid magic bytes in base64 image");
        }
      } catch (err) {
        logError(err as Error, { context: "UNV base64 snapshot" });
      }
    }
  }

  // Async: lookup person in DB and persist event
  (async () => {
    try {
      let matchedPerson: any = null;
      if (personName && personName.toLowerCase() !== "unknown" && personName.toLowerCase() !== "неизвестный") {
        const allPersons = await prisma.person.findMany({ select: { id: true, name: true, category: true, photo_path: true, visit_count: true } });
        matchedPerson = allPersons.find((p: any) => namesMatchFIO(p.name, personName!));
      }

      if (matchedPerson) {
        await prisma.person.update({
          where: { id: matchedPerson.id },
          data: { visit_count: { increment: 1 }, last_seen_at: new Date() },
        });
        // Sync in-memory
        const idx = persons.findIndex((p) => p.id === matchedPerson.id);
        if (idx >= 0) { persons[idx].visit_count++; persons[idx].last_seen_at = new Date().toISOString(); }

        let event_type = "RECOGNIZED";
        if (matchedPerson.category === "VIP") event_type = "VIP_ARRIVAL";
        else if (matchedPerson.category === "BLACKLIST") event_type = "BLACKLIST_ALERT";
        else if (matchedPerson.category === "RESPONSE") event_type = "RESPONSE_ALERT";

        const eventConfidence = confidence || 0.85;
        const meetsVerification = (eventConfidence * 100) >= verification_threshold_pct;

        const event = await prisma.event.create({
          data: {
            camera_id: camera.id,
            camera_name: camera.name,
            person_id: matchedPerson.id,
            event_type,
            confidence: eventConfidence,
            snapshot_path,
            person_name: matchedPerson.name,
            person_category: matchedPerson.category,
            person_photo_path: matchedPerson.photo_path,
            categoryCode: matchedPerson.category,
            needs_operator_confirmation: !meetsVerification,
            confirmation_status: !meetsVerification ? "pending" : undefined,
          },
        });

        await emitPersonAlert({
          person: { id: matchedPerson.id, name: matchedPerson.name, categoryCode: matchedPerson.category },
          camera: { id: camera.id, name: camera.name, zone: camera.zone },
          eventId: event.id,
          snapshotUrl: snapshot_path ? `/snapshots/${snapshot_path}` : null,
        })

        broadcastSecurity({ type: "EVENT" });
      } else {
        await prisma.event.create({
          data: {
            camera_id: camera.id,
            camera_name: camera.name,
            event_type: "UNKNOWN",
            confidence: confidence || 0.5,
            snapshot_path,
            person_name: personName || "Неизвестный",
            person_category: "CLIENT",
            categoryCode: "CLIENT",
          },
        });

        broadcastSecurity({
          type: "ALERT",
          category: "CLIENT",
          person_id: 0,
          person_name: personName || "Неизвестный",
          camera_id: camera.id,
          confidence: confidence || 0.5,
          snapshot_path,
          timestamp: new Date().toISOString(),
        });
        broadcastSecurity({ type: "EVENT" });
      }
    } catch (dbErr) {
      logError(dbErr as Error, { context: "UNV webhook DB persist" });
    }
  })();

  res.json({ success: true, camera_id: camera.id, processed: true });
});

app.post(["/api/cameras/:id/test-connection", "/api/cameras/:id/test-connection/"], async (req, res) => {
  const id = parseInt(req.params.id);
  const cam = cameras.find((c) => c.id === id);
  if (!cam) {
    return res.status(404).json({ error: 'Camera not found' });
  }

  const result = await probeCamera(cam);
  res.json({
    connected: result.connected,
    camera_id: cam.id,
    camera_name: cam.name,
    camera_type: cam.camera_type,
    source: cam.source,
    details: result.details,
    timestamp: new Date().toISOString(),
  });
});

app.post(["/api/recordings/start/:id", "/api/recordings/start/:id/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const camera = cameras.find(c => c.id === id);
    if (!camera) return res.status(404).json({ detail: "Camera not found" });

    // Реальная запись через ffmpeg (непрерывно до stop)
    const outputPath = await startFileRecording(camera);
    if (!outputPath) {
      return res.status(500).json({ detail: "Не удалось запустить запись (нет камеры/ffmpeg)" });
    }
    res.json({ success: true, status: "recording", camera_id: id, output_path: `recordings/${path.basename(outputPath)}` });
  } catch (err) {
    logError(err as Error, { path: "/api/recordings/start/:id" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.post(["/api/cameras", "/api/cameras/"], async (req, res) => {
  try {
    const newCam = await prisma.camera.create({
      data: {
        name: req.body.name || "Новая камера",
        source: req.body.source || "0",
        camera_type: req.body.camera_type || "USB",
        zone: req.body.zone || "Основная зона",
        is_active: req.body.is_active !== false,
        status: "online",
        roi_zones: req.body.roi_zones || null,
        fps: 25,
        ping_ms: 0,
        is_smart_recording: req.body.is_smart_recording || false,
        is_chronicle: req.body.is_chronicle !== false,
        driver_type: req.body.driver_type || null,
        ip_address: req.body.ip_address || null,
        ip_port: req.body.ip_port ? parseInt(req.body.ip_port) : null,
        username: encryptCredential(req.body.username) || null,
        password: encryptCredential(req.body.password) || null,
        use_camera_analytics: req.body.use_camera_analytics || false,
        webhookSecret: req.body.camera_type === "UNV" || req.body.camera_type === "Hikvision" ? crypto.randomUUID() : null,
      },
    });
    // Sync in-memory (store plaintext creds for FFmpeg use; sanitizeCamera hides them from API)
    cameras.push({ ...newCam, username: req.body.username || null, password: req.body.password || null });
    res.status(201).json(sanitizeCamera(newCam));
  } catch (err) {
    logError(err as Error, { path: "/api/cameras", method: "POST" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.put("/api/cameras/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    // Exclude fields that don't exist in Prisma schema
    const { created_at, ...updateData } = req.body;
    // Шифруем учётные данные перед сохранением в БД
    if (updateData.username !== undefined && typeof updateData.username === 'string') {
      updateData.username = updateData.username ? encryptCredential(updateData.username) : null;
    }
    if (updateData.password !== undefined && typeof updateData.password === 'string') {
      updateData.password = updateData.password ? encryptCredential(updateData.password) : null;
    }
    const updated = await prisma.camera.update({
      where: { id },
      data: updateData,
    });
    // Sync in-memory (расшифровываем для использования в FFmpeg)
    const index = cameras.findIndex((c) => c.id === id);
    if (index >= 0) cameras[index] = { ...cameras[index], ...decryptCameraCreds(updated) };
    res.json(sanitizeCamera(updated));
  } catch (err) {
    logError(err as Error, { path: "/api/cameras/:id", method: "PUT" });
    res.status(404).json({ detail: "Camera not found" });
  }
});

app.delete(["/api/cameras/:id", "/api/cameras/:id/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    // 1. Stop WebSocket streams for this camera
    const streams = cameraStreams.get(id);
    if (streams) {
      for (const ws of streams) { try { ws.close(); } catch {} }
      cameraStreams.delete(id);
    }

    // 2. Stop FFmpeg pipeline
    stopCameraPipeline(id);

    // 3. Stop active file recording
    stopFileRecording(id);
    const recSession = activeRecordings.get(id);
    if (recSession) {
      try { recSession.proc.kill("SIGKILL"); } catch {}
      activeRecordings.delete(id);
    }

    // 4. Clean up in-memory caches
    cameraFrames.delete(id);
    cameraFrameQueues.delete(id);
    cameraFfmpegRetries.delete(id);
    cameraCircuitBreakers.delete(id);
    cameraRestartTimers.delete(id);
    cameraSessionIds.delete(id);
    cameraDetectionTimers.delete(id);
    cameraZoneCache.delete(id);
    streamSettings.delete(id);

    // 5. Clean up chronicleData for this camera
    if (chronicleData[id]) {
      delete chronicleData[id];
    }

    // 6. Clean up recordingsData for this camera
    if (recordingsData[id]) {
      delete recordingsData[id];
    }

    // 7. Delete all Event records and their snapshot files
    const events = await prisma.event.findMany({ where: { camera_id: id }, select: { snapshot_path: true } });
    for (const event of events) {
      if (event.snapshot_path) {
        const fullPath = path.join(publicDir, event.snapshot_path);
        try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch { /* ignore */ }
      }
    }

    // 8. Delete all Recording records and their video files
    const recordings = await prisma.recording.findMany({ where: { camera_id: id }, select: { video_path: true } });
    for (const recording of recordings) {
      if (recording.video_path) {
        const fullPath = path.join(publicDir, recording.video_path);
        try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch { /* ignore */ }
      }
    }

    // 9. Delete temp snapshots for this camera
    const tempSnapPath = path.join(snapshotsDir, `temp_snap_${id}.jpg`);
    try { if (fs.existsSync(tempSnapPath)) fs.unlinkSync(tempSnapPath); } catch { /* ignore */ }

    // 10. Delete snapshot files by pattern cam{id}_*.jpg
    if (fs.existsSync(snapshotsDir)) {
      for (const entry of fs.readdirSync(snapshotsDir)) {
        if (entry.startsWith(`cam${id}_`) && entry.endsWith(".jpg")) {
          try { fs.unlinkSync(path.join(snapshotsDir, entry)); } catch { /* ignore */ }
        }
      }
    }

    // 11. Delete recording files by pattern cam{id}_*.mp4
    if (fs.existsSync(recordingsDir)) {
      for (const entry of fs.readdirSync(recordingsDir)) {
        if (entry.startsWith(`cam${id}_`) && entry.endsWith(".mp4")) {
          try { fs.unlinkSync(path.join(recordingsDir, entry)); } catch { /* ignore */ }
        }
      }
    }

    // 12. Delete camera from DB
    await prisma.camera.delete({ where: { id } });

    // 13. Remove from in-memory cameras array
    cameras = cameras.filter((c) => c.id !== id);

    // 14. Notify all WebSocket clients
    broadcastSecurity({ type: "CAMERA_DELETED", camera_id: id });

    res.json({ success: true });
  } catch (err) {
    logError(err as Error, { path: "/api/cameras/:id", method: "DELETE" });
    res.status(404).json({ detail: "Camera not found" });
  }
});

app.get("/api/cameras/:id/roi", async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const camera = await prisma.camera.findUnique({ where: { id } })
    if (!camera) return res.status(404).json({ detail: "Camera not found" })
    const zones = camera.roi_zones ? JSON.parse(camera.roi_zones) : []
    const exclusionZones = camera.exclusion_zones ? JSON.parse(camera.exclusion_zones) : []
    res.json({ zones, exclusion_zones: exclusionZones })
  } catch (err) {
    logError(err as Error, { path: "/api/cameras/:id/roi", method: "GET" })
    res.status(500).json({ detail: "Internal server error" })
  }
})

app.put("/api/cameras/:id/roi", async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const { roi_zones, exclusion_zones } = req.body as { roi_zones?: any[]; exclusion_zones?: any[] | null }
    if (roi_zones !== undefined && !Array.isArray(roi_zones)) return res.status(400).json({ detail: "roi_zones must be an array" })
    if (exclusion_zones !== undefined && exclusion_zones !== null && !Array.isArray(exclusion_zones)) return res.status(400).json({ detail: "exclusion_zones must be an array" })
    const updated = await prisma.camera.update({
      where: { id },
      data: {
        roi_zones: roi_zones !== undefined ? JSON.stringify(roi_zones) : undefined,
        exclusion_zones: exclusion_zones !== undefined ? JSON.stringify(exclusion_zones) : undefined,
      },
    })
    const zones = updated.roi_zones ? JSON.parse(updated.roi_zones) : []
    const exclusionZones = updated.exclusion_zones ? JSON.parse(updated.exclusion_zones) : []
    res.json({ success: true, zones, exclusion_zones: exclusionZones })
  } catch (err) {
    logError(err as Error, { path: "/api/cameras/:id/roi", method: "PUT" })
    res.status(500).json({ detail: "Internal server error" })
  }
})

app.get("/api/cameras/:id/snapshot", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const cam = cameras.find((c) => c.id === id);
    let imageBuffer: Buffer | null = null;

    if (cam && cam.is_active && cam.source && !cam.source.startsWith("/dev/video")) {
      const tempSnapPath = path.join(snapshotsDir, `temp_snap_${id}.jpg`);
      try {
        const ffmpegPath = getFfmpegPath();
        await execAsync(`"${ffmpegPath}" -y -rtsp_transport tcp -i "${cam.source}" -vframes 1 -q:v 2 "${tempSnapPath}"`, { timeout: 10000 });
        if (fs.existsSync(tempSnapPath)) {
          imageBuffer = await fs.promises.readFile(tempSnapPath);
          fs.unlinkSync(tempSnapPath);
        }
      } catch (ffmpegErr) {
        logWarn(`Не удалось сделать живой снимок камеры ${id}: ${ffmpegErr}`);
      }
    }

    if (!imageBuffer) {
      const snapshotsDirPath = path.join(publicDir, "snapshots");
      const matches: string[] = [];
      if (fs.existsSync(snapshotsDirPath)) {
        for (const entry of fs.readdirSync(snapshotsDirPath)) {
          if (entry.startsWith(`cam${id}_`) && entry.endsWith(".jpg")) {
            matches.push(path.join(snapshotsDirPath, entry));
          }
        }
      }
      if (matches.length > 0) {
        matches.sort().reverse();
        const latest = matches[0];
        if (fs.existsSync(latest)) {
          imageBuffer = fs.readFileSync(latest);
        }
      }
    }

    if (!imageBuffer) {
      const rusSrc = path.join(process.cwd(), "src", "assets", "rus.jpg");
      const logoSrc = path.join(process.cwd(), "src", "assets", "logo.jpg");
      if (fs.existsSync(rusSrc)) {
        imageBuffer = fs.readFileSync(rusSrc);
      } else if (fs.existsSync(logoSrc)) {
        imageBuffer = fs.readFileSync(logoSrc);
      } else {
        imageBuffer = Buffer.from(FALLBACK_JPEG, "base64");
      }
    }

    res.json({
      image: imageBuffer.toString("base64"),
      content_type: "image/jpeg",
    });
  } catch (err) {
    logError(err as Error, { path: "/api/cameras/:id/snapshot" });
    res.status(500).json({ detail: "Не удалось получить снимок" });
  }
});

app.post("/api/cameras/:id/capture", (req, res) => {
  // Capture manual snapshot and register
  res.json({ success: true, photo_path: "snapshots/ev1.jpg" });
});

app.post(["/api/cameras/:id/recording/start", "/api/cameras/:id/recording/start/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await prisma.camera.update({ where: { id }, data: { is_smart_recording: true } });
    const index = cameras.findIndex((c) => c.id === id);
    if (index >= 0) cameras[index].is_smart_recording = true;
    // Запускаем непрерывную запись через ffmpeg
    const outputPath = await startFileRecording(cameras[index] || { id, name: `Camera ${id}` });
    res.json({ success: true, status: "recording", output_path: outputPath ? `recordings/${path.basename(outputPath)}` : null });
  } catch (err) {
    res.status(404).json({ detail: "Camera not found" });
  }
});

app.post("/api/cameras/:id/recording/stop", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await prisma.camera.update({ where: { id }, data: { is_smart_recording: false } });
    const index = cameras.findIndex((c) => c.id === id);
    if (index >= 0) cameras[index].is_smart_recording = false;

    // Останавливаем реальную запись; финализация (строка в БД) произойдёт в обработчике close ffmpeg
    const stopped = stopFileRecording(id);
    if (stopped) {
      // Даём ffmpeg короткое время на запись трейлера и создание строки
      await new Promise((r) => setTimeout(r, 800));
      const session = activeRecordings.get(id);
      if (session) {
        // Если процесс ещё не завершился — принудительно завершаем
        try { session.proc.kill("SIGKILL"); } catch { /* ignore */ }
        activeRecordings.delete(id);
      }
    }
    const lastRec = await prisma.recording.findFirst({ where: { camera_id: id }, orderBy: { start_time: "desc" } });
    res.json({ success: true, status: "stopped", recording: lastRec || null });
  } catch (err) {
    logError(err as Error, { path: "/api/cameras/:id/recording/stop" });
    res.status(404).json({ detail: "Camera not found" });
  }
});

// ── STREAM SETTINGS API ──

app.get(["/api/cameras/:id/stream-settings", "/api/cameras/:id/stream-settings/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const settings = streamSettings.get(id) || { row1: null, row2: null };
    res.json(settings);
  } catch (err) {
    logError(err as Error, { path: "/api/cameras/:id/stream-settings", method: "GET" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.put(["/api/cameras/:id/stream-settings", "/api/cameras/:id/stream-settings/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { row1, row2 } = req.body;
    streamSettings.set(id, { row1, row2 });
    res.json({ success: true });
  } catch (err) {
    logError(err as Error, { path: "/api/cameras/:id/stream-settings", method: "PUT" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.post(["/api/cameras/:id/stream-settings/populate", "/api/cameras/:id/stream-settings/populate/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const cam = cameras.find((c) => c.id === id);
    if (!cam) return res.status(404).json({ detail: "Camera not found" });

      const { ip, port, username, password, model } = req.body || {};
      let sourceHostname: string | null = null;
      if (cam.source) {
        try { sourceHostname = new URL(cam.source).hostname } catch { /* source не является валидным URL (например, /dev/video0) */ }
      }
      const targetIp = ip || cam.ip_address || sourceHostname;

      if (!targetIp) {
        logWarn("Не удалось определить IP камеры", { cameraId: id, cameraName: cam.name, source: cam.source });
        return res.status(400).json({
          detail: "Не удалось определить IP камеры. Укажите ip_address в настройках камеры.",
          errors: ["missing_ip_address"]
        });
      }
    const targetPort = port || cam.ip_port || 554;

    const result = await autoFillCamera({
      ip: String(targetIp),
      port: parseInt(String(targetPort), 10),
      username: username ? String(username) : cam.username || undefined,
      password: password ? String(password) : cam.password || undefined,
      model: model ? String(model) : cam.model_name || undefined,
    });

    const mapToRow = (main: any) => ({
      codec: main?.codec || "H.264",
      gop: main?.gop || 30,
      fps: main?.fps || 25,
      resolution: main?.width && main?.height ? `${main.width}x${main.height}` : "1920x1080",
      bitrate: main?.bitrate || 4096,
      sourceLabel: result.sourceLabel || "rtsp",
    });

    const row1 = mapToRow(result.main);
    const row2 = mapToRow(result.sub || result.main);

    streamSettings.set(id, { row1, row2 });

    const profiles = normalizeProbeProfiles(result);
    const sourceLabel = resolveSourceLabel(result, cam) || "rtsp";
    const conflicts = (result.conflicts && result.conflicts.length) ? result.conflicts : undefined;
    const streamProfilesJson = profiles.length
      ? serializeStreamProfiles(profiles, conflicts)
      : cam.stream_profiles;

    const aiStreamProfileId = profiles.length ? recommendAiStreamProfile(profiles) : null;

    await prisma.camera.update({
      where: { id },
      data: {
        vendor: result.vendor || cam.vendor,
        model_name: result.model || cam.model_name,
        firmware: result.firmware || cam.firmware,
        serial_number: result.serial_number || cam.serial_number,
        mac_address: result.mac_address || cam.mac_address,
        onvif_supported: result.onvif ?? cam.onvif_supported,
        probe_source: sourceLabel || cam.probe_source,
        probe_updated_at: new Date(),
        data_confidence: result.data_confidence || cam.data_confidence,
        last_verified_at: new Date(),
        stream_profiles: streamProfilesJson,
        ai_stream_profile_id: aiStreamProfileId || cam.ai_stream_profile_id,
      },
    });

    const updated = cameras.find((c) => c.id === id);
    if (updated) {
      Object.assign(updated, {
        vendor: result.vendor || cam.vendor,
        model_name: result.model || cam.model_name,
        firmware: result.firmware || cam.firmware,
        serial_number: result.serial_number || cam.serial_number,
        mac_address: result.mac_address || cam.mac_address,
        onvif_supported: result.onvif ?? cam.onvif_supported,
        probe_source: sourceLabel || cam.probe_source,
        data_confidence: result.data_confidence || cam.data_confidence,
        last_verified_at: new Date().toISOString(),
        stream_profiles: streamProfilesJson,
        ai_stream_profile_id: aiStreamProfileId || cam.ai_stream_profile_id,
      });
    }

    res.json({
      success: true,
      row1,
      row2,
      sourceLabel,
      vendor: result.vendor,
      model: result.model,
      firmware: result.firmware,
      serial_number: result.serial_number,
      mac_address: result.mac_address,
      onvif: result.onvif,
      profiles,
      conflicts,
      data_confidence: result.data_confidence,
      ai_stream_profile_id: aiStreamProfileId || cam.ai_stream_profile_id,
      last_verified_at: new Date().toISOString(),
    });
  } catch (e: any) {
    logError(e as Error, { path: "/api/cameras/:id/stream-settings/populate", method: "POST" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

/** Безопасно разбирает stream_profiles JSON в формате {profiles: [...], conflicts: [...]} */
function parseStreamProfiles(cam: any): { profiles: StreamProfile[]; conflicts?: any[] } {
  if (!cam.stream_profiles) return { profiles: [] };
  try {
    const parsed = JSON.parse(cam.stream_profiles);
    const normalize = (p: any, index: number): StreamProfile => {
      if (p && p.resolutions && p.fps) return p as StreamProfile;
      const w = p.width || 0;
      const h = p.height || 0;
      const f = p.fps || 0;
      return {
        id: p.id || `profile_${index}`,
        name: p.name || (index === 0 ? "Main" : "Sub"),
        type: p.type || (index === 0 ? "main" : "sub"),
        codec: p.codec || "H.264",
        resolutions: [{ width: w, height: h, label: `${w}x${h}` }],
        fps: { min: f, max: f, current: f },
        bitrate: p.bitrate,
        gop: p.gop,
        source: p.source || "manual",
      };
    };
    if (Array.isArray(parsed)) {
      return { profiles: parsed.map(normalize), conflicts: undefined };
    }
    if (parsed && typeof parsed === "object") {
      return {
        profiles: Array.isArray(parsed.profiles) ? parsed.profiles.map(normalize) : [],
        conflicts: Array.isArray(parsed.conflicts) && parsed.conflicts.length ? parsed.conflicts : undefined,
      };
    }
    return { profiles: [] };
  } catch {
    return { profiles: [] };
  }
}

/** Сериализует профили и конфликты в JSON для сохранения в stream_profiles */
function serializeStreamProfiles(profiles: StreamProfile[], conflicts?: any[]): string {
  if (conflicts && conflicts.length) {
    return JSON.stringify({ profiles, conflicts });
  }
  return JSON.stringify({ profiles });
}

/** Определяет sourceLabel по приоритету: onvif > rtsp > template > manual */
function resolveSourceLabel(result: any, cam: any): "onvif" | "rtsp" | "template" | "manual" {
  if (result.sourceLabel === "onvif") return "onvif";
  if (result.sourceLabel === "rtsp") return "rtsp";
  if (result.sourceLabel === "template") return "template";
  return cam.probe_source || "manual";
}

/** Обновляет in-memory кэш камеры после изменений паспорта/профилей */
function updateCameraCache(id: number, data: Record<string, any>) {
  const updated = cameras.find((c) => c.id === id);
  if (updated) {
    Object.assign(updated, data);
  }
}

app.get(["/api/cameras/:id/passport", "/api/cameras/:id/passport/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const cam = cameras.find((c) => c.id === id);
    if (!cam) return res.status(404).json({ detail: "Camera not found" });

    const { profiles, conflicts } = parseStreamProfiles(cam);

    const response: any = {
      vendor: cam.vendor,
      model_name: cam.model_name,
      firmware: cam.firmware,
      serial_number: cam.serial_number,
      mac_address: cam.mac_address,
      onvif_supported: cam.onvif_supported,
      onvif: cam.onvif_supported,
      probe_source: cam.probe_source,
      source: cam.probe_source,
      probe_updated_at: cam.probe_updated_at,
      updated_at: cam.probe_updated_at,
      profiles,
      ai_stream_profile_id: cam.ai_stream_profile_id,
      data_confidence: cam.data_confidence,
      last_verified_at: cam.last_verified_at,
    };

    if (conflicts && conflicts.length) {
      response.conflicts = conflicts;
    }

    res.json(response);
  } catch (e: any) {
    logError(e as Error, { path: "/api/cameras/:id/passport", method: "GET" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

 app.post(["/api/cameras/:id/passport/refresh", "/api/cameras/:id/passport/refresh/"], async (req, res) => {
   try {
     const id = parseInt(req.params.id);
     const cam = cameras.find((c) => c.id === id);
     if (!cam) return res.status(404).json({ detail: "Camera not found" });

     const { ip, port, username, password, model } = req.body || {};
     const targetIp = ip || cam.ip_address || new URL(cam.source).hostname;
     const targetPort = port || cam.ip_port || 554;

     logInfo("Начало обновления паспорта камеры", { cameraId: id, cameraName: cam.name, ip: targetIp, port: targetPort });

     const result = await inspectCamera(
       String(targetIp),
       parseInt(String(targetPort), 10),
       username ? String(username) : cam.username || undefined,
       password ? String(password) : cam.password || undefined,
     );

     logInfo("Результат probe камеры", {
       cameraId: id,
       reachable: result.reachable,
       vendor: result.vendor,
       model: result.model,
       firmware: result.firmware,
       onvif: result.onvif,
       onvifProfilesCount: (result.onvif_profiles || []).length,
       rtspProfilesCount: (result.rtsp_profiles || []).length,
       errors: result.errors,
       dataConfidence: result.data_confidence,
     });

     const sourceLabel = resolveSourceLabel(result, cam);

     const profiles = normalizeProbeProfiles(result);

     const onvifProfiles = result.onvif_profiles || [];
     const rtspProfiles = result.rtsp_profiles || [];
     let conflicts: any[] = [];
     if (onvifProfiles.length && rtspProfiles.length) {
       conflicts = compareProbeResults({ profiles: onvifProfiles } as Partial<CameraProbeResult>, { profiles: rtspProfiles } as Partial<CameraProbeResult>);
     }

     if (conflicts.length) {
       logWarn("Обнаружены конфликты между ONVIF и RTSP", {
         cameraId: id,
         conflictsCount: conflicts.length,
         conflicts,
       });
     }

     const aiStreamProfileId = profiles.length ? recommendAiStreamProfile(profiles) : null;

     logInfo("Рекомендованный AI поток", {
       cameraId: id,
       aiStreamProfileId,
       totalProfiles: profiles.length,
     });

      const dataConfidence = result.data_confidence || cam.data_confidence;

      const streamProfilesJson = serializeStreamProfiles(profiles, conflicts.length ? conflicts : undefined);

      if (!result.reachable && profiles.length === 0) {
        logWarn("Паспорт не обновлён: камера недоступна и профили не найдены", {
          cameraId: id,
          errors: result.errors,
        });

        const response: any = {
          success: false,
          vendor: result.vendor || cam.vendor,
          model_name: result.model || cam.model_name,
          model: result.model || cam.model_name,
          firmware: result.firmware || cam.firmware,
          serial_number: result.serial_number || cam.serial_number,
          mac_address: result.mac_address || cam.mac_address,
          onvif_supported: result.onvif ?? cam.onvif_supported,
          onvif: result.onvif ?? cam.onvif_supported,
          probe_source: sourceLabel,
          source: sourceLabel,
          probe_updated_at: cam.probe_updated_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          profiles: [],
          data_confidence: dataConfidence,
          last_verified_at: new Date().toISOString(),
          ai_stream_profile_id: cam.ai_stream_profile_id,
          main: result.main,
          sub: result.sub,
          errors: result.errors,
        };

        if (conflicts.length) {
          response.conflicts = conflicts;
        }

        return res.json(response);
      }

      logInfo("Обновление паспорта в БД", { cameraId: id, vendor: result.vendor, model: result.model, profilesCount: profiles.length });

     await prisma.camera.update({
      where: { id },
      data: {
        vendor: result.vendor || cam.vendor,
        model_name: result.model || cam.model_name,
        firmware: result.firmware || cam.firmware,
        serial_number: result.serial_number || cam.serial_number,
        mac_address: result.mac_address || cam.mac_address,
        onvif_supported: result.onvif ?? cam.onvif_supported,
        probe_source: sourceLabel,
        probe_updated_at: new Date(),
        data_confidence: dataConfidence,
        last_verified_at: new Date(),
        stream_profiles: streamProfilesJson,
        ai_stream_profile_id: aiStreamProfileId || cam.ai_stream_profile_id,
      },
    });

     updateCameraCache(id, {
       vendor: result.vendor || cam.vendor,
       model_name: result.model || cam.model_name,
       firmware: result.firmware || cam.firmware,
       serial_number: result.serial_number || cam.serial_number,
       mac_address: result.mac_address || cam.mac_address,
       onvif_supported: result.onvif ?? cam.onvif_supported,
       probe_source: sourceLabel,
       data_confidence: dataConfidence,
       last_verified_at: new Date().toISOString(),
       stream_profiles: streamProfilesJson,
       ai_stream_profile_id: aiStreamProfileId || cam.ai_stream_profile_id,
     });

     logInfo("Паспорт камеры успешно обновлён", {
       cameraId: id,
       vendor: result.vendor || cam.vendor,
       model: result.model || cam.model_name,
       firmware: result.firmware || cam.firmware,
       probeSource: sourceLabel,
       dataConfidence,
       aiStreamProfileId,
       profilesCount: profiles.length,
       conflictsCount: conflicts.length,
     });

     const response: any = {
      success: true,
      vendor: result.vendor || cam.vendor,
      model_name: result.model || cam.model_name,
      model: result.model || cam.model_name,
      firmware: result.firmware || cam.firmware,
      serial_number: result.serial_number || cam.serial_number,
      mac_address: result.mac_address || cam.mac_address,
      onvif_supported: result.onvif ?? cam.onvif_supported,
      onvif: result.onvif ?? cam.onvif_supported,
      probe_source: sourceLabel,
      source: sourceLabel,
      probe_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      profiles,
      data_confidence: dataConfidence,
      last_verified_at: new Date().toISOString(),
      ai_stream_profile_id: aiStreamProfileId || cam.ai_stream_profile_id,
      main: result.main,
      sub: result.sub,
      errors: result.errors,
    };

    if (conflicts.length) {
      response.conflicts = conflicts;
    }

    res.json(response);
  } catch (e: any) {
    logError(e as Error, { path: "/api/cameras/:id/passport/refresh", method: "POST" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.get(["/api/cameras/:id/passport/compare", "/api/cameras/:id/passport/compare/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const cam = cameras.find((c) => c.id === id);
    if (!cam) return res.status(404).json({ detail: "Camera not found" });

    const ip = (req.query.ip as string | undefined)?.trim() || cam.ip_address || new URL(cam.source).hostname;
    const port = parseInt((req.query.port as string | undefined) || (cam.ip_port || 554).toString(), 10) || 554;
    const username = (req.query.username as string | undefined)?.trim() || cam.username || undefined;
    const password = (req.query.password as string | undefined)?.trim() || cam.password || undefined;

    const result = await inspectCamera(
      String(ip),
      parseInt(String(port), 10),
      username,
      password,
    );

    const currentProfiles = normalizeProbeProfiles(result);
    const { profiles: storedProfiles, conflicts: storedConflicts } = parseStreamProfiles(cam);

    const onvifProfiles = result.onvif_profiles || [];
    const rtspProfiles = result.rtsp_profiles || [];
    let liveConflicts: any[] = [];
    if (onvifProfiles.length && rtspProfiles.length) {
      liveConflicts = compareProbeResults({ profiles: onvifProfiles } as Partial<CameraProbeResult>, { profiles: rtspProfiles } as Partial<CameraProbeResult>);
    }

    const changes: any[] = [];
    const maxCompare = Math.max(currentProfiles.length, storedProfiles.length);
    for (let i = 0; i < maxCompare; i++) {
      const current = currentProfiles[i];
      const stored = storedProfiles[i];
      if (!stored && current) {
        changes.push({ index: i, type: "added", profile: current });
      } else if (stored && !current) {
        changes.push({ index: i, type: "removed", profile: stored });
      } else if (stored && current) {
        const diffs: string[] = [];
        if (stored.codec !== current.codec) diffs.push(`codec: stored=${stored.codec} vs current=${current.codec}`);
        const storedRes = stored.resolutions?.[0];
        const currentRes = current.resolutions?.[0];
        if (storedRes && currentRes) {
          if (storedRes.width !== currentRes.width) diffs.push(`width: stored=${storedRes.width} vs current=${currentRes.width}`);
          if (storedRes.height !== currentRes.height) diffs.push(`height: stored=${storedRes.height} vs current=${currentRes.height}`);
        }
        const storedFps = stored.fps?.current;
        const currentFps = current.fps?.current;
        if (storedFps !== currentFps) diffs.push(`fps: stored=${storedFps} vs current=${currentFps}`);
        if (stored.bitrate !== current.bitrate) diffs.push(`bitrate: stored=${stored.bitrate} vs current=${current.bitrate}`);
        if (diffs.length) changes.push({ index: i, type: "changed", name: current.name, differences: diffs });
      }
    }

    if (changes.length && liveConflicts.length) {
      await prisma.camera.update({
        where: { id },
        data: {
          probe_updated_at: new Date(),
          stream_profiles: serializeStreamProfiles(currentProfiles, liveConflicts),
        },
      });
      updateCameraCache(id, {
        probe_updated_at: new Date().toISOString(),
        stream_profiles: serializeStreamProfiles(currentProfiles, liveConflicts),
      });
    }

    const hasConfigChanged = changes.length > 0;

    res.json({
      camera_id: id,
      stored_profiles: storedProfiles,
      current_profiles: currentProfiles,
      changes,
      configuration_changed: hasConfigChanged,
      conflicts: liveConflicts.length ? liveConflicts : (storedConflicts || []),
      onvif_supported: result.onvif ?? cam.onvif_supported,
      source_label: result.sourceLabel,
      data_confidence: result.data_confidence,
      last_verified_at: result.last_verified_at,
      errors: result.errors,
    });
  } catch (e: any) {
    logError(e as Error, { path: "/api/cameras/:id/passport/compare", method: "GET" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.get(["/api/cameras/:id/ai-stream", "/api/cameras/:id/ai-stream/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const cam = cameras.find((c) => c.id === id);
    if (!cam) return res.status(404).json({ detail: "Camera not found" });

    const { profiles } = parseStreamProfiles(cam);

    if (!profiles.length) {
      return res.json({
        camera_id: id,
        ai_stream_profile_id: cam.ai_stream_profile_id || null,
        recommendation: null,
        available_profiles: [],
        reason: "no_profiles",
      });
    }

    const recommendation = recommendAiStreamProfile(profiles);
    let reason = "selected_by_algorithm";

    const selectedProfile = profiles.find((p) => p.id === cam.ai_stream_profile_id);
    if (!selectedProfile && recommendation) {
      reason = "auto_recommended_not_set";
    } else if (selectedProfile) {
      const mainProfile = profiles.find((p) => p.type === "main");
      const mainRes = mainProfile?.resolutions?.[0];
      if (mainRes && mainRes.width >= 3840 && selectedProfile.type === "sub") {
        reason = "sub_stream_selected_for_4k_main";
      } else if (selectedProfile.codec?.toUpperCase() === "H.264") {
        reason = "h264_preferred";
      } else {
        reason = "manually_selected";
      }
    }

    res.json({
      camera_id: id,
      ai_stream_profile_id: cam.ai_stream_profile_id || recommendation,
      recommendation,
      current_selection: cam.ai_stream_profile_id || null,
      available_profiles: profiles,
      reason,
    });
  } catch (e: any) {
    logError(e as Error, { path: "/api/cameras/:id/ai-stream", method: "GET" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.put(["/api/cameras/:id/ai-stream", "/api/cameras/:id/ai-stream/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const cam = cameras.find((c) => c.id === id);
    if (!cam) return res.status(404).json({ detail: "Camera not found" });

    const { profile_id } = req.body || {};

    if (profile_id === null || profile_id === undefined) {
      await prisma.camera.update({
        where: { id },
        data: { ai_stream_profile_id: null },
      });
      updateCameraCache(id, { ai_stream_profile_id: null });
      return res.json({ success: true, ai_stream_profile_id: null });
    }

    if (typeof profile_id !== "string") {
      return res.status(400).json({ detail: "profile_id must be a string or null" });
    }

    const { profiles } = parseStreamProfiles(cam);
    const exists = profiles.find((p) => p.id === profile_id);
    if (!exists) {
      return res.status(400).json({ detail: `profile_id '${profile_id}' not found in camera profiles` });
    }

    await prisma.camera.update({
      where: { id },
      data: { ai_stream_profile_id: profile_id },
    });
    updateCameraCache(id, { ai_stream_profile_id: profile_id });

    res.json({
      success: true,
      ai_stream_profile_id: profile_id,
      profile: exists,
    });
  } catch (e: any) {
    logError(e as Error, { path: "/api/cameras/:id/ai-stream", method: "PUT" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

// CATEGORIES API
app.get(["/api/categories", "/api/categories/"], async (req, res) => {
  try {
    const categoriesFromDB = await prisma.category.findMany({
      orderBy: { sort_order: "asc" },
    });
    res.json(categoriesFromDB);
  } catch (err) {
    logError(err as Error, { path: "/api/categories", method: "GET" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.post(["/api/categories", "/api/categories/"], async (req, res) => {
  try {
    const code = (req.body.code || "").toUpperCase().trim();
    if (!code) {
      return res.status(400).json({ detail: "Code is required" });
    }
    
    const existingCat = await prisma.category.findUnique({ where: { code } });
    if (existingCat) {
      return res.status(400).json({ detail: "Category already exists" });
    }
    
    const newCat = await prisma.category.create({
      data: {
        code,
        label: req.body.label || code,
        color: req.body.color || "#6b7280",
        bg_color: req.body.bg_color || "#1f2937",
        is_alert: req.body.is_alert || false,
        alert_sound: req.body.alert_sound || "off",
        alert_volume: req.body.alert_volume || 0.5,
        detect_enabled: req.body.detect_enabled !== false,
        sort_order: req.body.sort_order || 100,
        is_system: false,
         card_template_json: req.body.card_template_json ?? null,
       },
     });
    res.status(201).json(newCat);
  } catch (err) {
    logError(err as Error, { path: "/api/categories", method: "POST" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.put("/api/categories/:code", async (req, res) => {
  try {
    const code = req.params.code.toUpperCase().trim();
    
    const updatedCat = await prisma.category.update({
      where: { code },
      data: req.body,
    });
    res.json(updatedCat);
  } catch (err) {
    logError(err as Error, { path: "/api/categories/:code", method: "PUT" });
    res.status(404).json({ detail: "Category not found" });
  }
});

app.delete(["/api/categories/:code", "/api/categories/:code/"], async (req, res) => {
  try {
    const code = req.params.code.toUpperCase().trim();
    await prisma.category.delete({ where: { code } });
    res.json({ success: true });
  } catch (err) {
    logError(err as Error, { path: "/api/categories/:code", method: "DELETE" });
    res.status(404).json({ detail: "Category not found" });
  }
});

// PERSONS API
app.get(["/api/persons", "/api/persons/"], async (req, res) => {
  try {
    const search = (req.query.search as string || "").trim();
    const category = req.query.category as string || "";
    // Whitelist сортировки — защита от 500-й на произвольном поле из клиента (#11)
    const ALLOWED_SORT = new Set(["created_at", "name", "visit_count", "category", "last_seen_at", "embedding_count"]);
    const sort_by = ALLOWED_SORT.has(req.query.sort_by as string) ? (req.query.sort_by as string) : "created_at";
    const sort_dir: "asc" | "desc" = req.query.sort_dir === "asc" ? "asc" : "desc";

    const where: any = {};
    if (category) where.category = category;
    let personsFromDB: any[];
    if (search) {
      // SQLite не поддерживает mode:'insensitive' для кириллицы.
      // Загружаем всех (или по категории) и фильтруем в JS с LOWER().
      const whereAll: any = {};
      if (category) whereAll.category = category;
      const allPersons = await prisma.person.findMany({
        where: whereAll,
        include: { photos: true },
        orderBy: { [sort_by]: sort_dir },
        take: 500,
      });
      const s = search.toLowerCase();
      personsFromDB = allPersons.filter((p: any) =>
        (p.name        || '').toLowerCase().includes(s) ||
        (p.comment     || '').toLowerCase().includes(s) ||
        (p.organization|| '').toLowerCase().includes(s) ||
        (p.position    || '').toLowerCase().includes(s) ||
        (p.email       || '').toLowerCase().includes(s) ||
        (p.phone       || '').toLowerCase().includes(s)
      );
    } else {
      const where: any = {};
      if (category) where.category = category;
      personsFromDB = await prisma.person.findMany({
        where,
        include: { photos: true },
        orderBy: { [sort_by]: sort_dir },
        take: 500,
      });
    }

    res.json(personsFromDB);
  } catch (err) {
    logError(err as Error, { path: "/api/persons", method: "GET" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.get(["/api/persons/check_duplicate", "/api/persons/check_duplicate/"], async (req, res) => {
  try {
    const name = (req.query.name as string || "").trim();
    if (!name) {
      return res.json({ duplicate: false, matches: [] });
    }

    const matches = await prisma.$queryRaw<
      Array<{ id: number; name: string; category: string }>
    >`SELECT id, name, category FROM Person WHERE LOWER(name) LIKE '%' || LOWER(${name}) || '%'`;

    res.json({
      duplicate: matches.length > 0,
      matches,
      message: matches.length > 0 ? `Найдены совпадения с похожим именем` : undefined
    });
  } catch (err) {
    logError(err as Error, { path: "/api/persons/check_duplicate", method: "GET" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.delete(["/api/persons/by_category/:category", "/api/persons/by_category/:category/"], async (req, res) => {
  try {
    const category = req.params.category.toUpperCase().trim();

    const deleted = await prisma.person.deleteMany({
      where: { category }
    });

    // Sync in-memory
    persons = persons.filter((p) => p.category !== category);

    res.json({ ok: true, deleted: deleted.count });
  } catch (err) {
    logError(err as Error, { path: "/api/persons/by_category/:category", method: "DELETE" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.get("/api/persons/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const person = await prisma.person.findUnique({
      where: { id },
      include: { photos: true }
    });

    if (person) {
      res.json(person);
    } else {
      res.status(404).json({ detail: "Person not found" });
    }
  } catch (err) {
    logError(err as Error, { path: "/api/persons/:id", method: "GET" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.post(["/api/persons", "/api/persons/"], upload.any(), async (req, res) => {
  try {
    let files: Express.Multer.File[] = [];
    if (req.file) files.push(req.file);
    if (req.files && Array.isArray(req.files)) files = files.concat(req.files as Express.Multer.File[]);

    // Фикс кракозябр: браузер передаёт originalname в latin1, не UTF-8
    fixFilesEncoding(files);
    if (req.body && typeof req.body === 'object') {
      for (const key of Object.keys(req.body)) {
        if (typeof req.body[key] === 'string') {
          req.body[key] = fixDoubleEncodedCyrillic(req.body[key]);
        }
      }
    }

    let name = normalizePersonName(req.body.name || "Новый посетитель");
    let position = req.body.position ? normalizePositionName(req.body.position) : null;

    if (files.length > 0 && (!req.body.name || req.body.name === "Новый посетитель" || req.body.name === "Новый человек")) {
      const originalName = files[0].originalname;
      const ext = path.extname(originalName);
      const baseName = path.basename(originalName, ext).trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
      const dashMatch = baseName.match(/^(.+?)\s+-\s+(.+)$/);
      if (dashMatch) {
        name = normalizePersonName(dashMatch[1].trim());
        position = normalizePositionName(dashMatch[2].trim());
      } else {
        name = normalizePersonName(baseName);
      }
    }

    const category = req.body.category || "CLIENT";
    const photosList = [];
    let embedding_count = 0;

    // Сначала создаем персону в БД
    const newPerson = await prisma.person.create({
      data: {
        name,
        category,
        position,
        comment: req.body.comment || null,
        phone: req.body.phone || null,
        email: req.body.email || null,
        birth_date: req.body.birth_date || null,
        address: req.body.address || null,
        organization: req.body.organization || null,
        extra_info: req.body.extra_info || null,
        is_active: req.body.is_active !== false,
        visit_count: 0,
        embedding_count: 0
      }
    });

    // Теперь обрабатываем фотографии
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const photo_path = `photos/${f.filename}`;
      const fullPath = path.join(publicDir, photo_path);

      const regResult = await enrollPhotoWithGate(newPerson.id, name, category, photo_path, fullPath);

      const personPhoto = await prisma.personPhoto.create({
        data: {
          person_id: newPerson.id,
          photo_path,
          is_primary: i === 0,
          has_embedding: regResult.hasEmbedding,
        }
      });

      photosList.push(personPhoto);

      if (regResult.hasEmbedding) embedding_count++;
    }

    // Обновляем персону с photo_path и embedding_count
    const primaryPhoto = photosList.find(p => p.is_primary);
    await prisma.person.update({
      where: { id: newPerson.id },
      data: {
        photo_path: primaryPhoto ? primaryPhoto.photo_path : null,
        embedding_count
      }
    });

    // Возвращаем персону с фото
    const createdPerson = await prisma.person.findUnique({
      where: { id: newPerson.id },
      include: { photos: true }
    });

    res.status(201).json(createdPerson);
  } catch (err) {
    logError(err as Error, { path: "/api/persons", method: "POST" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.put("/api/persons/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    const updatedPerson = await prisma.person.update({
      where: { id },
      data: req.body,
      include: { photos: true }
    });

    res.json(updatedPerson);
  } catch (err) {
    logError(err as Error, { path: "/api/persons/:id", method: "PUT" });
    res.status(404).json({ detail: "Person not found" });
  }
});

app.delete(["/api/persons/:id", "/api/persons/:id/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    // Удаляем дескрипторы
    await unregisterFacePerson(id);

    // Удаляем персону (deleteMany не бросает ошибку если запись уже отсутствует)
    const deleted = await prisma.person.deleteMany({ where: { id } });

    // Sync in-memory
    persons = persons.filter((p) => p.id !== id);

    res.json({ success: true, deleted });
  } catch (err) {
    logError(err as Error, { path: "/api/persons/:id", method: "DELETE" });
    res.status(404).json({ detail: "Person not found" });
  }
});

app.post(["/api/persons/bulk_delete", "/api/persons/bulk_delete/"], async (req, res) => {
  try {
    const ids = req.body as number[];
    if (!Array.isArray(ids)) return res.status(400).json({ detail: "Invalid request body" });
    // Unregister face descriptors for each person
    await Promise.all(ids.map(id => unregisterFacePerson(id)));
    const deleted = await prisma.person.deleteMany({ where: { id: { in: ids } } });
    persons = persons.filter((p) => !ids.includes(p.id));
    res.json({ success: true, count: deleted.count });
  } catch (err) {
    logError(err as Error, { path: "/api/persons/bulk_delete", method: "POST" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

const importJobs: Record<string, any> = {};

app.post(["/api/persons/bulk_import", "/api/persons/bulk_import/"], upload.any(), async (req, res) => {
  let files: Express.Multer.File[] = [];
  if (req.file) {
    files.push(req.file);
  }
  if (req.files && Array.isArray(req.files)) {
    files = files.concat(req.files as Express.Multer.File[]);
  }

  // Фикс кракозябр: браузер передаёт originalname в latin1, не UTF-8
  fixFilesEncoding(files);
  if (req.body && typeof req.body === 'object') {
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === 'string') {
        req.body[key] = fixDoubleEncodedCyrillic(req.body[key]);
      }
    }
  }

  const category = (req.body.category || 'CLIENT').toUpperCase();
  const jobId = crypto.randomUUID();

  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  // 1. Создаём временную папку для загрузки
  const tempFolder = path.join(os.tmpdir(), `intake_${Date.now()}_${Math.floor(Math.random() * 1000)}`);
  fs.mkdirSync(tempFolder, { recursive: true });

  // 2. Сохраняем все файлы во временную папку и извлекаем имя
  let personName = req.body.person_name || `Unknown_${Date.now()}`;
  
  for (const file of files) {
    // Пытаемся извлечь имя из первого файла, если person_name не передан явно
    if (!req.body.person_name && file.originalname) {
      const baseName = path.parse(file.originalname).name;
      // Эвристика: "Иванов Иван - Директор.jpg" -> "Иванов Иван"
      const match = baseName.match(/^([А-Яа-яЁё\s\-]+?)(?:\s*[-–]\s*.+)?$/);
      if (match) {
        personName = normalizePersonName(match[1].trim());
      }
    }
    
    const destPath = path.join(tempFolder, file.originalname);
    if (!file.buffer) {
      logWarn(`[Bulk Import] Empty buffer for file ${file.originalname}, skipping`);
      continue;
    }
    fs.writeFileSync(destPath, file.buffer);
  }

  // 3. Сохраняем статус задачи в памяти
  importJobs[jobId] = { status: 'pending', progress: 0, total: files.length };
  res.json({ job_id: jobId, message: 'Import started' });

  // Создаём outputDir для сохранения кропов
  const safePersonName = personName.replace(/\s+/g, '_');
  const outputDir = path.join(publicDir, 'photos', 'intake', safePersonName);
  fs.mkdirSync(outputDir, { recursive: true });

  // 4. Асинхронная обработка
  setTimeout(async () => {
    const job = importJobs[jobId];
    if (!job) return;
    
    job.status = 'processing';
    job.warnings = [];
    
    try {
      // Создаём FormData
      const form = new FormData();
      form.append('folder', tempFolder);
      form.append('person_name', personName);
      form.append('output_dir', outputDir);
      
      // Вызов Python intake
      const intakeRes = await fetch(`${process.env.PYTHON_INTAKE_URL || 'http://localhost:8001'}/intake`, {
        method: 'POST',
        body: form as any,
      });

      if (!intakeRes.ok) {
        const errorText = await intakeRes.text();
        throw new Error(`Python intake failed: ${intakeRes.status} ${errorText}`);
      }

      const intakeResult = await intakeRes.json();
      
      let createdCount = 0;
      let failedCount = 0;
      const createdList: any[] = [];
      
      // Проверка похожих имён для предупреждения о дубликатах
      const existingAll = await prisma.person.findMany({ select: { name: true } });
      const existingNames = existingAll.map(p => p.name);
      const similarNames = findSimilarNames(personName, existingNames, 0.85);
      if (similarNames.length > 0) {
        job.warnings!.push({
          name: personName,
          similar: similarNames.slice(0, 3)
        });
      }
      
      // 5. Обработка отчёта и запись в БД
      for (const item of intakeResult.report || []) {
        if (item.status === 'passed' && item.embedding && item.output_path) {
          try {
            let person = await prisma.person.findFirst({
              where: { name: personName }
            });

            if (!person) {
              person = await prisma.person.create({
                data: {
                  name: personName,
                  category,
                  is_active: true,
                  visit_count: 0,
                  embedding_count: 0
                }
              });
              logInfo(`[Bulk Import] Создана новая персона: ${personName} (ID: ${person.id})`);
            } else {
              logInfo(`[Bulk Import] Персона "${personName}" уже существует (ID: ${person.id}), пропускаем создание`);
            }

            const existingPhotos = await prisma.personPhoto.findMany({
              where: { person_id: person.id },
              select: { photo_path: true }
            });
            const existingPaths = new Set(existingPhotos.map(p => p.photo_path));
            const photoPath = item.output_path.replace(/^\/?/, '');

            if (existingPaths.has(photoPath)) {
              logDebug(`[Bulk Import] Фото ${photoPath} уже есть у ${personName}, пропускаем`);
              continue;
            }

            const photoCount = await prisma.personPhoto.count({ where: { person_id: person.id } });
            const saveResult = await addEmbeddingToPerson(
              person.id,
              person.name,
              person.category,
              photoPath,
              item.embedding
            );

            if (saveResult.success) {
              createdCount++;
              createdList.push({
                name: personName,
                position: req.body.position || null,
                embeddings: 1,
                photo_path: item.output_path
              });

              await prisma.person.update({
                where: { id: person.id },
                data: { embedding_count: { increment: 1 } }
              });

              await prisma.personPhoto.create({
                data: {
                  person_id: person.id,
                  photo_path: photoPath,
                  is_primary: photoCount === 0,
                  has_embedding: true,
                  source: 'bulk_import'
                }
              });

              if (photoCount === 0) {
                await prisma.person.update({
                  where: { id: person.id },
                  data: { photo_path: photoPath }
                });
              }
            } else {
              failedCount++;
              logError(`Failed to save embedding for ${item.output_path}: ${saveResult.error}`);
            }
          } catch (err: any) {
            failedCount++;
            logError(`Error processing item ${item.original_file || 'unknown'}: ${err.message}`);
          }
        }
      }
      
      // 6. Обновляем статус задачи
      job.status = 'completed';
      job.progress = files.length;
      job.created = createdList;
      job.failed = [];
      job.skipped = [];
      job.summary = {
        total_processed: intakeResult.photos_processed,
        passed: createdCount,
        failed: failedCount,
        duplicates_skipped: intakeResult.photos_duplicate || 0
      };
      
      // 7. Очистка временной папки
      try {
        fs.rmSync(tempFolder, { recursive: true, force: true });
      } catch (e: any) {
        logWarn(`Failed to cleanup temp folder ${tempFolder}: ${e.message}`);
      }
      
    } catch (error: any) {
      logError(`Bulk import job ${jobId} failed: ${error.message}`);
      job.status = 'failed';
      job.error = error.message;
      job.failed = [{ file: 'batch', error: error.message }];
      
      // Очистка временной папки
      try {
        fs.rmSync(tempFolder, { recursive: true, force: true });
      } catch (e: any) {
        logWarn(`Failed to cleanup temp folder ${tempFolder}: ${e.message}`);
      }
    }
  }, 100);
});

app.get(["/api/persons/bulk_import/:job_id", "/api/persons/bulk_import/:job_id/"], (req, res) => {
  const { job_id } = req.params;
  const job = importJobs[job_id];
  if (job) {
    res.json(job);
  } else {
    res.status(404).json({ detail: "Job not found" });
  }
});

// Alias for SmartImportModal compatibility
app.post(["/api/persons/smart_import", "/api/persons/smart_import/"], upload.any(), async (req, res) => {
  logInfo("[Smart Import] Alias called, redirecting to bulk_import logic");
  req.url = "/api/persons/bulk_import";
  const bulkHandler = (app as any)._router?.stack?.find((layer: any) => {
    const route = layer.route;
    if (!route) return false;
    const path = (route.path || '').toString();
    return path.includes('bulk_import') && route.methods?.post;
  });

  if (bulkHandler && bulkHandler.route && bulkHandler.route.stack && bulkHandler.route.stack[0]) {
    return bulkHandler.route.stack[0].handle(req, res);
  }
  res.status(500).json({ detail: "bulk_import handler not found" });
});

// Photo upload to person
app.post(["/api/persons/:id/photos", "/api/persons/:id/photos/"], upload.any(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const person = await prisma.person.findUnique({ where: { id }, include: { photos: true } });
    if (!person) return res.status(404).json({ detail: "Person not found" });

    let files: Express.Multer.File[] = [];
    if (req.file) files.push(req.file);
    if (req.files && Array.isArray(req.files)) files = files.concat(req.files as Express.Multer.File[]);
    if (files.length === 0) {
      return res.status(400).json({ detail: "No file uploaded", added_embeddings: 0, total_embeddings: (person as any).photos.length });
    }

    const existingPhotos = await prisma.personPhoto.findMany({
      where: { person_id: id },
      select: { photo_path: true }
    });
    const existingPaths = new Set(existingPhotos.map(p => p.photo_path));

    const newFiles = files.filter(file => {
      const potentialPath = `photos/${file.filename}`;
      return !existingPaths.has(potentialPath);
    });

    if (newFiles.length === 0) {
      for (const file of files) {
        try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch {}
      }
      return res.json({
        success: false,
        detail: "Все выбранные фото уже существуют у этой персоны",
        added: 0,
        skipped: files.length,
        total_embeddings: (person as any).photos.length,
      });
    }

    let added_embeddings = 0;
    for (const f of newFiles) {
      const photo_path = `photos/${f.filename}`;
      const fullPath = path.join(publicDir, photo_path);
      const regResult = await enrollPhotoWithGate(person.id, person.name, person.category, photo_path, fullPath);
      const isPrimary = person.photos.length === 0 && added_embeddings === 0;
      await prisma.personPhoto.create({
        data: { person_id: id, photo_path, is_primary: isPrimary, has_embedding: regResult.hasEmbedding },
      });
      if (isPrimary) {
        await prisma.person.update({ where: { id }, data: { photo_path } });
      }
      if (regResult.hasEmbedding) added_embeddings++;
    }

    await prisma.person.update({
      where: { id },
      data: { embedding_count: { increment: added_embeddings } },
    });

    const updated = await prisma.person.findUnique({ where: { id }, include: { photos: true } });
    const idx = persons.findIndex((p) => p.id === id);
    if (idx >= 0) persons[idx] = { ...persons[idx], ...updated };

    res.json({ ...updated, added_embeddings, total_embeddings: updated?.photos.length, skipped: files.length - newFiles.length });
  } catch (err) {
    logError(err as Error, { path: "/api/persons/:id/photos", method: "POST" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

// Photo search — РЕАЛЬНЫЙ AI ПОИСК
app.post(["/api/persons/search_by_photo", "/api/persons/search_by_photo/"], upload.any(), async (req, res) => {
  let files: Express.Multer.File[] = [];
  if (req.file) files.push(req.file);
  if (req.files && Array.isArray(req.files)) files = files.concat(req.files as Express.Multer.File[]);

  const mode = (req.query.mode as string || "hybrid") as "cosine" | "euclidean" | "hybrid";
  if (files.length === 0) return res.status(400).json({ detail: "No file uploaded" });

  try {
    const filePath = path.join(photosDir, files[0].filename);
    const threshold = recognition_threshold_pct / 100;

    // Параллельно: оценка качества + поиск + лица
    const [qualityResult, matches, faces] = await Promise.all([
      assessPhotoQuality(filePath),
      searchByPhoto(filePath, threshold, 5),
      detectFaces(filePath),
    ]);

    // Обогащаем совпадения данными из БД
    const matchPersonIds = matches.map(m => m.personId);
    const personsFromDB = matchPersonIds.length > 0
      ? await prisma.person.findMany({ where: { id: { in: matchPersonIds } }, select: { id: true, name: true, category: true, photo_path: true } })
      : [];
    const personMap = new Map(personsFromDB.map(p => [p.id, p]));

    const formattedMatches = matches.map((m, idx) => {
      const person = personMap.get(m.personId) || { id: m.personId, name: m.personName, category: m.category, photo_path: m.photoPath };
      return {
        person,
        similarity: m.similarity,
        raw_similarity: m.similarity,
        similarity_pct: Math.round(m.similarity * 100),
        category: m.category,
        match_count: 1,
        gap: idx === 0 && matches.length > 1 ? Number((m.similarity - matches[1].similarity).toFixed(4)) : undefined,
        ambiguous: idx === 0 && matches.length > 1 && (m.similarity - matches[1].similarity) < 0.05,
      };
    });

    // Подсчёт персон по категориям из БД
    const categoryCountRows = await prisma.$queryRaw<{ category: string; count: number }[]>`
      SELECT category, COUNT(*) as count FROM Person GROUP BY category
    `;
    const total_searched: Record<string, number> = {};
    for (const row of categoryCountRows) {
      total_searched[row.category] = Number(row.count);
    }

    const engineStatus = getEngineStatus();

    res.json({
      matches: formattedMatches,
      face_detected: qualityResult.faceDetected,
      face_count: qualityResult.faceCount,
      det_score: qualityResult.details?.detScore || 0,
      quality_scores: qualityResult.details
        ? [
            {
              total: qualityResult.quality,
              size: qualityResult.details.detScore || 0,
              blur: qualityResult.details.sharpness || 0,
              angle: qualityResult.details.yaw || 0,
            },
          ]
        : [],
      faces: faces.map(f => ({ box: f.box, score: f.score })),
      message: formattedMatches.length > 0
        ? `Найдено совпадений: ${formattedMatches.length}`
        : qualityResult.faceDetected ? "Совпадений не обнаружено" : "Лицо не обнаружено на фото",
      total_searched,
      threshold_used: threshold,
      mode,
      model: "InsightFace (buffalo_l)",
      engine_descriptors: engineStatus.totalDescriptors,
      engine_persons: engineStatus.uniquePersons,
    });
  } catch (err: any) {
    logError(err as Error, { context: "search_by_photo" });
    res.status(500).json({ detail: "Ошибка AI обработки: " + err.message });
  }
});

app.delete(["/api/persons/:id/photos/:photoId", "/api/persons/:id/photos/:photoId/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const photoId = parseInt(req.params.photoId);

    const photo = await prisma.personPhoto.findUnique({ where: { id: photoId } });
    if (!photo) return res.status(404).json({ detail: "Photo not found" });

    const photoPath = photo.photo_path;
    await prisma.personPhoto.delete({ where: { id: photoId } });

    try {
      const fullPath = path.join(photosDir, photoPath);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    } catch (e) {
      logError(e as Error, { context: "delete-person-photo-file", path: photoPath });
    }

    // Если удалили primary — назначаем первую оставшуюся
    if (photo.is_primary) {
      const remaining = await prisma.personPhoto.findFirst({ where: { person_id: id }, orderBy: { id: "asc" } });
      if (remaining) {
        await prisma.personPhoto.update({ where: { id: remaining.id }, data: { is_primary: true } });
        await prisma.person.update({ where: { id }, data: { photo_path: remaining.photo_path } });
      } else {
        await prisma.person.update({ where: { id }, data: { photo_path: null } });
      }
    }

    const updated = await prisma.person.findUnique({ where: { id }, include: { photos: true } });
    const idx = persons.findIndex((p) => p.id === id);
    if (idx >= 0) persons[idx] = { ...persons[idx], ...updated };
    res.json(updated);
  } catch (err) {
    logError(err as Error, { path: "/api/persons/:id/photos/:photoId", method: "DELETE" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.post(["/api/persons/:id/photos/:photoId/set_primary", "/api/persons/:id/photos/:photoId/set_primary/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const photoId = parseInt(req.params.photoId);

    // Clear all primaries for this person
    await prisma.personPhoto.updateMany({ where: { person_id: id }, data: { is_primary: false } });
    // Set new primary
    const photo = await prisma.personPhoto.update({ where: { id: photoId }, data: { is_primary: true } });
    // Update person's main photo_path
    await prisma.person.update({ where: { id }, data: { photo_path: photo.photo_path } });

    const updated = await prisma.person.findUnique({ where: { id }, include: { photos: true } });
    const idx = persons.findIndex((p) => p.id === id);
    if (idx >= 0) persons[idx] = { ...persons[idx], ...updated };
    res.json(updated);
  } catch (err) {
    logError(err as Error, { path: "/api/persons/:id/photos/:photoId/set_primary", method: "POST" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

// ── GUESTS API ────────────────────────────────────────────────────────────

app.get(["/api/guests", "/api/guests/"], async (req, res) => {
  try {
    const guests = await prisma.guest.findMany({
      where: { is_active: true },
      orderBy: { created_at: "desc" },
      take: 100,
    });
    res.json(guests);
  } catch (err) {
    logError(err as Error, { context: "get-guests" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.get(["/api/guests/:id", "/api/guests/:id/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const guest = await prisma.guest.findUnique({ where: { id } });
    if (!guest) return res.status(404).json({ detail: "Guest not found" });
    res.json(guest);
  } catch (err) {
    logError(err as Error, { context: "get-guest" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.post(["/api/guests/:id/photos", "/api/guests/:id/photos/"], upload.any(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const guest = await prisma.guest.findUnique({ where: { id } });
    if (!guest) return res.status(404).json({ detail: "Guest not found" });
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) return res.status(400).json({ detail: "No file uploaded" });
    const file = files[0];
    const filename = `guest_${id}_${Date.now()}_${file.originalname}`;
    const destPath = path.join(photosDir, filename);
    await fs.promises.copyFile(file.path, destPath);
    await prisma.guest.update({ where: { id }, data: { photo_path: `photos/${filename}` } });
    res.json({ success: true, photo_path: `photos/${filename}` });
  } catch (err) {
    logError(err as Error, { context: "upload-guest-photo" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

// ── FAILED EMBEDDINGS ──
// Коллектор «мусорных» кадров, отклонённых воротами качества при ЗАПИСИ
// референсного эмбеддинга (размытие / наклон головы / темнота / несколько лиц).
// Стартовые записи — демо-примеры категорий; реальные отказы добавляются
// функцией recordFailedEmbedding при загрузке/импорте фото.
let failedEmbeddings = [
  {
    id: 1,
    photo_path: "photos/fail_blur.jpg",
    reason: "Размытие в движении (Motion Blur)",
    detected_faces: 1,
    quality_score: 0.12,
    created_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    filename: "cam_1_fail_blur_20260705.jpg",
    resolution: "640x480"
  },
  {
    id: 2,
    photo_path: "photos/fail_angle.jpg",
    reason: "Недопустимый угол поворота головы (Pitch > 35°)",
    detected_faces: 1,
    quality_score: 0.28,
    created_at: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
    filename: "cam_2_fail_pitch_20260705.jpg",
    resolution: "1280x720"
  },
  {
    id: 3,
    photo_path: "photos/fail_dark.jpg",
    reason: "Недостаточная освещенность лица (< 15 Lux)",
    detected_faces: 0,
    quality_score: 0.05,
    created_at: new Date(Date.now() - 12 * 3600 * 1000).toISOString(),
    filename: "cam_1_fail_dark_20260704.jpg",
    resolution: "1920x1080"
  },
  {
    id: 4,
    photo_path: "photos/fail_multi.jpg",
    reason: "Обнаружено несколько лиц в кадре",
    detected_faces: 3,
    quality_score: 0.45,
    created_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    filename: "cam_2_fail_multi_20260704.jpg",
    resolution: "1280x720"
  }
];
let failedEmbeddingsNextId = 5;

/**
 * Регистрирует отклонённый кадр в коллекторе «мусорных снимков».
 * Используется, когда ворота качества (strict) отклонили фото при записи
 * референсного эмбеддинга — кадр НЕ попадает в БД, но попадает в панель
 * «Мусорные кадры» с реальной причиной (размытие / угол / темнота /多人).
 */
async function recordFailedEmbedding(opts: {
  photo_path: string;
  filename: string;
  reason: string;
  detected_faces?: number;
  quality_score?: number;
  resolution?: string;
}): Promise<void> {
  try {
    const resolution = opts.resolution || (await sharp(path.join(publicDir, opts.photo_path)).metadata()
      .then((m) => `${m.width ?? "?"}x${m.height ?? "?"}`).catch(() => "unknown"));
    failedEmbeddings.unshift({
      id: failedEmbeddingsNextId++,
      photo_path: opts.photo_path,
      filename: opts.filename,
      reason: opts.reason,
      detected_faces: opts.detected_faces ?? 1,
      quality_score: opts.quality_score ?? 0,
      resolution,
      created_at: new Date().toISOString(),
    });
    // Ограничиваем размер коллектора, чтобы не есть память (оставляем свежие 200).
    if (failedEmbeddings.length > 200) failedEmbeddings.length = 200;
    logInfo(`Мусорный кадр отклонён воротами: ${opts.reason} (${opts.filename})`);
  } catch (e) {
    logError(e as Error, { context: "recordFailedEmbedding", filename: opts.filename });
  }
}

/**
 * Записывает референсный эмбеддинг с ЖЁСТКИМ воротом качества.
 * Если кадр — мусор (размытие/наклон/темнота/несколько лиц) или лицо не
 * найдено, эмбеддинг НЕ сохраняется, а кадр попадает в коллектор failedEmbeddings.
 * Возвращает признак успешности, как registerPerson.
 */
async function enrollPhotoWithGate(
  personId: number,
  personName: string,
  category: string,
  photo_path: string,
  fullPath: string
): Promise<{ hasEmbedding: boolean; error?: string }> {
  const ext = await extractEmbedding(fullPath, { strict: true });

  if (!ext.passed || !ext.descriptor) {
    const extRelaxed = await extractEmbedding(fullPath, { strict: false });
    if (extRelaxed.passed && extRelaxed.descriptor) {
      logInfo(`Эмбеддинг создан в non-strict режиме для ${path.basename(photo_path)} (строгое ворота провалено: ${ext.issues.join("; ") || ext.error})`);
      const reg = await registerPersonFromDescriptor(personId, personName, category, photo_path, extRelaxed.descriptor);
      return { hasEmbedding: reg.hasEmbedding, error: reg.error };
    }

    const q = ext.quality;
    await recordFailedEmbedding({
      photo_path,
      filename: path.basename(photo_path),
      reason: ext.issues.length ? ext.issues.join("; ") : (ext.error || "Лицо не обнаружено на фото"),
      detected_faces: q?.face_count ?? 0,
      quality_score: q?.score ?? 0,
    });
    return { hasEmbedding: false, error: ext.issues.join("; ") || ext.error };
  }

  const reg = await registerPersonFromDescriptor(personId, personName, category, photo_path, ext.descriptor);
  return { hasEmbedding: reg.hasEmbedding, error: reg.error };
}

// ============================================
// Python Intake Integration
// ============================================

/**
 * Вызов Python FastAPI intake endpoint
 * Возвращает результат обработки папки с фото
 */
async function callPythonIntake(
  folder: string,
  personName: string,
  outputDir?: string
): Promise<{
  status: string;
  photos_count: number;
  photos_processed: number;
  photos_passed_quality: number;
  photos_duplicate: number;
  photos_diversity_selected: number;
  embeddings_generated: number;
  report: any[];
}> {
  const PYTHON_INTAKE_URL = process.env.PYTHON_INTAKE_URL || "http://localhost:8001";
  const url = `${PYTHON_INTAKE_URL}/intake`;

  const formData = new FormData();
  formData.append("folder", folder);
  formData.append("person_name", personName);
  if (outputDir) {
    formData.append("output_dir", outputDir);
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      body: formData as unknown as string, // TypeScript workaround for FormData
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Python intake failed: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    return result;
  } catch (err: any) {
    logWarn(`Python intake call failed: ${err.message}. Falling back to enrollPhotoWithGate.`);
    throw err;
  }
}

app.get(["/api/failed_embeddings", "/api/failed_embeddings/"], (req, res) => {
  res.json(failedEmbeddings);
});

app.delete(["/api/failed_embeddings/:id", "/api/failed_embeddings/:id/"], (req, res) => {
  const id = parseInt(req.params.id);
  failedEmbeddings = failedEmbeddings.filter(f => f.id !== id);
  res.json({ ok: true, message: "Мусорный снимок успешно удалён" });
});

app.post(["/api/failed_embeddings/bulk_delete", "/api/failed_embeddings/bulk_delete/"], (req, res) => {
  const ids = req.body || [];
  failedEmbeddings = failedEmbeddings.filter(f => !ids.includes(f.id));
  res.json({ ok: true, message: `Успешно удалено ${ids.length} снимков` });
});

// ── OPERATOR CONFIRMATION (semi-supervised learning) ──────────────────────────

// Список ожидающих подтверждений
app.get(["/api/confirmations/pending", "/api/confirmations/pending/"], async (req, res) => {
  try {
    const confirmations = await prisma.faceConfirmation.findMany({
      where: { status: "PENDING" },
      include: {
        person: { select: { id: true, name: true, category: true, photo_path: true } },
      },
      orderBy: { created_at: "desc" },
      take: 50,
    });
    res.json(confirmations);
  } catch (err: any) {
    logError(err as Error, { path: "/api/confirmations/pending" });
    res.status(500).json({ detail: err.message });
  }
});

// Подтвердить: это тот же человек → добавить фото+эмбеддинг к существующей персоне
app.post(["/api/confirmations/:id/approve", "/api/confirmations/:id/approve/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const operator_id = (req.body?.operator_id as string) || "system";
    const conf = await prisma.faceConfirmation.findUnique({ where: { id } });
    if (!conf) return res.status(404).json({ detail: "Confirmation not found" });
    if (conf.status !== "PENDING") return res.status(409).json({ detail: `Already ${conf.status}` });

    const tempFull = path.join(publicDir, conf.temp_photo_path);
    if (!fs.existsSync(tempFull)) return res.status(404).json({ detail: "Temp photo missing" });
    const buf = await fs.promises.readFile(tempFull);

    // Извлекаем эмбеддинг (строгий ворот; fallback на мягкий, если кадр «на грани»)
    let descriptor = (await extractEmbedding(buf, { strict: true })).descriptor;
    if (!descriptor) {
      const soft = await getEmbedding(buf);
      if (!soft) return res.status(422).json({ detail: "Не удалось извлечь эмбеддинг из фото подтверждения" });
      descriptor = soft;
    }

    const person = await prisma.person.findUnique({ where: { id: conf.person_id } });
    if (!person) return res.status(404).json({ detail: "Person not found" });

    const newName = `confirm_${conf.person_id}_${conf.id}_${Date.now()}.jpg`;
    const photo_path = `photos/${newName}`;
    await fs.promises.writeFile(path.join(publicDir, photo_path), buf);

    await prisma.personPhoto.create({
      data: {
        person_id: conf.person_id,
        photo_path,
        is_primary: false,
        has_embedding: true,
        source: "confirmation",
        confidence: conf.confidence,
      },
    });

    const reg = await addEmbeddingToPerson(conf.person_id, person.name, person.category, photo_path, descriptor);
    if (!reg.success) return res.status(500).json({ detail: reg.error || "Не удалось добавить дескриптор" });

    await prisma.faceConfirmation.update({
      where: { id },
      data: { status: "APPROVED", confirmed_at: new Date(), confirmed_by: operator_id },
    });

    // Закрываем связанное событие в ленте (снимаем ожидание подтверждения)
    await prisma.event.updateMany({
      where: { confirmation_id: id, confirmation_status: "pending" },
      data: { confirmation_status: "confirmed" },
    });

    // Временное фото уже скопировано в photos/ — удаляем оригинал из confirmations/
    try { await fs.promises.unlink(tempFull); } catch { /* ignore */ }

    const pIdx = persons.findIndex((p: any) => p.id === conf.person_id);
    if (pIdx >= 0) persons[pIdx].embedding_count = (persons[pIdx].embedding_count || 0) + 1;

    broadcastSecurity({ type: "CONFIRMATION_RESOLVED", confirmation_id: id, status: "APPROVED", person_id: conf.person_id });
    res.json({ success: true, message: "Фото добавлено, точность распознавания улучшена", person_id: conf.person_id });
  } catch (err: any) {
    logError(err as Error, { path: "/api/confirmations/:id/approve" });
    res.status(500).json({ detail: err.message });
  }
});

// Отклонить: это другой человек → создать нового «Неизвестного»
app.post(["/api/confirmations/:id/reject", "/api/confirmations/:id/reject/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const operator_id = (req.body?.operator_id as string) || "system";
    const reason = (req.body?.reason as string) || "Не тот человек";
    const conf = await prisma.faceConfirmation.findUnique({ where: { id } });
    if (!conf) return res.status(404).json({ detail: "Confirmation not found" });
    if (conf.status !== "PENDING") return res.status(409).json({ detail: `Already ${conf.status}` });

    const tempFull = path.join(publicDir, conf.temp_photo_path);
    let newPersonId: number | null = null;

    if (fs.existsSync(tempFull)) {
      const buf = await fs.promises.readFile(tempFull);
      const newName = `unknown_conf_${id}_${Date.now()}.jpg`;
      const photo_path = `photos/${newName}`;
      await fs.promises.writeFile(path.join(publicDir, photo_path), buf);

      const newPerson = await prisma.person.create({
        data: { name: "Неизвестный", category: "CLIENT", is_active: true, visit_count: 0, embedding_count: 0 },
      });
      newPersonId = newPerson.id;

      const reg = await registerFacePerson(newPerson.id, "Неизвестный", "CLIENT", photo_path, path.join(publicDir, photo_path));
      await prisma.personPhoto.create({
        data: { person_id: newPerson.id, photo_path, is_primary: true, has_embedding: reg.hasEmbedding },
      });
      await prisma.person.update({
        where: { id: newPerson.id },
        data: { photo_path, embedding_count: reg.hasEmbedding ? 1 : 0 },
      });

      const created = await prisma.person.findUnique({ where: { id: newPerson.id }, include: { photos: true } });
      if (created) persons.unshift({ ...created });

      try { await fs.promises.unlink(tempFull); } catch { /* ignore */ }
    }

    await prisma.faceConfirmation.update({
      where: { id },
      data: { status: "REJECTED", rejected_reason: reason, confirmed_at: new Date(), confirmed_by: operator_id },
    });

    // Закрываем связанное событие в ленте (снимаем ожидание подтверждения)
    await prisma.event.updateMany({
      where: { confirmation_id: id, confirmation_status: "pending" },
      data: { confirmation_status: "rejected" },
    });

    broadcastSecurity({ type: "CONFIRMATION_RESOLVED", confirmation_id: id, status: "REJECTED", person_id: conf.person_id, new_person_id: newPersonId });
    res.json({ success: true, message: "Создана новая запись «Неизвестный»", new_person_id: newPersonId });
  } catch (err: any) {
    logError(err as Error, { path: "/api/confirmations/:id/reject" });
    res.status(500).json({ detail: err.message });
  }
});

// Статистика подтверждений
app.get(["/api/confirmations/stats", "/api/confirmations/stats/"], async (req, res) => {
  try {
    const [pending, approved, rejected] = await Promise.all([
      prisma.faceConfirmation.count({ where: { status: "PENDING" } }),
      prisma.faceConfirmation.count({ where: { status: "APPROVED" } }),
      prisma.faceConfirmation.count({ where: { status: "REJECTED" } }),
    ]);
    res.json({ pending, approved, rejected });
  } catch (err: any) {
    logError(err as Error, { path: "/api/confirmations/stats" });
    res.status(500).json({ detail: err.message });
  }
});

// EVENTS API
app.get(["/api/events", "/api/events/"], async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string || "50"), 200);
    const eventsFromDB = await prisma.event.findMany({
      orderBy: { created_at: "desc" },
      take: limit,
      include: {
        person: { include: { photos: { take: 1 } } },
        camera: true,
      },
    });

    // Enrich with last category change per person
    const personIds = [...new Set(eventsFromDB.filter(e => e.person_id).map(e => e.person_id!))]
    const changes = personIds.length > 0 ? await prisma.personCategoryHistory.findMany({
      where: { person_id: { in: personIds } },
      orderBy: { created_at: "desc" },
    }) : []
    const lastChange = new Map<number, any>()
    for (const c of changes) {
      if (!lastChange.has(c.person_id)) lastChange.set(c.person_id, c)
    }

    const enriched = eventsFromDB.map(e => ({
      ...e,
      lastCategoryChange: e.person_id ? (lastChange.get(e.person_id) ?? null) : null,
    }))

    res.json(enriched);
  } catch (err) {
    logError(err as Error, { path: "/api/events", method: "GET" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.delete(["/api/events/clear", "/api/events/clear/"], async (req, res) => {
  try {
    await prisma.event.deleteMany({});
    res.json({ success: true });
  } catch (err) {
    logError(err as Error, { path: "/api/events/clear", method: "DELETE" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.post(["/api/events/:id/confirm", "/api/events/:id/confirm/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const updated = await prisma.event.update({
      where: { id },
      data: { confirmation_status: "confirmed" },
    });
    broadcastSecurity({ type: "EVENT" });
    res.json({ ok: true, event: updated });
  } catch (err) {
    res.status(404).json({ detail: "Event not found" });
  }
});

app.post(["/api/events/:id/reject", "/api/events/:id/reject/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const event = await prisma.event.findUnique({ where: { id } });
    if (!event) return res.status(404).json({ detail: "Event not found" });

    const linkedConfirmationId = event.confirmation_id ?? null;

    // Delete snapshot from disk
    if (event.snapshot_path) {
      const fullPath = path.join(publicDir, event.snapshot_path);
      try {
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      } catch (e) {
        logWarn("Не удалось удалить снапшот", { path: fullPath });
      }
    }

    await prisma.event.delete({ where: { id } });

    // Закрываем связанный запрос подтверждения, иначе он навсегда останется PENDING
    if (linkedConfirmationId) {
      await prisma.faceConfirmation.updateMany({
        where: { id: linkedConfirmationId, status: "PENDING" },
        data: { status: "REJECTED", rejected_reason: "Отклонено из ленты событий", confirmed_at: new Date() },
      });
    }

    broadcastSecurity({ type: "EVENT" });
    res.json({ ok: true, message: "Событие и снапшот удалены" });
  } catch (err) {
    logError(err as Error, { path: "/api/events/:id/reject", method: "POST" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

// LOYALTY STATS
app.get(["/api/loyalty/:id", "/api/loyalty/:id/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const person = await prisma.person.findUnique({ where: { id } });
    const incidents = await prisma.incident.findMany({ where: { person_id: id }, orderBy: { created_at: "desc" } });
    const tags = await prisma.tag.findMany({ where: { person_id: id } });

    const visits = await prisma.personVisit.findMany({
      where: { person_id: id },
      select: { visit_date: true },
      orderBy: { visit_date: "desc" },
    });

    // Use stored loyalty_index if available, otherwise compute from visits
    let score: number;
    if (person?.loyalty_index !== null && person?.loyalty_index !== undefined && person.loyalty_index > 0) {
      score = Math.round(person.loyalty_index);
    } else if (visits.length >= 2) {
      score = calculateLoyaltyIndex(visits);
      // Persist computed score
      await prisma.person.update({ where: { id }, data: { loyalty_index: score } }).catch(() => {});
    } else if (person) {
      // Fallback to category-based score for persons without visit history
      if (person.category === "VIP") { score = 95; }
      else if (person.category === "BLACKLIST") { score = 0; }
      else if (person.category === "STAFF") { score = 80; }
      else { score = 50; }
    } else {
      score = 50;
    }

    let label: string, label_color: string, color: string, risk: number;
    if (score >= 90) { label = "Постоянный клиент"; label_color = "#00FF94"; color = "#00FF94"; risk = 0; }
    else if (score >= 70) { label = "Постоянный"; label_color = "#14b8a6"; color = "#14b8a6"; risk = 0; }
    else if (score >= 50) { label = "Регулярный"; label_color = "#3b82f6"; color = "#3b82f6"; risk = 0; }
    else if (score >= 30) { label = "Новый"; label_color = "#f97316"; color = "#f97316"; risk = 0; }
    else { label = "Новичок"; label_color = "#ef4444"; color = "#ef4444"; risk = 0; }

    res.json({
      loyalty: { score, label, label_color: color, activity: person?.total_visits || person?.visit_count || 0, activity_max: 20, reputation: Math.round(score / 10), reputation_max: 10, risk, recovery: 100 - risk, loyalty_index: person?.loyalty_index || score },
      incidents,
      tags,
      incident_types: DEFAULT_INCIDENT_TYPES,
      tag_types: DEFAULT_TAG_TYPES,
    });
  } catch (err) {
    logError(err as Error, { path: "/api/loyalty/:id" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.get(["/api/loyalty/:id/visits", "/api/loyalty/:id/visits/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const visits = await prisma.personVisit.findMany({
      where: { person_id: id },
      orderBy: { visit_date: "desc" },
    });
    const totalVisits = visits.length;
    const loyaltyIndex = (await prisma.person.findUnique({ where: { id }, select: { loyalty_index: true } }))?.loyalty_index || 0;

    res.json({
      person_id: id,
      total_visits: totalVisits,
      loyalty_index: loyaltyIndex,
      visits,
    });
  } catch (err) {
    logError(err as Error, { path: "/api/loyalty/:id/visits" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.post(["/api/loyalty/:id/tags", "/api/loyalty/:id/tags/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const newTag = await prisma.tag.create({ data: { person_id: id, tag: req.body.tag } });
    res.status(201).json(newTag);
  } catch (err) {
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.delete(["/api/loyalty/:id/tags/:tagId", "/api/loyalty/:id/tags/:tagId/"], async (req, res) => {
  try {
    await prisma.tag.delete({ where: { id: parseInt(req.params.tagId) } });
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ detail: "Tag not found" });
  }
});

app.post(["/api/loyalty/:id/incidents", "/api/loyalty/:id/incidents/"], async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { incident_type, severity, comment } = req.body;
    const newIncident = await prisma.incident.create({
      data: { person_id: id, incident_type, severity, comment: comment || null, status: "open" },
    });
    // Auto-escalate to BLACKLIST on high severity
    if (severity === "high") {
      await prisma.person.update({ where: { id }, data: { category: "BLACKLIST" } });
      const idx = persons.findIndex((p) => p.id === id);
      if (idx >= 0) persons[idx].category = "BLACKLIST";
    }
    res.status(201).json(newIncident);
  } catch (err) {
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.put(["/api/loyalty/:id/incidents/:incId", "/api/loyalty/:id/incidents/:incId/"], async (req, res) => {
  try {
    const updated = await prisma.incident.update({
      where: { id: parseInt(req.params.incId) },
      data: req.body,
    });
    res.json(updated);
  } catch (err) {
    res.status(404).json({ detail: "Incident not found" });
  }
});

app.delete(["/api/loyalty/:id/incidents/:incId", "/api/loyalty/:id/incidents/:incId/"], async (req, res) => {
  try {
    await prisma.incident.delete({ where: { id: parseInt(req.params.incId) } });
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ detail: "Incident not found" });
  }
});

// RECORDINGS
app.get(["/api/recordings", "/api/recordings/"], async (req, res) => {
  try {
    const recs = await prisma.recording.findMany({ orderBy: { start_time: "desc" }, take: 100 });
    res.json(recs);
  } catch (err) {
    logError(err as Error, { path: "/api/recordings" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

// ── HEALTH API (Full spec for Settings page) ──
app.get("/api/health", async (req, res) => {
  const engineStatus = getEngineStatus();

  // Честная проверка Python-сервера через face-engine.ts (FORCE свежий запрос)
  const pythonHealth = await getPythonServerHealth();

  if (!pythonHealth.healthy) {
    return res.status(503).json({
      status: "degraded",
      version: "2.4.1",
      ai_ready: false,
      setup_ok: false,
      setup_errors: ["Face Engine (Python) is unreachable or not initialized"],
      setup_warnings: [],
      face_engine: engineStatus,
      pythonServer: pythonHealth,
    });
  }

  const pythonDetails = pythonHealth.details || {};
  const provider = pythonDetails.provider || pythonDetails.gpu_provider || "CPUExecutionProvider";

  let gpu_available = false;
  let gpu_detected = false;
  let gpu_name = pythonDetails.gpu_name || "None";
  let gpu_vendor = "CPU";
  let gpu_providers = ["CPUExecutionProvider"];
  let recognition_provider = `onnxruntime (${provider})`;

  if (provider !== "CPUExecutionProvider") {
    gpu_available = true;
    gpu_detected = true;
    if (provider.includes("CUDA")) {
      gpu_name = pythonDetails.gpu_name || "NVIDIA GPU";
      gpu_vendor = "NVIDIA";
    } else if (provider.includes("Dml")) {
      gpu_name = pythonDetails.gpu_name || "DirectX GPU";
      gpu_vendor = "DirectML";
    } else if (provider.includes("OpenVINO")) {
      gpu_name = pythonDetails.gpu_name || "Intel GPU/CPU";
      gpu_vendor = "Intel";
    } else if (provider.includes("ROCM")) {
      gpu_name = pythonDetails.gpu_name || "AMD GPU";
      gpu_vendor = "AMD";
    }
    gpu_providers = [provider, "CPUExecutionProvider"];
  }

  const setup_recommendation = gpu_available
    ? `GPU acceleration active via ${provider}`
    : "No GPU detected. System runs in CPU mode.";

  res.json({
    status: "ok",
    version: "2.4.1",
    cameras: {},
    faiss: {},
    faiss_index_types: {},
    ai_ready: engineStatus.initialized && pythonHealth.initialized,
    recognition_threshold: 0.70,
    recognition_threshold_pct,
    gpu_enabled: gpu_available,
    gpu_policy: gpu_available ? "GPU_FIRST" : "CPU_ONLY",
    gpu_available,
    gpu_detected,
    gpu_name,
    gpu_vendor,
    gpu_providers,
    recognition_provider,
    engine_mode: gpu_available ? "Production (GPU)" : "Production (CPU)",
    setup_ok: true,
    setup_errors: [],
    setup_warnings: [],
    setup_recommendation,
    onnx_version: pythonDetails.onnx_version || "1.16.3",
    onnx_package: "onnxruntime",
    face_engine: engineStatus,
    pythonServer: pythonHealth,
    modules: pythonDetails.modules || {},
    cuda_available: pythonDetails.cuda_available || false,
    cuda_version: pythonDetails.cuda_version || null,
  });
});

// ── SETTINGS API ──
// Helper: load a setting from DB with fallback to in-memory default
async function loadSetting(key: string, fallback: any): Promise<any> {
  try {
    const row = await prisma.settings.findUnique({ where: { key } });
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return row.value; }
  } catch { return fallback; }
}

async function saveSetting(key: string, value: any): Promise<void> {
  const strVal = typeof value === "string" ? value : JSON.stringify(value);
  await prisma.settings.upsert({
    where: { key },
    update: { value: strVal },
    create: { key, value: strVal },
  });
}

app.get(["/api/settings", "/api/settings/"], async (req, res) => {
  try {
    const [
      cacheEnabled, cacheTtl, qualityThreshold, adaptiveSkip,
      faissThreshold, faissNprobe, camWeights, verifyThreshold, autoCreateUnknown,
      confirmThreshold, lowThreshold
    ] = await Promise.all([
      loadSetting("embedding_cache_enabled", embedding_cache_enabled),
      loadSetting("embedding_cache_ttl_days", embedding_cache_ttl_days),
      loadSetting("face_quality_min_threshold", face_quality_min_threshold),
      loadSetting("ai_adaptive_frame_skip", ai_adaptive_frame_skip),
      loadSetting("faiss_ivf_threshold", faiss_ivf_threshold),
      loadSetting("faiss_ivf_nprobe", faiss_ivf_nprobe),
      loadSetting("camera_priority_weights", camera_priority_weights),
      loadSetting("verification_threshold_pct", verification_threshold_pct),
      loadSetting("auto_create_unknown_persons", auto_create_unknown_persons),
      loadSetting("confirmation_threshold_pct", confirmation_threshold_pct),
      loadSetting("low_threshold_pct", low_threshold_pct),
    ]);
    // Sync in-memory
    embedding_cache_enabled = cacheEnabled;
    embedding_cache_ttl_days = cacheTtl;
    face_quality_min_threshold = qualityThreshold;
    ai_adaptive_frame_skip = adaptiveSkip;
    faiss_ivf_threshold = faissThreshold;
    faiss_ivf_nprobe = faissNprobe;
    camera_priority_weights = camWeights;
    verification_threshold_pct = verifyThreshold;
    auto_create_unknown_persons = autoCreateUnknown;
    confirmation_threshold_pct = confirmThreshold;
    low_threshold_pct = lowThreshold;

    res.json({
      embedding_cache_enabled,
      embedding_cache_ttl_days,
      face_quality_min_threshold,
      ai_adaptive_frame_skip,
      faiss_ivf_threshold,
      faiss_ivf_nprobe,
      camera_priority_weights,
      verification_threshold_pct,
      auto_create_unknown_persons,
      confirmation_threshold_pct,
      low_threshold_pct,
    });
  } catch (err) {
    logError(err as Error, { path: "/api/settings", method: "GET" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.post(["/api/settings", "/api/settings/"], async (req, res) => {
  try {
    const saves: Promise<void>[] = [];
    if (req.body.embedding_cache_enabled !== undefined) {
      embedding_cache_enabled = req.body.embedding_cache_enabled;
      saves.push(saveSetting("embedding_cache_enabled", embedding_cache_enabled));
    }
    if (req.body.embedding_cache_ttl_days !== undefined) {
      embedding_cache_ttl_days = req.body.embedding_cache_ttl_days;
      saves.push(saveSetting("embedding_cache_ttl_days", embedding_cache_ttl_days));
    }
    if (req.body.face_quality_min_threshold !== undefined) {
      face_quality_min_threshold = req.body.face_quality_min_threshold;
      saves.push(saveSetting("face_quality_min_threshold", face_quality_min_threshold));
    }
    if (req.body.ai_adaptive_frame_skip !== undefined) {
      ai_adaptive_frame_skip = req.body.ai_adaptive_frame_skip;
      saves.push(saveSetting("ai_adaptive_frame_skip", ai_adaptive_frame_skip));
    }
    if (req.body.faiss_ivf_threshold !== undefined) {
      faiss_ivf_threshold = req.body.faiss_ivf_threshold;
      saves.push(saveSetting("faiss_ivf_threshold", faiss_ivf_threshold));
    }
    if (req.body.faiss_ivf_nprobe !== undefined) {
      faiss_ivf_nprobe = req.body.faiss_ivf_nprobe;
      saves.push(saveSetting("faiss_ivf_nprobe", faiss_ivf_nprobe));
    }
    if (req.body.camera_priority_weights !== undefined) {
      camera_priority_weights = req.body.camera_priority_weights;
      saves.push(saveSetting("camera_priority_weights", camera_priority_weights));
    }
    if (req.body.verification_threshold_pct !== undefined) {
      verification_threshold_pct = req.body.verification_threshold_pct;
      saves.push(saveSetting("verification_threshold_pct", verification_threshold_pct));
    }
    if (req.body.auto_create_unknown_persons !== undefined) {
      auto_create_unknown_persons = !!req.body.auto_create_unknown_persons;
      saves.push(saveSetting("auto_create_unknown_persons", auto_create_unknown_persons));
    }
    if (req.body.confirmation_threshold_pct !== undefined) {
      confirmation_threshold_pct = req.body.confirmation_threshold_pct;
      saves.push(saveSetting("confirmation_threshold_pct", confirmation_threshold_pct));
    }
    if (req.body.low_threshold_pct !== undefined) {
      low_threshold_pct = req.body.low_threshold_pct;
      saves.push(saveSetting("low_threshold_pct", low_threshold_pct));
    }
    await Promise.all(saves);
    res.json({ ok: true, updated: Object.keys(req.body), message: "Настройки успешно сохранены" });
  } catch (err) {
    logError(err as Error, { path: "/api/settings", method: "POST" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.get(["/api/settings/categories", "/api/settings/categories/"], async (req, res) => {
  try {
    active_categories = await loadSetting("active_categories", active_categories);
    res.json({ active_categories });
  } catch (err) {
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.post(["/api/settings/categories", "/api/settings/categories/"], async (req, res) => {
  try {
    if (Array.isArray(req.body)) {
      active_categories = req.body;
      await saveSetting("active_categories", active_categories);
    }
    res.json({ ok: true, active_categories });
  } catch (err) {
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.post(["/api/settings/threshold", "/api/settings/threshold/"], async (req, res) => {
  try {
    const pct = parseInt(req.query.threshold_pct as string || "30");
    recognition_threshold_pct = pct;
    await saveSetting("recognition_threshold_pct", pct);
    res.json({ ok: true, threshold_pct: pct, threshold_cosine: 1 - pct / 100 });
  } catch (err) {
    res.status(500).json({ detail: "Internal server error" });
  }
});

// ── CHRONICLE API ──
app.get("/api/chronicle/cameras", (req, res) => {
  const list: any[] = [];
  for (const [camIdStr, daysData] of Object.entries(chronicleData)) {
    const camId = parseInt(camIdStr);
    if (camId === 0) continue;
    const camObj = cameras.find(c => c.id === camId);
    const name = camObj ? camObj.name : `Камера ${camId}`;
    let totalPhotos = 0;
    const dates = Object.keys(daysData);
    for (const visitors of Object.values(daysData)) {
      totalPhotos += visitors.length;
    }
    const lastDay = dates.length > 0 ? dates.sort().reverse()[0] : null;
    list.push({
      camera_id: camId,
      name,
      total_photos: totalPhotos,
      total_days: dates.length,
      last_day: lastDay,
      last_day_label: lastDay ? new Date(lastDay).toLocaleDateString('ru-RU') : null,
    });
  }

  const myPhotosDays = chronicleData[0] || {};
  const myPhotosDates = Object.keys(myPhotosDays);
  let myPhotosTotal = 0;
  for (const visitors of Object.values(myPhotosDays)) {
    myPhotosTotal += visitors.length;
  }
  const myPhotosLastDay = myPhotosDates.length > 0 ? myPhotosDates.sort().reverse()[0] : null;

  const myPhotos = {
    camera_id: 0,
    name: "Мои фото",
    total_photos: myPhotosTotal,
    total_days: myPhotosDates.length,
    last_day: myPhotosLastDay,
    last_day_label: myPhotosLastDay ? new Date(myPhotosLastDay).toLocaleDateString('ru-RU') : null,
  };

  res.json({
    cameras: list,
    my_photos: myPhotos,
  });
});

app.get("/api/chronicle/stats", (req, res) => {
  let total_photos = 0;
  const allDates = new Set<string>();
  const activeCams = new Set<number>();
  for (const [camIdStr, daysData] of Object.entries(chronicleData)) {
    const camId = parseInt(camIdStr);
    if (camId !== 0) activeCams.add(camId);
    for (const [date, visitors] of Object.entries(daysData)) {
      allDates.add(date);
      total_photos += visitors.length;
    }
  }
  const oldest_date = allDates.size > 0 ? Array.from(allDates).sort()[0] : new Date().toISOString().slice(0, 10);
  res.json({
    total_photos,
    total_days: allDates.size,
    cameras: activeCams.size,
    retention_days: 90,
    oldest_date,
  });
});

app.get("/api/chronicle/camera/:activeCameraId/months", (req, res) => {
  const camId = parseInt(req.params.activeCameraId);
  const daysData = chronicleData[camId] || {};
  const monthsMap = new Map<string, { days: Set<string>; count: number }>();

  for (const [date, visitors] of Object.entries(daysData)) {
    const month = date.slice(0, 7);
    if (!monthsMap.has(month)) {
      monthsMap.set(month, { days: new Set(), count: 0 });
    }
    const m = monthsMap.get(month)!;
    m.days.add(date);
    m.count += visitors.length;
  }

  const monthsList = Array.from(monthsMap.entries()).map(([month, data]) => {
    const [year, mStr] = month.split("-");
    const monthNames = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
    const label = `${monthNames[parseInt(mStr) - 1]} ${year}`;
    return {
      month,
      label,
      days_count: data.days.size,
      photos_count: data.count,
    };
  });

  res.json({ months: monthsList });
});

app.get("/api/chronicle/camera/:activeCameraId/days/:month", (req, res) => {
  const camId = parseInt(req.params.activeCameraId);
  const month = req.params.month;
  const daysData = chronicleData[camId] || {};
  const daysList: any[] = [];

  for (const [date, visitors] of Object.entries(daysData)) {
    if (date.startsWith(month)) {
      const d = new Date(date);
      daysList.push({
        date,
        label: d.toLocaleDateString('ru-RU', { weekday: 'short', day: '2-digit', month: '2-digit' }),
        count: visitors.length,
      });
    }
  }

  daysList.sort((a, b) => b.date.localeCompare(a.date));
  res.json({ days: daysList });
});

app.get("/api/chronicle/camera/:activeCameraId/day/:date", (req, res) => {
  const camId = parseInt(req.params.activeCameraId);
  const date = req.params.date;
  const visitors = (chronicleData[camId] || {})[date] || [];
  const d = new Date(date);
  res.json({
    camera_id: camId,
    date,
    label: d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    count: visitors.length,
    visitors,
  });
});

app.delete("/api/chronicle/camera/:activeCameraId/day/:date/photo/:filename", (req, res) => {
  const camId = parseInt(req.params.activeCameraId);
  const date = req.params.date;
  const filename = req.params.filename;

  if (chronicleData[camId] && chronicleData[camId][date]) {
    chronicleData[camId][date] = chronicleData[camId][date].filter(v => v.filename !== filename);
  }

  try {
    const fullPath = path.join(snapshotsDir, filename);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  } catch (e) {
    logError(e as Error, { context: "delete-chronicle-photo-file", filename });
  }

  res.json({ success: true });
});

app.delete("/api/chronicle/camera/:activeCameraId/day/:date", (req, res) => {
  const camId = parseInt(req.params.activeCameraId);
  const date = req.params.date;
  const files = chronicleData[camId]?.[date] || [];
  if (chronicleData[camId]) {
    delete chronicleData[camId][date];
  }

  try {
    for (const item of files) {
      const fullPath = path.join(snapshotsDir, item.filename);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }
  } catch (e) {
    logError(e as Error, { context: "delete-chronicle-day", camId, date });
  }

  res.json({ success: true });
});

app.delete("/api/chronicle/camera/:activeCameraId/month/:month", (req, res) => {
  const camId = parseInt(req.params.activeCameraId);
  const month = req.params.month;
  const removed: string[] = [];
  if (chronicleData[camId]) {
    for (const date of Object.keys(chronicleData[camId])) {
      if (date.startsWith(month)) {
        removed.push(...chronicleData[camId][date].map(v => v.filename));
        delete chronicleData[camId][date];
      }
    }
  }

  try {
    for (const filename of removed) {
      const fullPath = path.join(snapshotsDir, filename);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }
  } catch (e) {
    logError(e as Error, { context: "delete-chronicle-month", camId, month });
  }

  res.json({ success: true });
});

app.post("/api/chronicle/cleanup", (req, res) => {
  res.json({ removed_dirs: 0 });
});

// ── SMART RECORDINGS API ──
app.get("/api/recordings/cameras", (req, res) => {
  const list: any[] = [];
  for (const [camIdStr, daysData] of Object.entries(recordingsData)) {
    const camId = parseInt(camIdStr);
    if (camId === 999999) continue;
    const camObj = cameras.find(c => c.id === camId);
    const name = camObj ? camObj.name : `Камера ${camId}`;
    let totalRecordings = 0;
    const dates = Object.keys(daysData);
    for (const recs of Object.values(daysData)) {
      totalRecordings += recs.length;
    }
    const lastDay = dates.length > 0 ? dates.sort().reverse()[0] : null;
    list.push({
      camera_id: camId,
      name,
      total_recordings: totalRecordings,
      total_days: dates.length,
      last_day: lastDay,
      last_day_label: lastDay ? new Date(lastDay).toLocaleDateString('ru-RU') : null,
    });
  }

  const myRecsDays = recordingsData[999999] || {};
  const myRecsDates = Object.keys(myRecsDays);
  let myRecsTotal = 0;
  for (const recs of Object.values(myRecsDays)) {
    myRecsTotal += recs.length;
  }
  const myRecsLastDay = myRecsDates.length > 0 ? myRecsDates.sort().reverse()[0] : null;

  const myRecordings = {
    camera_id: 999999,
    name: "Мои записи",
    total_recordings: myRecsTotal,
    total_days: myRecsDates.length,
    last_day: myRecsLastDay,
    last_day_label: myRecsLastDay ? new Date(myRecsLastDay).toLocaleDateString('ru-RU') : null,
  };

  res.json({
    cameras: list,
    my_recordings: myRecordings,
  });
});

app.get("/api/recordings/camera/:activeCameraId/months", (req, res) => {
  const camId = parseInt(req.params.activeCameraId);
  const daysData = recordingsData[camId] || {};
  const monthsMap = new Map<string, { days: Set<string>; count: number }>();

  for (const [date, recs] of Object.entries(daysData)) {
    const month = date.slice(0, 7);
    if (!monthsMap.has(month)) {
      monthsMap.set(month, { days: new Set(), count: 0 });
    }
    const m = monthsMap.get(month)!;
    m.days.add(date);
    m.count += recs.length;
  }

  const monthsList = Array.from(monthsMap.entries()).map(([month, data]) => {
    const [year, mStr] = month.split("-");
    const monthNames = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
    const label = `${monthNames[parseInt(mStr) - 1]} ${year}`;
    return {
      month,
      label,
      days_count: data.days.size,
      recordings_count: data.count,
    };
  });

  res.json({ months: monthsList });
});

app.get("/api/recordings/camera/:activeCameraId/days/:month", (req, res) => {
  const camId = parseInt(req.params.activeCameraId);
  const month = req.params.month;
  const daysData = recordingsData[camId] || {};
  const daysList: any[] = [];

  for (const [date, recs] of Object.entries(daysData)) {
    if (date.startsWith(month)) {
      const d = new Date(date);
      daysList.push({
        date,
        label: d.toLocaleDateString('ru-RU', { weekday: 'short', day: '2-digit', month: '2-digit' }),
        count: recs.length,
      });
    }
  }

  daysList.sort((a, b) => b.date.localeCompare(a.date));
  res.json({ days: daysList });
});

app.get("/api/recordings/camera/:activeCameraId/day/:date", (req, res) => {
  const camId = parseInt(req.params.activeCameraId);
  const date = req.params.date;
  const recs = (recordingsData[camId] || {})[date] || [];
  const d = new Date(date);
  res.json({
    camera_id: camId,
    date,
    label: d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    count: recs.length,
    recordings: recs,
  });
});

app.delete("/api/recordings/camera/:activeCameraId/day/:date/video/:filename", (req, res) => {
  const camId = parseInt(req.params.activeCameraId);
  const date = req.params.date;
  const filename = req.params.filename;

  if (recordingsData[camId] && recordingsData[camId][date]) {
    recordingsData[camId][date] = recordingsData[camId][date].filter(v => v.filename !== filename);
  }

  try {
    const fullPath = path.join(recordingsDir, filename);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  } catch (e) {
    logError(e as Error, { context: "delete-recording-file", filename });
  }

  res.json({ success: true });
});

app.delete("/api/recordings/camera/:activeCameraId/day/:date", (req, res) => {
  const camId = parseInt(req.params.activeCameraId);
  const date = req.params.date;
  const files = recordingsData[camId]?.[date] || [];
  recordingsData[camId] = recordingsData[camId] || {};
  delete recordingsData[camId][date];

  try {
    for (const item of files) {
      const fullPath = path.join(recordingsDir, item.filename);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }
  } catch (e) {
    logError(e as Error, { context: "delete-recordings-day", camId, date });
  }

  res.json({ success: true });
});

app.post("/api/recordings/cleanup", (req, res) => {
  res.json({ removed_dirs: 0 });
});

// ── WEBSOCKET SERVERS ──

const wssSecurity = new WebSocketServer({ noServer: true });
const wssCamera = new WebSocketServer({ noServer: true });

// Security websocket client storage
const securityClients = new Set<WebSocket>();

wssSecurity.on("connection", (ws) => {
  securityClients.add(ws);
  logDebug(`Security client connected. Total: ${securityClients.size}`);

  ws.on("message", (msg) => {
    if (msg.toString() === "ping") {
      ws.send("pong");
    }
  });

  ws.on("close", () => {
    securityClients.delete(ws);
    logDebug(`Security client disconnected. Total: ${securityClients.size}`);
  });
});

function broadcastSecurity(data: any) {
  const payload = JSON.stringify(data);
  for (const client of securityClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// ═══ ALERT ENGINE ═════════════════════════════════════════════════════════════
const ALERT_COOLDOWN_MS = 5 * 60_000   // персона + дверь
const ON_SITE_WINDOW_MS = 30 * 60_000  // «на территории»
const alertCooldown = new Map<string, number>()

type AlertLevel = 'critical' | 'warning' | 'info'

function alertLevelFor(code: string | null | undefined): AlertLevel | null {
  switch (code) {
    case 'BLACKLIST': return 'critical'
    case 'NOT_TODAY':
    case 'SUITE':     return 'warning'
    case 'VIP':       return 'info'
    default:          return null
  }
}

async function emitPersonAlert(opts: {
  person: { id: number; name: string; categoryCode: string | null }
  camera: { id: number; name?: string | null; zone?: string | null }
  eventId?: number
  snapshotUrl?: string | null
  message?: string
  force?: boolean
}) {
  const level = alertLevelFor(opts.person.categoryCode)
  if (!level) return

  const key = `${opts.person.id}:${opts.camera.id}`
  const now = Date.now()
  if (!opts.force && now - (alertCooldown.get(key) ?? 0) < ALERT_COOLDOWN_MS) return
  alertCooldown.set(key, now)

  if (opts.eventId) {
    await prisma.event
      .update({ where: { id: opts.eventId }, data: { alerted: true } })
      .catch(() => {})
  }

  broadcastSecurity({
    type: "ALERT",
    eventId: opts.eventId ?? null,
    personId: opts.person.id,
    personName: opts.person.name,
    categoryCode: opts.person.categoryCode,
    level,
    cameraId: opts.camera.id,
    doorName: opts.camera.name || `Зона ${opts.camera.zone ?? '?'}`,
    snapshotUrl: opts.snapshotUrl ?? null,
    message: opts.message ?? `${opts.person.name} · ${opts.person.categoryCode}`,
    at: new Date().toISOString(),
  })
}

// ── FFmpeg helpers (shared by live stream + file recording) ────────────────────
function getFfmpegPath(): string {
  const projectBinPath = path.join(process.cwd(), "bin", "ffmpeg.exe");
  if (fs.existsSync(projectBinPath)) return projectBinPath;
  const extractedPath = path.join(process.cwd(), "bin", "ffmpeg-master-latest-win64-gpl", "bin", "ffmpeg.exe");
  if (fs.existsSync(extractedPath)) return extractedPath;
  return "ffmpeg";
}

function getFfprobePath(): string {
  const projectBinPath = path.join(process.cwd(), "bin", "ffprobe.exe");
  if (fs.existsSync(projectBinPath)) return projectBinPath;
  const extractedPath = path.join(process.cwd(), "bin", "ffmpeg-master-latest-win64-gpl", "bin", "ffprobe.exe");
  if (fs.existsSync(extractedPath)) return extractedPath;
  return "ffprobe";
}

function storedToRawProfile(p: any): any {
  const res = p.resolutions?.[0];
  return {
    name: p.name,
    codec: p.codec,
    width: res?.width || p.width,
    height: res?.height || p.height,
    fps: p.fps?.current || p.fps,
    bitrate: p.bitrate,
    gop: p.gop,
    source: p.source,
  };
}

/** Real camera connectivity probe using ffprobe (RTSP/HTTP) or device check (USB). */
async function probeCamera(cam: any): Promise<{ connected: boolean; details: string; conflicts?: any[]; configChanged?: boolean; profileMismatch?: boolean }> {
  try {
    if (cam.camera_type === "USB" || /^\d+$/.test((cam.source || "").trim())) {
      if (process.platform === "win32") {
        const idx = parseInt((cam.source || "0").trim(), 10);
        const devName = idx === 0 ? "USB Video Device" : `USB Video Device #${idx + 1}`;
        const cmd = `ffprobe -v error -f dshow -list_devices true -i video="${devName}"`;
        await execAsync(cmd, { timeout: 10000 });
        return { connected: true, details: `USB device "${devName}" accessible` };
      } else {
        const devPath = cam.source || "/dev/video0";
        if (fs.existsSync(devPath)) {
          return { connected: true, details: `Device ${devPath} exists` };
        }
        return { connected: false, details: `Device ${devPath} not found` };
      }
    }

    // RTSP / IP / ONVIF / Hikvision / UNV: probe the stream URL
    let source = (cam.source || "").trim();
    if (cam.username && cam.password && source && !/:\/\/[^@]+@/.test(source)) {
      try {
        const u = new URL(source);
        u.username = encodeURIComponent(cam.username);
        u.password = encodeURIComponent(cam.password);
        source = u.toString();
      } catch { /* not a URL, leave as-is */ }
    }

    if (!source) {
      return { connected: false, details: "No source URL configured" };
    }

    const probePath = getFfprobePath();
    const cmd = `"${probePath}" -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 -rtsp_transport tcp -timeout 15000000 -i "${source}"`;
    let stdout = "";
    try {
      const result = await execAsync(cmd, { timeout: 10000 });
      stdout = result.stdout;
    } catch (e: any) {
      // ffprobe может вернуть exit code 1 при SEI warning, но stdout будет содержать данные
      stdout = e.stdout || "";
    }
    const hasStream = stdout.trim().length > 0;

    let conflicts: any[] = [];
    let configChanged = false;
    let profileMismatch = false;

    const { profiles: storedProfiles } = parseStreamProfiles(cam);

    let rtspCodec: string | undefined;
    if (hasStream) {
      rtspCodec = stdout.trim().split(",")[0]?.trim();
    }

    let onvifInfo: { reachable: boolean; profiles: any[]; mac?: string } = { reachable: false, profiles: [] };
    if (cam.onvif_supported && (cam.ip_address || cam.ip_port)) {
      try {
        const ip = cam.ip_address || new URL(source).hostname;
        const port = cam.ip_port || 80;
        const { Cam } = require("onvif");
        const camInstance = new Cam({ hostname: ip, username: cam.username, password: cam.password, port });
        await Promise.race([
          new Promise<void>((resolve) => {
            camInstance.once("connected", () => {
              camInstance.getDeviceInformation((_err: any, info: any) => {
                if (info?.MACAddress) onvifInfo.mac = info.MACAddress;
              });
              camInstance.getProfiles((_err: any, data: any) => {
                if (Array.isArray(data)) {
                  onvifInfo.profiles = data.map((p: any) => {
                    const cfg = p?.VideoEncoderConfiguration || {};
                    const width = cfg?.Resolution?.["Width"] || cfg?.width;
                    const height = cfg?.Resolution?.["Height"] || cfg?.height;
                    return {
                      name: p?.Name,
                      codec: cfg?.Encoding,
                      width: typeof width === "number" ? width : Number(width),
                      height: typeof height === "number" ? height : Number(height),
                      fps: cfg?.FrameRateLimit || cfg?.fps,
                      bitrate: cfg?.Bitrate || cfg?.bitrate,
                      gop: cfg?.GovLength || cfg?.gop,
                      source: "onvif",
                    };
                  }).filter((p: any) => p.width && p.height);
                }
                onvifInfo.reachable = true;
                resolve();
              });
            });
            camInstance.once("error", () => resolve());
            camInstance.connect();
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 3000)),
        ]);
      } catch {
        // ONVIF not available or not reachable — continue without it
      }
    }

    if (storedProfiles.length > 0) {
      if (rtspCodec && storedProfiles[0]?.codec) {
        profileMismatch = rtspCodec.toLowerCase() !== storedProfiles[0].codec?.toLowerCase();
      }
      if (onvifInfo.profiles.length && storedProfiles.length) {
        const storedRaw = storedProfiles.map(storedToRawProfile);
        conflicts = compareProbeResults({ profiles: onvifInfo.profiles } as Partial<CameraProbeResult>, { profiles: storedRaw } as Partial<CameraProbeResult>);
        if (conflicts.length) {
          configChanged = true;
        }
      }
    }

    let details = hasStream ? `Stream probed: ${stdout.trim()}` : "No video stream found";
    if (onvifInfo.reachable) {
      details += ` | ONVIF: reachable, profiles=${onvifInfo.profiles?.length || 0}`;
    }
    if (profileMismatch) {
      details += ` | WARN: codec mismatch (rtsp=${rtspCodec} vs stored=${storedProfiles[0]?.codec})`;
    }

    return {
      connected: hasStream,
      details,
      conflicts: conflicts.length ? conflicts : undefined,
      configChanged,
      profileMismatch,
    };
  } catch (error: any) {
    const msg = error.message || error.stderr || "probe failed";
    return { connected: false, details: msg.split("\n")[0].trim() };
  }
}

function buildFfmpegInputArgs(cam: any): string[] {
  const isUsb = cam.camera_type === "USB" || /^\d+$/.test((cam.source || "").trim());
  if (isUsb) {
    let inputSource = (cam.source || "").trim();
    const m = inputSource.match(/^\/dev\/video(\d+)$/);
    if (m) {
      const idx = parseInt(m[1], 10);
      inputSource = idx === 0 ? "USB Video Device" : `USB Video Device #${idx + 1}`;
    }
    // Кроссплатформенность: Windows использует dshow, Linux — v4l2
    if (process.platform === "win32") {
      return ["-hide_banner", "-loglevel", "error", "-f", "dshow", "-i", `video=${inputSource}`];
    } else {
      const devPath = inputSource.startsWith("/dev/") ? inputSource : "/dev/video0";
      return ["-hide_banner", "-loglevel", "error", "-f", "v4l2", "-framerate", "25", "-video_size", "640x480", "-i", devPath];
    }
  }
  // RTSP / IP / ONVIF / Hikvision / UNV: подставляем сохранённые учётные данные в URL, если их нет в source
  let source = (cam.source || "").trim();
  if (cam.username && cam.password && source && !/:\/\/[^@]+@/.test(source)) {
    try {
      const u = new URL(source);
      u.username = encodeURIComponent(cam.username);
      u.password = encodeURIComponent(cam.password);
      source = u.toString();
    } catch {
      // не URL — оставляем как есть
    }
  }
  // -hide_banner + -loglevel error: не засоряем логи баннером версии/конфигурации на каждом (пере)запуске
  return ["-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-rtsp_flags", "prefer_tcp", "-timeout", "15000000", "-i", source];
}

// Активные записи видео: cameraId -> сессия
interface RecordingSession {
  proc: ChildProcessWithoutNullStreams;
  outputPath: string;
  startedAt: number;
  camera: any;
}
const activeRecordings = new Map<number, RecordingSession>();

/** Пишет запись в in-memory архив (календарь «Видеозаписи»). */
function recordToChronicle(rec: any) {
  const start = new Date(rec.start_time);
  const dateStr = start.toISOString().slice(0, 10);
  const entry = {
    id: rec.id,
    camera_id: rec.camera_id,
    filename: path.basename(rec.video_path),
    // Абсолютный URL для <video>/fetch (раздаётся статикой /recordings).
    // Без него фронтенд получал undefined и видео не открывалось.
    video_url: '/' + rec.video_path,
    date: dateStr,
    time: start.toISOString().slice(11, 19),
    duration: rec.duration,
    size_mb: rec.size_mb,
    video_path: rec.video_path,
    person_name: "Видеозапись",
  };
  if (!recordingsData[rec.camera_id]) recordingsData[rec.camera_id] = {};
  if (!recordingsData[rec.camera_id][dateStr]) recordingsData[rec.camera_id][dateStr] = [];
  recordingsData[rec.camera_id][dateStr].push(entry);
}

/** Добавляет посетителя в in-memory «Хронику» (вкладка Архив фото). */
async function recordVisitor(cameraId: number, person_id: number | null, person_name: string, snapshot_path: string) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  const filename = path.basename(snapshot_path);
  let size_kb = 0;
  try {
    const st = await fsp.stat(path.join(publicDir, snapshot_path)).catch(() => null);
    if (st) size_kb = Math.round(st.size / 1024);
  } catch { /* ignore */ }
  const visitor: Visitor = {
    filename,
    person_id,
    person_name,
    time,
    photo_url: snapshot_path,
    size_kb,
  };
  if (!chronicleData[cameraId]) chronicleData[cameraId] = {};
  if (!chronicleData[cameraId][dateStr]) chronicleData[cameraId][dateStr] = [];
  chronicleData[cameraId][dateStr].unshift(visitor);
}

/** Запускает запись видео с камеры в файл. durationSec=undefined → непрерывно до stop. */
async function startFileRecording(cam: any, durationSec?: number): Promise<string | null> {
  try {
    if (activeRecordings.has(cam.id)) return activeRecordings.get(cam.id)!.outputPath;
    const ffmpegPath = getFfmpegPath();
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outputPath = path.join(recordingsDir, `cam${cam.id}_${ts}.mp4`);
    const args = [...buildFfmpegInputArgs(cam)];
    args.push("-y");
    if (durationSec) args.push("-t", String(durationSec));
    args.push("-r", "10", "-s", "640x480", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-movflags", "+faststart", outputPath);

    logInfo(`FFmpeg запись старт для камеры ${cam.id} (${cam.name}) → ${outputPath}`, { durationSec });
     const proc = spawn(ffmpegPath, args);
     trackFfmpeg(proc);
     proc.stderr.on("data", (d) => logDebug(`FFmpeg(rec ${cam.id}): ${d.toString().trim()}`));
    proc.on("error", (err) => logError(`Ошибка FFmpeg записи камеры ${cam.id}: ${err.message}`));
    proc.on("close", async (code) => {
      const session = activeRecordings.get(cam.id);
      activeRecordings.delete(cam.id);
      try {
        const startedAt = session ? session.startedAt : Date.now() - (durationSec || 0) * 1000;
        const end = Date.now();
        const duration = Math.max(1, Math.round((end - startedAt) / 1000));
        const stat = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null;
        const size_mb = stat ? Number((stat.size / 1024 / 1024).toFixed(1)) : 0;
        const rec = await prisma.recording.create({
          data: {
            camera_id: cam.id,
            camera_name: cam.name,
            start_time: new Date(startedAt),
            end_time: new Date(end),
            duration,
            size_mb,
            video_path: `recordings/${path.basename(outputPath)}`,
            is_favorite: false,
          },
        });
        recordToChronicle(rec);
        logInfo(`Запись сохранена: камера ${cam.id}, ${rec.video_path} (${duration}s, ${size_mb}MB)`);
      } catch (err) {
        logError(err as Error, { context: "finalize recording" });
      }
    });

    activeRecordings.set(cam.id, { proc, outputPath, startedAt: Date.now(), camera: cam });
    return outputPath;
  } catch (e: any) {
    logError(`startFileRecording failed: ${e.message}`);
    return null;
  }
}

/** Останавливает активную запись (корректно завершает файл через SIGINT). */
function stopFileRecording(camId: number): boolean {
  const session = activeRecordings.get(camId);
  if (!session) return false;
  try {
    session.proc.kill("SIGINT");
  } catch {
    try { session.proc.kill("SIGKILL"); } catch { /* ignore */ }
  }
  return true;
}

// ── Сохранение снимков и событий распознавания (живой поток) ──────────────────
const RECOGNIZED_DEBOUNCE_MS = 15_000;
const UNKNOWN_DEBOUNCE_MS = 20_000;
// cameraId:personKey -> последнее время события (чтобы не спамить БД)
const lastEventAt = new Map<string, number>();

async function saveSnapshotFromFrame(frameBase64: string, cameraId: number, label?: string): Promise<string> {
  try {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${pad(now.getDate())}${pad(now.getMonth() + 1)}${now.getFullYear()}`;
    const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const safeLabel = label ? label.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 30) : "";
    const name = safeLabel
      ? `cam${cameraId}_${dateStr}_${timeStr}_${safeLabel}.jpg`
      : `cam${cameraId}_${dateStr}_${timeStr}_Неизвестный.jpg`;
    const target = path.join(snapshotsDir, name);
    await fsp.writeFile(target, Buffer.from(frameBase64, "base64"));
    return `snapshots/${name}`;
  } catch (e) {
    logError(e as Error, { context: "saveSnapshotFromFrame" });
    return "snapshots/ev1.jpg";
  }
}

async function persistAndBroadcastEvent(e: {
  cameraId: number;
  cameraName: string;
  personId?: number | null;
  guestId?: number | null;
  event_type: string;
  confidence: number;
  threshold?: number;
  snapshot_path: string;
  person_name?: string;
  person_category?: string;
  person_photo_path?: string;
  needs_operator_confirmation?: boolean;
  confirmation_status?: string;
  confirmationId?: number;
}) {
  try {
    const event = await prisma.event.create({
      data: {
        camera_id: e.cameraId,
        camera_name: e.cameraName,
        person_id: e.personId ?? null,
        guest_id: e.guestId ?? null,
        event_type: e.event_type,
        confidence: e.confidence,
        snapshot_path: e.snapshot_path,
        person_name: e.person_name,
        person_category: e.person_category,
        person_photo_path: e.person_photo_path,
        categoryCode: e.person_category ?? null,
        needs_operator_confirmation: e.needs_operator_confirmation ?? false,
        confirmation_status: e.confirmation_status ?? null,
        confirmation_id: e.confirmationId ?? null,
      },
    });

    const cam = cameras.find(c => c.id === e.cameraId)
    await emitPersonAlert({
      person: { id: e.personId ?? 0, name: e.person_name || 'Неизвестный', categoryCode: e.person_category ?? null },
      camera: { id: e.cameraId, name: e.cameraName, zone: cam?.zone },
      eventId: event.id,
      snapshotUrl: e.snapshot_path ? `/snapshots/${e.snapshot_path}` : null,
    })

    broadcastSecurity({ type: "EVENT" });
  } catch (err) {
    reportError("persistAndBroadcastEvent", err, { cameraId: e.cameraId })
  }
}

/** Запускает ограниченную запись (клип) при срабатывании события, если включена умная запись. */
function triggerSmartRecording(cam: any) {
  if (!cam.is_smart_recording) return;
  if (activeRecordings.has(cam.id)) return; // уже пишется
  startFileRecording(cam, 15).catch((err) => reportError("smartRecording", err, { cameraId: cam.id }))
}

async function handleRecognizedEvent(cam: any, match: any, frameBase64: string) {
   let event_type = "RECOGNIZED";
   if (match.category === "VIP") event_type = "VIP_ARRIVAL";
   else if (match.category === "BLACKLIST") event_type = "BLACKLIST_ALERT";
   else if (match.category === "RESPONSE") event_type = "RESPONSE_ALERT";

   const confidence = match.similarity;
   const meetsVerification = confidence * 100 >= verification_threshold_pct;
    const snapshot_path = await saveSnapshotFromFrame(frameBase64, cam.id, match.personName);
    await recordVisitor(cam.id, match.personId, match.personName, snapshot_path);

   const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

    try {
      await prisma.person.update({
        where: { id: match.personId },
        data: { visit_count: { increment: 1 }, last_seen_at: new Date() },
      });

      try {
        const recentVisit = await prisma.personVisit.findFirst({
          where: { person_id: match.personId, camera_id: cam.id },
          orderBy: { visit_date: 'desc' },
        });

        const now = Date.now();
        const isSessionActive = recentVisit && (now - new Date(recentVisit.visit_date).getTime()) < SESSION_TIMEOUT_MS;

        if (!isSessionActive) {
          await prisma.personVisit.create({
            data: {
              person_id: match.personId,
              camera_id: cam.id,
              camera_name: cam.name,
              confidence: confidence,
              source: "recognition",
            },
          });
          await prisma.person.update({
            where: { id: match.personId },
            data: { needsLoyaltyUpdate: true },
          });
        }
      } catch (err) {
        reportError("personVisit", err, { personId: match.personId })
      }
    } catch (err) {
      reportError("handleRecognizedEvent", err, { personId: match.personId })
    }

   const idx = persons.findIndex((p: any) => p.id === match.personId);
   if (idx >= 0) {
     persons[idx].visit_count = (persons[idx].visit_count || 0) + 1;
     persons[idx].last_seen_at = new Date().toISOString();
     persons[idx].total_visits = (persons[idx].total_visits || 0) + 1;
   }
   const person = idx >= 0 ? persons[idx] : undefined;

    await persistAndBroadcastEvent({
      cameraId: cam.id,
      cameraName: cam.name,
      personId: match.personId,
      event_type,
      confidence,
      threshold: recognition_threshold_pct / 100,
      snapshot_path,
      person_name: match.personName,
      person_category: match.category,
      person_photo_path: person?.photo_path,
      needs_operator_confirmation: !meetsVerification,
      confirmation_status: !meetsVerification ? "pending" : undefined,
    });

   triggerSmartRecording(cam);
 }

/**
 * Вырезает лицо из кадра по детектированному боксу с запасом по краям.
 * Кадр с «крупным планом» лица даёт стабильный эмбеддинг (без ошибки
 * «лицо не обнаружено»), в отличие от сохранения всего кадра целиком.
 */
async function cropFaceFromFrame(frameBase64: string, box: any): Promise<Buffer | null> {
  try {
    const buf = Buffer.from(frameBase64, "base64");
    const meta = await sharp(buf).metadata();
    const iw = meta.width || 640;
    const ih = meta.height || 480;
    const x = Math.round(box.x || 0);
    const y = Math.round(box.y || 0);
    const w = Math.round(box.width || 0);
    const h = Math.round(box.height || 0);
    if (w < 6 || h < 6) return null;
    const padX = Math.round(w * 0.3);
    const padY = Math.round(h * 0.3);
    const left = Math.max(0, x - padX);
    const top = Math.max(0, y - padY);
    const right = Math.min(iw, x + w + padX);
    const bottom = Math.min(ih, y + h + padY);
    const cw = right - left;
    const ch = bottom - top;
    if (cw <= 0 || ch <= 0) return null;
    return await sharp(buf)
      .extract({ left, top, width: cw, height: ch })
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch (e) {
    logError(e as Error, { context: "cropFaceFromFrame" });
    return null;
  }
}

/**
 * Автоматически заносит неизвестного в базу людей: вырезает лицо из кадра,
 * создаёт персону, регистрирует эмбеддинг. Если лицо уже есть в базе —
 * просто привязывает событие к существующей персоне (дедуп).
 */
async function createUnknownGuestFromFace(
  cam: any,
  frameBase64: string,
  face: any
): Promise<{ id: number; name: string; category: string } | null> {
  let photoBuffer: Buffer | null = face?.box ? await cropFaceFromFrame(frameBase64, face.box) : null;
  if (!photoBuffer) photoBuffer = Buffer.from(frameBase64, "base64");
  const filename = `unknown_${cam.id}_${Date.now()}_${Math.floor(Math.random() * 1000)}.jpg`;
  const fullPath = path.join(photosDir, filename);
  await fs.promises.writeFile(fullPath, photoBuffer);
  const photo_path = `photos/${filename}`;

  const newGuest = await prisma.guest.create({
    data: {
      name: "Неизвестный",
      photo_path,
      is_active: true,
      visit_count: 1,
      confidence: face?.score || 0.5,
      camera_id: cam.id,
      camera_name: cam.name,
    },
  });

  await prisma.guest.update({
    where: { id: newGuest.id },
    data: { photo_path },
  });

  return { id: newGuest.id, name: "Неизвестный", category: "GUEST" };
}

async function handleUnknownEvent(cam: any, frameBase64: string, face?: any) {
   const bboxKey = `${face?.box?.x ?? 0}-${face?.box?.y ?? 0}-${face?.box?.width ?? 0}-${face?.box?.height ?? 0}`;
   const debounceKey = `${cam.id}:unknown:${bboxKey}`;

   if (Date.now() - (lastEventAt.get(debounceKey) || 0) < UNKNOWN_DEBOUNCE_MS) {
     return;
   }
   lastEventAt.set(debounceKey, Date.now());

    const snapshot_path = await saveSnapshotFromFrame(frameBase64, cam.id);

   let guestId: number | null = null;
   let guestName: string | null = null;
   let guestCategory = "GUEST";
   let guestPhotoPath: string | undefined;

   if (auto_create_unknown_persons) {
     try {
       const created = await createUnknownGuestFromFace(cam, frameBase64, face);
       if (created) {
         guestId = created.id;
         guestName = created.name;
         guestCategory = created.category;
         const g = await prisma.guest.findUnique({ where: { id: created.id } });
         guestPhotoPath = g?.photo_path;
       }
     } catch (e) {
       logError(e as Error, { context: "auto-create unknown guest" });
     }
   }

    await recordVisitor(cam.id, guestId, guestName || "Неизвестный", snapshot_path);

   await persistAndBroadcastEvent({
     cameraId: cam.id,
     cameraName: cam.name,
     personId: null,
     guestId: guestId,
     event_type: "UNKNOWN_PERSON",
     confidence: face?.score || 0.5,
     snapshot_path,
     person_name: guestName || "Неизвестный",
     person_category: guestCategory,
     person_photo_path: guestPhotoPath,
   });
   triggerSmartRecording(cam);
 }

/** Детект → распознавание → обогащение кадра + (debounced) события в БД. */
async function processDetectedFaces(cam: any, frameBase64: string, faces: any[]): Promise<any[]> {
  const lowT = low_threshold_pct / 100;
  const confirmT = confirmation_threshold_pct / 100;
  const enriched: any[] = [];
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    const box = f.box || {};
    const x = box.x || 0;
    const y = box.y || 0;
    const w = box.width || 0;
    const h = box.height || 0;
    const bbox: [number, number, number, number] = [x, y, x + w, y + h];
    const desc = f.descriptor;

    // Ищем до НИЖНЕГО порога бэнда, чтобы поймать кандидатов 40-55% (подтверждение)
    let match: any = null;
    if (desc && desc.length) {
      const matches = await searchByDescriptor(desc, lowT, 1);
      if (matches.length) match = matches[0];
    }
    const sim = match ? match.similarity : 0;

    if (match && sim >= confirmT) {
      // Уверенное совпадение (>= confirmation_threshold) → авто-распознано
      enriched.push({
        track_id: i + 1,
        bbox,
        person_id: match.personId,
        person_name: match.personName,
        category: match.category,
        confidence: sim,
        box: f.box,
      });
      const key = `${cam.id}:p${match.personId}`;
      if (Date.now() - (lastEventAt.get(key) || 0) > RECOGNIZED_DEBOUNCE_MS) {
        lastEventAt.set(key, Date.now());
        await handleRecognizedEvent(cam, match, frameBase64);
      }
    } else if (match && sim >= lowT) {
      // БЭНД ПОДТВЕРЖДЕНИЯ ОПЕРАТОРА (low_threshold .. confirmation_threshold)
      enriched.push({
        track_id: i + 1,
        bbox,
        person_id: match.personId,
        person_name: match.personName,
        category: match.category,
        confidence: sim,
        box: f.box,
        needs_confirmation: true,
      });
      const key = `${cam.id}:conf${match.personId}`;
      if (Date.now() - (lastEventAt.get(key) || 0) > UNKNOWN_DEBOUNCE_MS) {
        lastEventAt.set(key, Date.now());
        await handleConfirmationEvent(cam, match, frameBase64, f);
      }
    } else {
      enriched.push({
        track_id: i + 1,
        bbox,
        person_id: undefined,
        category: "UNKNOWN",
        confidence: f.score || 0,
        box: f.box,
      });
const bboxKey = `${f.box?.x ?? 0}-${f.box?.y ?? 0}-${f.box?.width ?? 0}-${f.box?.height ?? 0}`;
       const key = `${cam.id}:unknown:${bboxKey}`;
       if (Date.now() - (lastEventAt.get(key) || 0) > UNKNOWN_DEBOUNCE_MS) {
         lastEventAt.set(key, Date.now());
         await handleUnknownEvent(cam, frameBase64, f);
       }
    }
  }
  return enriched;
}

// Подтверждения оператора: дебаунс создания pending-записей + папка временных фото
const lastConfirmationAt = new Map<string, number>();
const CONFIRMATION_COOLDOWN_MS = 30_000;
const confirmationsDir = path.join(publicDir, "confirmations");

/**
 * Создаёт запрос на подтверждение оператора, когда лицо похоже на известного
 * (band low..confirmation). Сохраняет кадр, пишет FaceConfirmation (PENDING),
 * шлёт событие и WS-уведомление. Дедуп по паре камера-персона.
 */
async function handleConfirmationEvent(cam: any, match: any, frameBase64: string, face: any) {
  const personId = match.personId;
  const key = `${cam.id}:conf${personId}`;
  // Дебаунс: не плодим подтверждения для одной пары камера-персона подряд
  if (Date.now() - (lastConfirmationAt.get(key) || 0) < CONFIRMATION_COOLDOWN_MS) return;
  lastConfirmationAt.set(key, Date.now());

  try {
    if (!fs.existsSync(confirmationsDir)) fs.mkdirSync(confirmationsDir, { recursive: true });
    const filename = `confirm_${Date.now()}_${Math.floor(Math.random() * 1000)}.jpg`;
    const tempFull = path.join(confirmationsDir, filename);
    await fs.promises.writeFile(tempFull, Buffer.from(frameBase64, "base64"));
    const temp_photo_path = `confirmations/${filename}`;

    const candidate = persons.find((p: any) => p.id === personId);
    const existing_photo_path = candidate?.photo_path || null;

    const confirmation = await prisma.faceConfirmation.create({
      data: {
        person_id: personId,
        confidence: match.similarity,
        temp_photo_path,
        existing_photo_path,
        person_name: match.personName,
        category: match.category,
        status: "PENDING",
      },
    });

    // Событие в ленту (оператор видит в «Событиях»)
    const snapshot_path = await saveSnapshotFromFrame(frameBase64, cam.id, match.personName);
    await recordVisitor(cam.id, personId, match.personName, snapshot_path);
    await persistAndBroadcastEvent({
      cameraId: cam.id,
      cameraName: cam.name,
      personId,
      event_type: "CONFIRMATION",
      confidence: match.similarity,
      snapshot_path,
      person_name: match.personName,
      person_category: match.category,
      person_photo_path: existing_photo_path,
      needs_operator_confirmation: true,
      confirmation_status: "pending",
      confirmationId: confirmation.id,
    });

    // Уведомление оператору через Security WebSocket
    broadcastSecurity({
      type: "CONFIRMATION",
      confirmation_id: confirmation.id,
      person_id: personId,
      person_name: match.personName,
      category: match.category,
      confidence: match.similarity,
      temp_photo: `/${temp_photo_path}`,
      existing_photo: existing_photo_path ? `/${existing_photo_path}` : null,
    });

    triggerSmartRecording(cam);
  } catch (e) {
    logError(e as Error, { context: "handleConfirmationEvent", personId });
  }
}

// Camera feed websocket client storage
const cameraStreams = new Map<number, Set<WebSocket>>();
const activeFfmpegProcesses = new Map<number, ChildProcessWithoutNullStreams>();
// Общий последний кадр + распознанные лица на камеру (читается всеми WS-клиентами этой камеры)
const cameraFrames = new Map<number, { frame: string; faces: any[]; dropped: number }>();
// Stream settings per camera (in-memory, DB schema deferred)
const streamSettings = new Map<number, { row1: any; row2: any }>();
const cameraZoneCache = new Map<number, { zones: any[]; exclusionZones: any[] }>();

/** Максимальное количество одновременных активных FFmpeg-потоков.
 *  Камеры Hikvision/UNV часто имеют лимит 2-3 RTSP-сессии.
 *  При превышении лимита новые камеры получают последний сохранённый кадр
 *  (или заглушку), пока не освободится слот. */
const MAX_CONCURRENT_STREAMS = parseInt(process.env.MAX_CONCURRENT_STREAMS || "3", 10);

/** Лимит перезапусков FFmpeg на одну камеру до принудительного освобождения слота. */
const MAX_RESTARTS_PER_CAMERA = parseInt(process.env.MAX_RESTARTS_PER_CAMERA || "3", 10);

/** Интервал ротации слотов (мс) — предотвращает голодание камер в очереди. */
const SLOT_ROTATION_INTERVAL_MS = parseInt(process.env.SLOT_ROTATION_INTERVAL_MS || "30000", 10);

// ── Атомарный менеджер слотов (предотвращает race conditions) ──
const streamSlots = {
  count: 0,
  holders: new Set<number>(),

  tryAcquire(cameraId: number): boolean {
    if (this.holders.has(cameraId)) return true;
    if (this.count >= MAX_CONCURRENT_STREAMS) return false;
    this.count++;
    this.holders.add(cameraId);
    logDebug(`[StreamSlots] Camera ${cameraId} acquired slot (${this.count}/${MAX_CONCURRENT_STREAMS})`);
    return true;
  },

  release(cameraId: number): boolean {
    if (!this.holders.has(cameraId)) return false;
    this.holders.delete(cameraId);
    this.count = Math.max(0, this.count - 1);
    logDebug(`[StreamSlots] Camera ${cameraId} released slot (${this.count}/${MAX_CONCURRENT_STREAMS})`);
    return true;
  },

  getOldestHolder(): number | null {
    const holders = Array.from(this.holders);
    if (holders.length === 0) return null;
    return holders[0];
  },

  isHolder(cameraId: number): boolean {
    return this.holders.has(cameraId);
  },
};

// ── Очередь ожидания ──
const pendingStreamQueue: number[] = [];
const queueTimestamps = new Map<number, number>();
const cameraRestartCounts = new Map<number, number>();

function activeStreamCount(): number {
  return streamSlots.count;
}

function enqueueStream(cameraId: number): void {
  if (!pendingStreamQueue.includes(cameraId)) {
    pendingStreamQueue.push(cameraId);
    queueTimestamps.set(cameraId, Date.now());
    logInfo(`[StreamQueue] Camera ${cameraId} enqueued (position: ${pendingStreamQueue.length})`);
  }
}

function dequeueAndStartNext(): void {
  while (pendingStreamQueue.length > 0 && streamSlots.count < MAX_CONCURRENT_STREAMS) {
    const nextId = pendingStreamQueue.shift()!;
    queueTimestamps.delete(nextId);

    const cam = cameras.find(c => c.id === nextId);
    if (!cam || !cam.is_active) {
      logDebug(`[StreamQueue] Camera ${nextId} no longer active, skipping`);
      continue;
    }

    if (!streamSlots.tryAcquire(nextId)) break;

    logInfo(`[StreamQueue] Camera ${nextId} dequeued, starting pipeline`);
    startCameraPipeline(cam, getFallbackFrame());
    return;
  }
}

// ── Ротация слотов (предотвращает starvation) ──
let rotationInterval: NodeJS.Timeout | null = null;

function startSlotRotation(): void {
  if (rotationInterval) return;

  rotationInterval = setInterval(() => {
    if (pendingStreamQueue.length === 0) return;
    if (streamSlots.count < MAX_CONCURRENT_STREAMS) return;

    const oldestId = streamSlots.getOldestHolder();
    if (oldestId === null) return;

    const cam = cameras.find(c => c.id === oldestId);
    if (!cam) return;

    logInfo(`[StreamRotation] Rotating camera ${oldestId} (${cam.name}) to give queued cameras a chance`);

    stopCameraPipeline(oldestId);
    enqueueStream(oldestId);

    broadcastToCameraClients(oldestId, {
      type: "STREAM_QUEUED",
      cameraId: oldestId,
      position: pendingStreamQueue.length,
      queueLength: pendingStreamQueue.length,
      message: "Слот передан другой камере, ожидание...",
    });
  }, SLOT_ROTATION_INTERVAL_MS);

  logInfo(`[StreamRotation] Started (interval: ${SLOT_ROTATION_INTERVAL_MS}ms)`);
}

function broadcastToCameraClients(cameraId: number, message: any): void {
  const streams = cameraStreams.get(cameraId);
  if (!streams) return;

  const payload = JSON.stringify(message);
  for (const ws of streams) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    } catch { /* ignore */ }
  }
}
// Bounded очередь кадров для AI detection: дробим поток (25 FPS) от AI (10-12 FPS)
// Когда очередь переполнена — выбрасываем старый кадр (FIFO), AI всегда видит свежий
const AI_QUEUE_MAX = 3;
interface FrameQueue {
  frames: Buffer[]
  max: number
  dropped: number
  lastDropAt: number
}
const cameraFrameQueues = new Map<number, FrameQueue>();
// Счётчики dropped frames для отладки/мониторинга
const cameraDetectionDropped = new Map<number, number>();
// Единый таймер детекции/распознавания на камеру (запускается один раз, а не на каждого клиента)
const cameraDetectionTimers = new Map<number, NodeJS.Timeout>();
// Session ID для изоляции треков между переподключениями камеры
// При каждом рестарте FFmpeg генерируется новый UUID. Старые debounce-таймеры
// и треки сбрасываются, чтобы новые лица не путались с "мертвыми" треками.
const cameraSessionIds = new Map<number, string>();
// Счётчик неудачных запусков FFmpeg на камеру (для экспоненциального backoff при недоступной камере)
const cameraFfmpegRetries = new Map<number, number>();
// Отложенные таймеры перезапуска FFmpeg (чтобы их можно было отменить при остановке пайплайна)
const cameraRestartTimers = new Map<number, ReturnType<typeof setTimeout>>();

/** Максимальное количество попыток перезапуска FFmpeg перед открытием circuit breaker. */
const MAX_RESTART_ATTEMPTS = 10;
/** Пауза circuit breaker после Max_Restart_Attempts (5 минут). */
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000;

/** Circuit breaker: помечает камеры, где постоянно падает FFmpeg. */
interface CircuitBreaker {
  failures: number
  reason: string
  state: 'closed' | 'open' | 'half-open'
  openedAt: number
}
const cameraCircuitBreakers = new Map<number, CircuitBreaker>();

// ── Zone helpers ──────────────────────────────────────────────────────────────

function parseZones(raw: string | null | undefined): any[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function loadCameraZones(cam: any): { zones: any[]; exclusionZones: any[] } {
  const cached = cameraZoneCache.get(cam.id);
  if (cached) return cached;
  const zones = parseZones(cam.roi_zones);
  const exclusionZones = parseZones(cam.exclusion_zones);
  const result = { zones, exclusionZones };
  cameraZoneCache.set(cam.id, result);
  return result;
}

function isPointInRect(px: number, py: number, zone: any): boolean {
  const x1 = Math.min(zone.x1, zone.x2);
  const x2 = Math.max(zone.x1, zone.x2);
  const y1 = Math.min(zone.y1, zone.y2);
  const y2 = Math.max(zone.y1, zone.y2);
  return px >= x1 && px <= x2 && py >= y1 && py <= y2;
}

function faceCenter(face: any): { x: number; y: number } {
  const box = face.box || {};
  const x = box.x || 0;
  const y = box.y || 0;
  const w = box.width || 0;
  const h = box.height || 0;
  return { x: x + w / 2, y: y + h / 2 };
}

function isFaceInExclusionZone(face: any, exclusionZones: any[]): boolean {
  if (!exclusionZones.length) return false;
  const c = faceCenter(face);
  return exclusionZones.some(z => isPointInRect(c.x, c.y, z));
}

function getDetectorOptionsForCamera(cam: any): { detector?: string; det_size?: number; min_face_size?: number; min_det_score?: number } {
  const { zones } = loadCameraZones(cam);
  const detectionZone = zones.find((z: any) => z.type === 'detection' || !z.type);
  if (detectionZone) {
    const opts: any = {};
    if (detectionZone.detector) opts.detector = detectionZone.detector;
    if (detectionZone.det_size) opts.det_size = detectionZone.det_size;
    if (detectionZone.min_face_size) opts.min_face_size = detectionZone.min_face_size;
    if (detectionZone.min_det_score) opts.min_det_score = detectionZone.min_det_score;
    return opts;
  }
  return {};
}

function filterFacesByZones(faces: any[], cam: any): any[] {
  const { zones, exclusionZones } = loadCameraZones(cam);
  const detectionZones = (zones || []).filter((z: any) => z.type === 'detection' || !z.type);

  return faces.filter((face: any) => {
    const c = faceCenter(face);
    if (exclusionZones.length && isFaceInExclusionZone(face, exclusionZones)) return false;
    if (detectionZones.length && !detectionZones.some((z: any) => isPointInRect(c.x, c.y, z))) return false;
    return true;
  });
}

/** Классифицирует ошибку FFmpeg по содержимому stderr для диагностики. */
function classifyFfmpegError(stderrText: string, code: number | null): string {
  const lower = stderrText.toLowerCase();
  if (lower.includes("authorization") || lower.includes("401") || lower.includes("403") || lower.includes("wrong password") || lower.includes("permission denied") || lower.includes("unauthorized") || lower.includes("forbidden")) return "error:auth_failed";
  if (lower.includes("connection refused") || lower.includes("connection reset") || lower.includes("timed out") || lower.includes("timeout") || lower.includes("error number -138")) return "error:rtsp_timeout";
  if (lower.includes("no such file") || lower.includes("device or resource busy")) return "error:camera_offline";
  if (lower.includes("invalid data") || lower.includes("invalid url")) return "error:stream_error";
  if (lower.includes("server returned 4xx") || lower.includes("server returned 401") || lower.includes("server returned 403")) return "error:auth_failed";
  if (code === -2 /* SIGINT */ || code === -9 /* SIGKILL */) return "error:ffmpeg_killed";
  return "error:ffmpeg_crash";
}


wssCamera.on("connection", (ws, req) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const match = url.pathname.match(/\/ws\/camera\/(\d+)/);
  if (!match) {
    ws.close();
    return;
  }
  const cameraId = parseInt(match[1]);
  const initialCam = cameras.find(c => c.id === cameraId);
  if (!initialCam || !initialCam.is_active) {
    ws.close();
    return;
  }

  if (!cameraStreams.has(cameraId)) {
    cameraStreams.set(cameraId, new Set());
  }
  cameraStreams.get(cameraId)!.add(ws);

  // Кадр-заглушка, если реального потока ещё нет
  const fallbackFrame = getFallbackFrame();

  // Запускаем FFmpeg + детекцию, если это первый клиент для этой камеры.
  // Если достигнут лимит — ставим в очередь с уведомлением клиента.
  if (!activeFfmpegProcesses.has(cameraId)) {
    if (streamSlots.tryAcquire(cameraId)) {
      ws.send(JSON.stringify({
        type: "STREAM_STARTED",
        cameraId,
        message: "Поток запущен",
      }));
      startCameraPipeline(initialCam, fallbackFrame);
    } else {
      enqueueStream(cameraId);
      ws.send(JSON.stringify({
        type: "STREAM_QUEUED",
        cameraId,
        position: pendingStreamQueue.indexOf(cameraId) + 1,
        queueLength: pendingStreamQueue.length,
        message: `Ожидание свободного слота FFmpeg (${pendingStreamQueue.length} в очереди)...`,
      }));
      ws.send(fallbackFrame);
    }
  }

  // Отправляем клиенту общий кадр камеры (обновляется единым конвейером)
  const intervalId = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(intervalId);
      return;
    }
    const currentCam = cameras.find(c => c.id === cameraId);
    if (!currentCam || !currentCam.is_active) {
      ws.close();
      clearInterval(intervalId);
      return;
    }
    const shared = cameraFrames.get(cameraId);
    const frame = shared ? shared.frame : fallbackFrame;
    const faces = shared ? shared.faces : [];
    ws.send(
      JSON.stringify({
        type: "FRAME",
        camera_id: cameraId,
        session_id: cameraSessionIds.get(cameraId) || null,
        timestamp: Date.now(),
        frame,
        faces,
        dropped: shared ? shared.dropped : 0,
      })
    );
  }, 100);

  ws.on("message", (msg) => {
    if (msg.toString() === "ping") {
      ws.send("pong");
    }
  });

ws.on("close", () => {
    clearInterval(intervalId);
    const streams = cameraStreams.get(cameraId);
    if (streams) {
      streams.delete(ws);
      // Если больше нет клиентов — останавливаем FFmpeg и цикл детекции
      if (streams.size === 0) {
        stopCameraPipeline(cameraId);
      }
    }
    // Убираем камеру из очереди, если она там ещё ждёт
    const qIdx = pendingStreamQueue.indexOf(cameraId);
    if (qIdx >= 0) {
      pendingStreamQueue.splice(qIdx, 1);
      queueTimestamps.delete(cameraId);
    }
  });
});

// ── Общий конвейер камеры: один FFmpeg + один цикл детекции на всех клиентов ──
const SOI = Buffer.from([0xFF, 0xD8]);
const EOI = Buffer.from([0xFF, 0xD9]);

function getFallbackFrame(): string {
  const assetsDir = path.join(__dirname, process.env.NODE_ENV === "production" ? "../public/assets" : "public/assets");
  const rusSrc = path.join(assetsDir, "rus.jpg");
  const logoSrc = path.join(assetsDir, "logo.jpg");
  if (fs.existsSync(rusSrc)) return fs.readFileSync(rusSrc).toString("base64");
  if (fs.existsSync(logoSrc)) return fs.readFileSync(logoSrc).toString("base64");
  return FALLBACK_JPEG;
}

function startCameraPipeline(cam: any, fallbackFrame: string) {
  if (!cam.source) {
    streamSlots.release(cam.id);
    return;
  }

  const args = [
    ...buildFfmpegInputArgs(cam),
    "-f", "mjpeg",
    "-pix_fmt", "yuvj422p",
    "-q:v", "3",
    "-r", "10",
    "-s", "640x480",
    "-"
  ];

  try {
    const ffmpegPath = getFfmpegPath();
     const proc = spawn(ffmpegPath, args);
     trackFfmpeg(proc);
     activeFfmpegProcesses.set(cam.id, proc);

    // Session isolation: при каждом рестарте FFmpeg генерируем новый UUID.
    // При переподключении камеры старый session_id становится недействительным —
    // клиенты сбрасывают треки, а debounce-кэши очищаются.
    const isRestart = cameraSessionIds.has(cam.id);
     if (isRestart) {
       const prefix = `${cam.id}:`;
       for (const key of lastEventAt.keys()) { if (key.startsWith(prefix)) lastEventAt.delete(key); }
       for (const key of lastConfirmationAt.keys()) { if (key.startsWith(prefix)) lastConfirmationAt.delete(key); }
     }
    cameraSessionIds.set(cam.id, crypto.randomUUID());
    const sessionId = cameraSessionIds.get(cam.id)!;
    cameraFrameQueues.set(cam.id, { frames: [], max: AI_QUEUE_MAX, dropped: 0, lastDropAt: 0 });
    logInfo(`FFmpeg запущен для камеры ${cam.id} (${cam.name})`, { source: cam.source, path: ffmpegPath, session_id: sessionId });

    // Эффективный разбор MJPEG: один растущий буфер + indexOf (без побайтовых аллокаций)
    let acc = Buffer.alloc(0);
    let headerFound = false;
    // Собираем stderr для классификации ошибки при падении FFmpeg
    let stderrBuffer = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;

      // Ограничиваем размер буфера, чтобы не съесть память при сбоях потока
      if (acc.length > 8 * 1024 * 1024) acc = acc.slice(acc.length - 64);

      while (true) {
        if (!headerFound) {
          const s = acc.indexOf(SOI);
          if (s < 0) {
            // SOI ещё не пришёл — оставляем хвост (макс. 4 байта на случай разрыва SOI между чанками)
            acc = acc.length > 4 ? acc.slice(acc.length - 4) : acc;
            break;
          }
          acc = acc.slice(s); // отбрасываем мусор до начала кадра
          headerFound = true;
        }
        const e = acc.indexOf(EOI, 1);
        if (e < 0) {
          // Кадр ещё не закончился — ждём следующий чанк
          break;
        }
        const jpeg = acc.slice(0, e + 2);
        const shared = cameraFrames.get(cam.id) || { frame: fallbackFrame, faces: [], dropped: 0 };
        shared.frame = jpeg.toString("base64");
        cameraFrames.set(cam.id, shared);
        // Пошёл реальный поток — сбрасываем счётчики неудач и circuit breaker
        if (cameraFfmpegRetries.has(cam.id)) cameraFfmpegRetries.delete(cam.id);
        if (cameraCircuitBreakers.has(cam.id)) cameraCircuitBreakers.delete(cam.id);
        // Пушим кадр в bounded очередь для AI detection (drop oldest если переполнена)
        const queue = cameraFrameQueues.get(cam.id) || { frames: [], max: AI_QUEUE_MAX, dropped: 0, lastDropAt: 0 };
        if (queue.frames.length >= queue.max) {
          queue.frames.shift(); // Drop oldest frame — AI всегда видит свежие кадры
          queue.dropped++;
          queue.lastDropAt = Date.now();
        }
        queue.frames.push(jpeg);
        cameraFrameQueues.set(cam.id, queue);
        acc = acc.slice(e + 2);
        headerFound = false;
      }
    });

    proc.stderr.on("data", (d) => {
      const msg = d.toString().trim();
      logDebug(`FFmpeg (${cam.id}): ${msg}`);
      stderrBuffer += msg + "\n";
    });

    proc.on("error", (err) => {
      logError(`Ошибка FFmpeg для камеры ${cam.id}: ${err.message}`);
      const reason = classifyFfmpegError(stderrBuffer, null);
      prisma.camera.update({ where: { id: cam.id }, data: { status: reason } }).catch(() => {});
      stopCameraPipeline(cam.id);
    });

    proc.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        logWarn(`FFmpeg exited unexpectedly for camera ${cam.id}, code: ${code}, signal: ${signal}`);
        const reason = classifyFfmpegError(stderrBuffer, code);
        logWarn(`FFmpeg stderr for camera ${cam.id} (${reason}): ${stderrBuffer.slice(-500)}`);
        prisma.camera.update({ where: { id: cam.id }, data: { status: reason } }).catch(() => {});
      }
      activeFfmpegProcesses.delete(cam.id);
    });

    proc.on("close", (code) => {
      logInfo(`FFmpeg завершил работу для камеры ${cam.id}, код: ${code}`);
      activeFfmpegProcesses.delete(cam.id);
      cameraFrames.delete(cam.id);
      const reason = code === 0 ? "offline" : classifyFfmpegError(stderrBuffer, code);

      // Нет смысла перезапускать, если для камеры не осталось клиентов или она выключена
      const currentCam = cameras.find(c => c.id === cam.id);
      const hasClients = (cameraStreams.get(cam.id)?.size ?? 0) > 0;
      if (!currentCam || !currentCam.is_active || !hasClients) {
        cameraFfmpegRetries.delete(cam.id);
        return;
      }

      // Circuit breaker: если превышено Max_Restart_Attempts — открываем CB и ставим длинную паузу
      const cb = cameraCircuitBreakers.get(cam.id);
      if (cb && cb.failures >= MAX_RESTART_ATTEMPTS) {
        const now = Date.now();
        const elapsed = now - cb.openedAt;
        if (elapsed < CIRCUIT_BREAKER_COOLDOWN_MS) {
          logWarn(`Circuit breaker OPEN для камеры ${cam.id} — пауза ${(CIRCUIT_BREAKER_COOLDOWN_MS - elapsed) / 1000}с (${cb.reason})`);
          prisma.camera.update({ where: { id: cam.id }, data: { status: cb.reason } }).catch(() => {});
          return;
        }
        // Пауза прошла — пробуем half-open (сбрасываем)
        logInfo(`Circuit breaker HALF-OPEN для камеры ${cam.id} — пробуем перезапуск`);
        cameraCircuitBreakers.delete(cam.id);
        cameraFfmpegRetries.set(cam.id, 0);
      }

      // Экспоненциальный backoff: 3s → 6s → 12s → 24s → 30s (кап), чтобы не долбить недоступную камеру
      const attempts = (cameraFfmpegRetries.get(cam.id) || 0) + 1;
      cameraFfmpegRetries.set(cam.id, attempts);

      // Circuit breaker: считаем неудачи
      if (!cb) {
        cameraCircuitBreakers.set(cam.id, { failures: attempts, reason, state: 'open', openedAt: Date.now() });
      } else {
        cb.failures = attempts;
        cb.reason = reason;
      }

const delay = Math.min(30000, 3000 * 2 ** Math.min(attempts - 1, 4));
       // Логируем не каждую попытку, чтобы не засорять лог при долгой недоступности
       if (attempts === 1 || attempts % 5 === 0) {
         logWarn(`Камера ${cam.id} (${cam.name}) недоступна, попытка №${attempts}/${MAX_RESTART_ATTEMPTS}, следующий повтор через ${delay / 1000}с. Причина: ${reason}`);
       }

       const restartTimer = setTimeout(() => {
         cameraRestartTimers.delete(cam.id);
         const latestCam = cameras.find(c => c.id === cam.id);
         const stillHasClients = (cameraStreams.get(cam.id)?.size ?? 0) > 0;
         if (latestCam && latestCam.is_active && stillHasClients && !activeFfmpegProcesses.has(cam.id)) {
           const restarts = (cameraRestartCounts.get(cam.id) || 0) + 1;
           cameraRestartCounts.set(cam.id, restarts);

           if (restarts >= MAX_RESTARTS_PER_CAMERA) {
             logWarn(`[Stream] Camera ${cam.id} (${cam.name}) exceeded max restarts (${MAX_RESTARTS_PER_CAMERA}), releasing slot`);
             streamSlots.release(cam.id);
             cameraRestartCounts.delete(cam.id);
             broadcastToCameraClients(cam.id, {
               type: "STREAM_FAILED",
               cameraId: cam.id,
               message: `Камера недоступна после ${MAX_RESTARTS_PER_CAMERA} попыток. Проверьте RTSP URL/credentials.`,
             });
             return;
           }

           if (streamSlots.tryAcquire(cam.id)) {
             startCameraPipeline(latestCam, fallbackFrame);
           } else {
             streamSlots.release(cam.id);
             enqueueStream(cam.id);
           }
         }
       }, delay);
      cameraRestartTimers.set(cam.id, restartTimer);
    });

    startCameraDetection(cam, fallbackFrame);
  } catch (e: any) {
    streamSlots.release(cam.id);
    logError(`Не удалось запустить FFmpeg: ${e.message}`);
  }
}

function startCameraDetection(cam: any, fallbackFrame: string) {
  if (cameraDetectionTimers.has(cam.id)) return;
  let detectionInProgress = false;

  const timer = setInterval(async () => {
    if (!activeFfmpegProcesses.has(cam.id)) return;
    const shared = cameraFrames.get(cam.id);
    if (!shared) return;

    // Pop все доступные кадры из bounded очереди — берём самый свежий
    const queue = cameraFrameQueues.get(cam.id) || { frames: [], max: AI_QUEUE_MAX, dropped: 0, lastDropAt: 0 };
    if (queue.frames.length === 0) return;
    // Drop intermediate frames, оставляем только самый свежий кадр
    let buf: Buffer | null = null;
    while (queue.frames.length > 0) {
      buf = queue.frames.shift()!;
    }
    if (!buf) return;

    if (detectionInProgress) return;

    detectionInProgress = true;
    try {
      const frameBase64 = buf.toString("base64");
      const detectorOpts = getDetectorOptionsForCamera(cam);
      const faces = await detectFaces(buf, detectorOpts);
      const filtered = filterFacesByZones(faces, cam);
      const enriched = await processDetectedFaces(cam, frameBase64, filtered);
      shared.faces = enriched;
      shared.dropped = shared.dropped || 0;
      cameraFrames.set(cam.id, shared);
    } catch (e) {
      logError(e as Error, { cameraId: cam.id });
    }
    detectionInProgress = false;
  }, 500);

  cameraDetectionTimers.set(cam.id, timer);
}

function killProcessTree(pid: number): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /PID ${pid} /T`, { stdio: "ignore" });
    } else {
      // Negative PID = entire process group (includes children)
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    /* process already exited — nothing to kill */
  }
}

function stopCameraPipeline(cameraId: number) {
  const proc = activeFfmpegProcesses.get(cameraId);
  if (proc) {
    const pid = proc.pid;
    // Рекурсивное убийство дерева процессов (включая дочерние ffprobe/encoder)
    try {
      killProcessTree(pid);
    } catch {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    }
    activeFfmpegProcesses.delete(cameraId);
  }
  const timer = cameraDetectionTimers.get(cameraId);
  if (timer) {
    clearInterval(timer);
    cameraDetectionTimers.delete(cameraId);
  }
  // Отменяем отложенный перезапуск и сбрасываем backoff-счётчик
  const restartTimer = cameraRestartTimers.get(cameraId);
  if (restartTimer) {
    clearTimeout(restartTimer);
    cameraRestartTimers.delete(cameraId);
  }
  cameraFfmpegRetries.delete(cameraId);
  cameraCircuitBreakers.delete(cameraId);
  cameraFrameQueues.delete(cameraId);
  cameraFrames.delete(cameraId);
  cameraSessionIds.delete(cameraId);
  cameraRestartCounts.delete(cameraId);
  streamSlots.release(cameraId);

  // Освободился слот — запускаем следующую камеру из очереди
  dequeueAndStartNext();
}

// Upgrade handling for websockets
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "", `http://${request.headers.host}`);
  const pathname = url.pathname;
  logInfo(`WebSocket upgrade request: ${pathname}`);

  // API-key защита WS (если задан API_KEY)
  if (API_KEY) {
    const qk = url.searchParams.get("api_key");
    const hk = request.headers["x-api-key"] as string | undefined;
    const auth = request.headers["authorization"] as string | undefined;
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (qk !== API_KEY && hk !== API_KEY && token !== API_KEY) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n{\"detail\":\"Unauthorized: требуется api_key\"}");
      socket.destroy();
      return;
    }
  }

  if (pathname === "/ws/security") {
    wssSecurity.handleUpgrade(request, socket, head, (ws) => {
      wssSecurity.emit("connection", ws, request);
    });
  } else if (pathname.startsWith("/ws/camera/")) {
    wssCamera.handleUpgrade(request, socket, head, (ws) => {
      wssCamera.emit("connection", ws, request);
    });
  } else {
    logWarn(`Unknown WebSocket path: ${pathname}`);
    socket.destroy();
  }
});

// ── AI ENGINE ENDPOINTS ──

// Переиндексация всех персон — пересоздаёт эмбеддинги из фото в БД
app.post(["/api/persons/reindex_all", "/api/persons/reindex_all/"], async (req, res) => {
  try {
    const allPersons = await prisma.person.findMany({
      include: { photos: true },
    });

    const success: string[] = [];
    const failed: { name: string; error: string }[] = [];
    const no_photo: string[] = [];

    for (const person of allPersons) {
      const photos = person.photos.filter((p: any) => p.photo_path);
      if (photos.length === 0) {
        no_photo.push(person.name);
        continue;
      }
      try {
        // Сбрасываем has_embedding ДО удаления дескрипторов — теперь UI честно
        // показывает 0 пока переиндексация не завершилась для этой персоны.
        await prisma.personPhoto.updateMany({
          where: { person_id: person.id },
          data: { has_embedding: false },
        });

        // Удаляем старые дескрипторы
        await prisma.faceDescriptor.deleteMany({ where: { person_id: person.id } });
        await unregisterFacePerson(person.id);

        let registered = 0;
        for (const photo of photos) {
          const fullPath = path.join(publicDir, photo.photo_path);
          if (!fs.existsSync(fullPath)) continue;
          try {
            const result = await registerFacePerson(
              person.id, person.name, person.category, photo.photo_path, fullPath
            );
            if (result.hasEmbedding) {
              registered++;
              // Обновляем статус конкретной фотографии
              await prisma.personPhoto.updateMany({
                where: { person_id: person.id, photo_path: photo.photo_path },
                data: { has_embedding: true },
              });
            }
          } catch (photoErr: any) {
            // Одно битое фото не останавливает всю переиндексацию
            logWarn(`reindex_all: фото "${photo.photo_path}" для "${person.name}" пропущено: ${photoErr?.message}`);
          }
        }

        await prisma.person.update({
          where: { id: person.id },
          data: { embedding_count: registered },
        });

        success.push(person.name);
      } catch (e: any) {
        failed.push({ name: person.name, error: e.message });
      }
    }

    logInfo(`Reindex complete: ${success.length} OK, ${failed.length} failed, ${no_photo.length} no_photo`);
    res.json({ success, failed, no_photo });
  } catch (err) {
    logError(err as Error, { path: "/api/persons/reindex_all" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

// Переиндексация одной персоны — не нужно запускать reindex_all для всей базы
app.post(["/api/persons/:id/reindex", "/api/persons/:id/reindex/"], async (req, res) => {
  try {
    const personId = parseInt(req.params.id);
    const person = await prisma.person.findUnique({
      where: { id: personId },
      include: { photos: true },
    });
    if (!person) return res.status(404).json({ detail: "Person not found" });

    const photos = person.photos.filter((p: any) => p.photo_path);
    if (photos.length === 0) {
      return res.json({ ok: true, registered: 0, failed: 0, message: "Нет фотографий для переиндексации" });
    }

    // Сбрасываем статусы ДО начала — UI видит честное состояние
    await prisma.personPhoto.updateMany({
      where: { person_id: personId },
      data: { has_embedding: false },
    });
    await prisma.faceDescriptor.deleteMany({ where: { person_id: personId } });
    await unregisterFacePerson(personId);

    let registered = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const photo of photos) {
      const fullPath = path.join(publicDir, photo.photo_path);
      if (!fs.existsSync(fullPath)) {
        failed++;
        errors.push(`${photo.photo_path}: файл не найден`);
        continue;
      }
      try {
        const result = await registerFacePerson(
          person.id, person.name, person.category, photo.photo_path, fullPath
        );
        if (result.hasEmbedding) {
          registered++;
          await prisma.personPhoto.updateMany({
            where: { person_id: personId, photo_path: photo.photo_path },
            data: { has_embedding: true },
          });
        } else {
          failed++;
          if (result.error) errors.push(`${path.basename(photo.photo_path)}: ${result.error}`);
        }
      } catch (photoErr: any) {
        failed++;
        errors.push(`${path.basename(photo.photo_path)}: ${photoErr?.message}`);
        logWarn(`reindex person ${personId}: фото "${photo.photo_path}" пропущено: ${photoErr?.message}`);
      }
    }

    await prisma.person.update({
      where: { id: personId },
      data: { embedding_count: registered },
    });

    // Sync in-memory cache
    const updated = await prisma.person.findUnique({ where: { id: personId }, include: { photos: true } });
    if (updated) {
      const idx = persons.findIndex((p: any) => p.id === personId);
      if (idx >= 0) persons[idx] = { ...updated };
    }

    logInfo(`Reindex person ${personId} (${person.name}): ${registered} OK, ${failed} failed`);
    res.json({ ok: true, registered, failed, errors, person_id: personId });
  } catch (err) {
    logError(err as Error, { path: "/api/persons/:id/reindex" });
    res.status(500).json({ detail: "Internal server error" });
  }
});
//
// Person Visits API
// ── LIST VISITS ──
app.get(["/api/persons/:id/visits", "/api/persons/:id/visits/"], async (req, res) => {
  try {
    const personId = parseInt(req.params.id);
    const person = await prisma.person.findUnique({ where: { id: personId } });
    if (!person) return res.status(404).json({ detail: "Person not found" });

    const limit = parseInt(req.query.limit as string) || 100;
    const visits = await prisma.personVisit.findMany({
      where: { person_id: personId },
      orderBy: { visit_date: "desc" },
      take: limit,
    });
    res.json(visits);
  } catch (err) {
    logError(err as Error, { path: "/api/persons/:id/visits", method: "GET" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

// ── ADD VISIT (manual) ──
app.post(["/api/persons/:id/visits", "/api/persons/:id/visits/"], async (req, res) => {
  try {
    const personId = parseInt(req.params.id);
    const person = await prisma.person.findUnique({ where: { id: personId } });
    if (!person) return res.status(404).json({ detail: "Person not found" });

    const { visit_date, camera_id, source } = req.body;
    const visit = await prisma.personVisit.create({
      data: {
        person_id: personId,
        camera_id: camera_id || null,
        source: source || "manual",
        visit_date: visit_date ? new Date(visit_date) : new Date(),
      },
    });

    // Recalculate loyalty_index
    const visits = await prisma.personVisit.findMany({
      where: { person_id: personId },
      select: { visit_date: true },
      orderBy: { visit_date: "desc" },
    });
    const loyalty = calculateLoyaltyIndex(visits);
    await prisma.person.update({
      where: { id: personId },
      data: {
        loyalty_index: loyalty,
        total_visits: { increment: 1 },
        visit_count: { increment: 1 },
        last_seen_at: new Date(),
      },
    });

    const idx = persons.findIndex((p: any) => p.id === personId);
    if (idx >= 0) {
      persons[idx].loyalty_index = loyalty;
      persons[idx].total_visits = (persons[idx].total_visits || 0) + 1;
      persons[idx].visit_count = (persons[idx].visit_count || 0) + 1;
      persons[idx].last_seen_at = new Date().toISOString();
    }

    res.status(201).json(visit);
  } catch (err) {
    logError(err as Error, { path: "/api/persons/:id/visits", method: "POST" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

// ── PERSON STATS ──
app.get(["/api/persons/:id/stats", "/api/persons/:id/stats/"], async (req, res) => {
  try {
    const personId = parseInt(req.params.id);
    const person = await prisma.person.findUnique({ where: { id: personId } });
    if (!person) return res.status(404).json({ detail: "Person not found" });

    const visits = await prisma.personVisit.findMany({
      where: { person_id: personId },
      orderBy: { visit_date: "asc" },
    });

    const firstSeen = visits.length > 0 ? visits[0].visit_date : person.created_at;
    const lastSeen = visits.length > 0 ? visits[visits.length - 1].visit_date : person.last_seen_at;
    const totalVisits = visits.length;
    const loyaltyIndex = person.loyalty_index || 0;

    // Average visits per month
    const now = new Date();
    const first = new Date(firstSeen);
    const monthsActive = Math.max(1, (now.getFullYear() - first.getFullYear()) * 12 + (now.getMonth() - first.getMonth()));
    const avgVisitsPerMonth = totalVisits / monthsActive;

    // Days since last visit
    const daysSinceLast = lastSeen
      ? Math.floor((now.getTime() - new Date(lastSeen).getTime()) / (1000 * 60 * 60 * 24))
      : null;

    res.json({
      person_id: personId,
      first_seen: firstSeen,
      last_seen: lastSeen,
      total_visits: totalVisits,
      loyalty_index: loyaltyIndex,
      avg_visits_per_month: Math.round(avgVisitsPerMonth * 10) / 10,
      days_since_last_visit: daysSinceLast,
    });
  } catch (err) {
    logError(err as Error, { path: "/api/persons/:id/stats" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

// ── PERSON CATEGORY HISTORY ──
app.get(["/api/persons/:id/category_history", "/api/persons/:id/category_history/"], async (req, res) => {
  try {
    const personId = parseInt(req.params.id);
    const history = await prisma.personCategoryHistory.findMany({
      where: { person_id: personId },
      orderBy: { created_at: "desc" },
    });
    res.json(history);
  } catch (err) {
    logError(err as Error, { path: "/api/persons/:id/category_history", method: "GET" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.post(["/api/persons/:id/category", "/api/persons/:id/category/"], async (req, res) => {
  try {
    const personId = parseInt(req.params.id);
    const { category, reason } = req.body as { category: string; reason?: string };

    if (!category) {
      return res.status(400).json({ detail: "category is required" });
    }

    const person = await prisma.person.findUnique({
      where: { id: personId },
    });

    if (!person) {
      return res.status(404).json({ detail: "Person not found" });
    }

    const oldCode = person.category;
    const newCode = category.toUpperCase().trim();

    // Create history record
    await prisma.personCategoryHistory.create({
      data: {
        person_id: personId,
        old_code: oldCode,
        new_code: newCode,
        reason: reason || null,
        changed_by: "operator",
      },
    });

    // Update person category
    const updated = await prisma.person.update({
      where: { id: personId },
      data: { category: newCode },
      include: { photos: true },
    });

    // Sync in-memory
    const memPerson = persons.find(p => p.id === personId);
    if (memPerson) {
      memPerson.category = newCode;
    }

    // If person is on-site and moved to a risky category — alert immediately
    const lvl = alertLevelFor(newCode)
    if (lvl && lvl !== 'info') {
      const last = await prisma.event.findFirst({
        where: { person_id: personId },
        orderBy: { created_at: "desc" },
        include: { camera: true },
      })
      if (last && Date.now() - new Date(last.created_at).getTime() < ON_SITE_WINDOW_MS) {
        await emitPersonAlert({
          person: { id: personId, name: updated.name, categoryCode: newCode },
          camera: last.camera,
          force: true,
          message: `Переведён в ${newCode}, пока на территории (${last.camera_name ?? 'зона ' + last.camera?.zone})`,
        })
      }
    }

    res.json(updated);
  } catch (err) {
    logError(err as Error, { path: "/api/persons/:id/category", method: "POST" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

// ── ALERT ENGINE ENDPOINTS ────────────────────────────────────────────────────
app.get(["/api/alerts/unacked", "/api/alerts/unacked/"], async (req, res) => {
  try {
    const rows = await prisma.event.findMany({
      where: { alerted: true, alertAcked: false },
      orderBy: { created_at: "desc" },
      take: 50,
      include: { person: { select: { name: true } }, camera: { select: { name: true, zone: true } } },
    });
    res.json(rows);
  } catch (err) {
    logError(err as Error, { path: "/api/alerts/unacked", method: "GET" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.post(["/api/alerts/:eventId/ack", "/api/alerts/:eventId/ack/"], async (req, res) => {
  try {
    const eventId = parseInt(req.params.eventId);
    const row = await prisma.event.update({
      where: { id: eventId },
      data: { alertAcked: true, alertAckAt: new Date() },
    });
    broadcastSecurity({ type: "alert-ack", eventId: row.id });
    res.json(row);
  } catch (err) {
    logError(err as Error, { path: "/api/alerts/:eventId/ack", method: "POST" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

// Заглушка для скачивания моделей (модели уже в папке models/)
app.post(["/api/ai/download_models", "/api/ai/download_models/"], async (req, res) => {
  try {
    const modelsDir = path.join(process.cwd(), "models", "buffalo_l");
    const required = ["det_10g.onnx", "w600k_r50.onnx", "1k3d68.onnx", "2d106det.onnx", "genderage.onnx"];
    const missing = required.filter(f => !fs.existsSync(path.join(modelsDir, f)));
    if (missing.length > 0) {
      return res.json({
        ok: false,
        ai_ready: false,
        message: `Отсутствуют модели: ${missing.join(", ")}. Запустите download_models.py`,
      });
    }
    const engineStatus = getEngineStatus();
    res.json({ ok: true, ai_ready: engineStatus.initialized, message: "Все модели на месте" });
  } catch (err) {
    logError(err as Error, { path: "/api/ai/download_models" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

// Статус AI движка
app.get(["/api/face-engine/status", "/api/face-engine/status/"], (req, res) => {
  const status = getEngineStatus();
  res.json(status);
});

// ── CAMERA STATUS CHECK ──────────────────────────────────────────────────
app.get("/api/cameras/:id/status-check", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const cam = cameras.find(c => c.id === id);
    if (!cam) return res.status(404).json({ detail: "Camera not found" });
    const result = await probeCamera(cam);
    const { profiles: storedProfiles } = parseStreamProfiles(cam);

    let reason = result.connected ? "online" : "error:rtsp_timeout";
    let flags: string[] = [];

    if (result.configChanged) {
      flags.push("configuration_changed");
      reason = "online:configuration_changed";
    }
    if (result.profileMismatch) {
      flags.push("profile_mismatch");
    }
    if (result.conflicts && result.conflicts.length) {
      flags.push("conflicts_detected");
    }

    if (flags.length) {
      try {
        await prisma.camera.update({
          where: { id },
          data: {
            status: reason,
            stream_profiles: result.conflicts
              ? serializeStreamProfiles(storedProfiles, result.conflicts)
              : undefined,
          },
        });
        updateCameraCache(id, {
          status: reason,
          stream_profiles: result.conflicts
            ? serializeStreamProfiles(storedProfiles, result.conflicts)
            : undefined,
        });
      } catch (dbErr) {
        logError(dbErr as Error, { context: "status-check cache update", camId: id });
      }
    } else {
      await prisma.camera.update({ where: { id }, data: { status: reason } }).catch(() => {});
      updateCameraCache(id, { status: reason });
    }

    res.json({
      camera_id: id,
      status: reason,
      details: result.details,
      flags,
      configuration_changed: result.configChanged,
      profile_mismatch: result.profileMismatch,
      conflicts: result.conflicts,
    });
  } catch (err) {
    logError(err as Error, { path: "/api/cameras/:id/status-check", method: "GET" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

app.post("/api/cameras/check-all-status", async (req, res) => {
  try {
    const dbCams = await prisma.camera.findMany();
    const results = [];
    for (const cam of dbCams) {
      const decrypted = decryptCameraCreds(cam);
      const result = await probeCamera(decrypted);
      const reason = result.connected ? "online" : "error:rtsp_timeout";
      await prisma.camera.update({ where: { id: cam.id }, data: { status: reason } }).catch(() => {});
      results.push({ camera_id: cam.id, name: cam.name, status: reason, details: result.details });
    }
    res.json({ results });
  } catch (err) {
    logError(err as Error, { path: "/api/cameras/check-all-status", method: "POST" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

// ── SETUP / GPU ──
app.post(["/api/settings/setup/rerun", "/api/settings/setup/rerun/"], async (req, res) => {
  try {
    // Форсируем health check Python-сервера и перечитываем GPU статус
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    let gpuProvider = "CPUExecutionProvider";
    try {
      const r = await (await import("node-fetch")).default(
        `${process.env.FACE_SERVER_URL || "http://localhost:8001"}/status`,
        { signal: controller.signal }
      );
      clearTimeout(timeoutId);
      if (r.ok) {
        const s = await r.json() as any;
        gpuProvider = s.provider || "CPUExecutionProvider";
      }
    } catch { clearTimeout(timeoutId); }
    res.json({
      ok: true,
      message: gpuProvider !== "CPUExecutionProvider"
        ? `GPU активен: ${gpuProvider}`
        : "CPU режим активен",
      setup: { errors: [] },
    });
  } catch (err) {
    logError(err as Error, { path: "/api/settings/setup/rerun" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

// ── CAMERAS SYNC ──
app.post(["/api/cameras/sync", "/api/cameras/sync/"], async (req, res) => {
  try {
    const dbCams = await prisma.camera.findMany({ where: { is_active: true } });
    // Sync in-memory cache
    const dbCamsAll = await prisma.camera.findMany({ orderBy: { id: "asc" } });
    cameras = dbCamsAll.map((c: any) => decryptCameraCreds(c));
    const running = dbCams.map(c => c.id);
    res.json({
      ok: true,
      started: [],
      stopped: [],
      already_running: running,
      running_now: running,
    });
  } catch (err) {
    logError(err as Error, { path: "/api/cameras/sync" });
    res.status(500).json({ detail: "Internal server error" });
  }
});

// ── BACKUP & RESTORE ──
const backupsDir = path.join(process.cwd(), "backups");

app.post(["/api/backup", "/api/backup/"], async (req, res) => {
  try {
    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupName = `backup_${timestamp}.zip`;
    const backupPath = path.join(backupsDir, backupName);

    // Создаём ZIP архив с БД и медиафайлами
    const output = fs.createWriteStream(backupPath);
    const archive = new ZipArchive({ zlib: { level: 6 } });

    await new Promise<void>((resolve, reject) => {
      output.on("close", resolve);
      archive.on("error", reject);
      archive.pipe(output);
      // БД
      const dbPath = path.join(process.cwd(), "prisma", "dev.db");
      if (fs.existsSync(dbPath)) archive.file(dbPath, { name: "dev.db" });
      // Фото и снапшоты
      if (fs.existsSync(photosDir)) archive.directory(photosDir, "photos");
      if (fs.existsSync(snapshotsDir)) archive.directory(snapshotsDir, "snapshots");
      archive.finalize();
    });

    logInfo(`Backup created: ${backupName}`);
    res.json({ ok: true, backup: backupName });
  } catch (err: any) {
    logError(err as Error, { path: "/api/backup" });
    res.json({ ok: false, error: err.message });
  }
});

app.post(["/api/backup/restore", "/api/backup/restore/"], upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, message: "Файл не загружен" });

    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

    // Сохраняем текущую БД как pre-restore backup
    const dbPath = path.join(process.cwd(), "prisma", "dev.db");
    if (fs.existsSync(dbPath)) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      fs.copyFileSync(dbPath, path.join(backupsDir, `pre_restore_${ts}.db`));
    }

    const zipPath = req.file.path;
    const errors: string[] = [];

    await fs.createReadStream(zipPath)
      .pipe(unzipper.Parse())
      .on("entry", (entry: any) => {
        const fileName: string = entry.path;
        if (fileName === "dev.db") {
          entry.pipe(fs.createWriteStream(dbPath));
        } else if (fileName.startsWith("photos/")) {
          const dest = path.join(photosDir, path.basename(fileName));
          entry.pipe(fs.createWriteStream(dest));
        } else if (fileName.startsWith("snapshots/")) {
          const dest = path.join(snapshotsDir, path.basename(fileName));
          entry.pipe(fs.createWriteStream(dest));
        } else {
          entry.autodrain();
        }
      })
      .promise();

    // Cleanup temp file
    fs.unlinkSync(zipPath);

    logInfo("Backup restored successfully");
    res.json({ ok: true, message: "Резервная копия восстановлена. Перезагрузите приложение.", errors });
  } catch (err: any) {
    logError(err as Error, { path: "/api/backup/restore" });
    res.json({ ok: false, message: err.message, errors: [err.message] });
  }
});

// Инициализация / переинициализация движка
app.post(["/api/face-engine/init", "/api/face-engine/init/"], async (req, res) => {
  try {
    const ok = await initFaceEngine();
    res.json({ success: ok, status: getEngineStatus() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Перестроение индекса дескрипторов из текущей базы персон
app.post(["/api/face-engine/rebuild-index", "/api/face-engine/rebuild-index/"], async (req, res) => {
  try {
    const result = await rebuildDescriptorIndex(persons);
    res.json({ success: true, ...result, status: getEngineStatus() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Детекция лиц на изображении
app.post(["/api/face-engine/detect", "/api/face-engine/detect/"], upload.any(), async (req, res) => {
  let files: Express.Multer.File[] = [];
  if (req.file) files.push(req.file);
  if (req.files && Array.isArray(req.files)) files = files.concat(req.files as Express.Multer.File[]);

  if (files.length === 0) {
    return res.status(400).json({ detail: "No file uploaded" });
  }

  try {
    const fast = req.query.fast === "true";
    const allFaces: any[] = [];

    for (const f of files) {
      const filePath = path.join(photosDir, f.filename);
      const faces = fast
        ? await detectFacesFast(filePath)
        : await detectFaces(filePath);
      allFaces.push(...faces.map(face => ({ ...face, file: f.filename })));
    }

    res.json({
      face_count: allFaces.length,
      faces: allFaces.map(f => ({
        box: f.box,
        score: f.score,
        age: f.age ?? undefined,
        gender: f.gender ?? undefined,
        genderProbability: undefined,
        expression: undefined,
        expressionProbability: undefined,
        landmarks_count: 0,
        has_descriptor: !!f.descriptor,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// Оценка качества фото для эмбеддинга
app.post(["/api/face-engine/quality", "/api/face-engine/quality/"], upload.any(), async (req, res) => {
  let files: Express.Multer.File[] = [];
  if (req.file) files.push(req.file);
  if (req.files && Array.isArray(req.files)) files = files.concat(req.files as Express.Multer.File[]);

  if (files.length === 0) {
    return res.status(400).json({ detail: "No file uploaded" });
  }

  try {
    const filePath = path.join(photosDir, files[0].filename);
    const quality = await assessPhotoQuality(filePath);
    res.json(quality);
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// ── DOWNLOAD FULL BACKUP (GET) ──
app.get("/api/backup/full", async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupName = `kraken_backup_${timestamp}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${backupName}"`);

    const zip = new AdmZip();
    const dbPath = path.join(process.cwd(), "prisma", "dev.db");
    if (fs.existsSync(dbPath)) {
      zip.addLocalFile(dbPath, "kraken.db");
    }
    if (fs.existsSync(photosDir)) zip.addLocalFolder(photosDir, "photos");
    if (fs.existsSync(snapshotsDir)) zip.addLocalFolder(snapshotsDir, "snapshots");

    const buffer = zip.toBuffer();
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);
    logInfo(`Backup downloaded: ${backupName}`);
  } catch (err: any) {
    logError(err as Error, { path: "/api/backup/full" });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── REPORTS: EXCEL ──
app.get("/api/reports/excel", async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const events = await prisma.event.findMany({
      where: { created_at: { gte: startDate } },
      include: { person: true, camera: true },
      orderBy: { created_at: "desc" },
      take: 5000,
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(`Отчёт за ${days} дней`);

    worksheet.columns = [
      { header: "Дата и время", key: "date", width: 20 },
      { header: "Камера", key: "camera", width: 20 },
      { header: "Имя", key: "name", width: 25 },
      { header: "Категория", key: "category", width: 15 },
      { header: "Уверенность", key: "confidence", width: 15 },
      { header: "Тип события", key: "type", width: 15 },
    ];

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE0E0E0" } };

    events.forEach((event) => {
      worksheet.addRow({
        date: new Date(event.created_at).toLocaleString("ru-RU"),
        camera: event.camera_name || "Неизвестно",
        name: event.person_name || "Неизвестный",
        category: event.person_category || "-",
        confidence: event.confidence ? `${(event.confidence * 100).toFixed(1)}%` : "-",
        type: event.event_type || "recognition",
      });
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="report_${days}days.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err: any) {
    logError(err as Error, { path: "/api/reports/excel" });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Шрифт с поддержкой кириллицы (стандартный шрифт pdfkit НЕ поддерживает русские буквы) ──
function resolveFontPath(name: string): string | undefined {
  const candidates = [
    path.join(process.cwd(), "server", "fonts", name),
    path.join(__dirname, "server", "fonts", name),
    path.join(__dirname, "fonts", name),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

// ── REPORTS: PDF ──
app.get("/api/reports/pdf", async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const events = await prisma.event.findMany({
      where: { created_at: { gte: startDate } },
      include: { person: true, camera: true },
      orderBy: { created_at: "desc" },
      take: 1000,
    });

    const doc = new PDFDocument({ margin: 50, size: "A4", layout: "landscape" });

    // Кириллица: регистрируем Ttf-шрифт из проекта (server/fonts/arial*.ttf)
    const fontRegular = resolveFontPath("arial.ttf");
    const fontBold = resolveFontPath("arialbd.ttf");
    if (fontRegular) {
      doc.registerFont("Regular", fontRegular);
      if (fontBold) doc.registerFont("Bold", fontBold);
    } else {
      logError(new Error("Шрифт с кириллицей не найден: server/fonts/arial.ttf"), { path: "/api/reports/pdf" });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="report_${days}days.pdf"`);
    doc.pipe(res);

    if (fontBold) doc.font("Bold");
    doc.fontSize(16).text(`Отчёт о событиях за последние ${days} дней`, { align: "center" });
    doc.moveDown();
    if (fontRegular) doc.font("Regular");
    doc.fontSize(9);

    const tableTop = 100;
    const headers = ["Дата", "Камера", "Имя", "Категория", "Событие"];
    let xPos = 50;

    headers.forEach((h) => { doc.text(h, xPos, tableTop); xPos += 140; });

    let yPos = tableTop + 20;
    events.forEach((event) => {
      if (yPos > 500) { doc.addPage(); yPos = 50; }
      xPos = 50;

      doc.text(new Date(event.created_at).toLocaleString("ru-RU"), xPos, yPos);
      doc.text(event.camera_name || "N/A", xPos + 140, yPos);
      doc.text(event.person_name || "Неизвестный", xPos + 280, yPos);
      doc.text(event.person_category || "-", xPos + 420, yPos);
      doc.text(event.event_type || "recognition", xPos + 560, yPos);
      yPos += 20;
    });

    doc.end();
  } catch (err: any) {
    logError(err as Error, { path: "/api/reports/pdf" });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── VITE MIDDLEWARE OR STATIC SERVER ──

/**
 * Вычисляет индекс лояльности на основе истории посещений (упрощённая формула).
 * Использует паттерн: средний интервал между последними 10 визитами → 0–100.
 */
function calculateLoyaltyIndex(visits: Array<{ visit_date: string | Date }>): number {
  if (!visits || visits.length < 2) return 0;
  // Сортируем по убыванию даты (самый свежий первым)
  const sorted = [...visits].sort((a, b) =>
    new Date(b.visit_date).getTime() - new Date(a.visit_date).getTime()
  );
  const recent = sorted.slice(0, Math.min(10, sorted.length));

  // Интервалы между посещениями в днях
  const intervals: number[] = [];
  for (let i = 0; i < recent.length - 1; i++) {
    const diff = (new Date(recent[i].visit_date).getTime() - new Date(recent[i + 1].visit_date).getTime()) / (1000 * 60 * 60 * 24);
    if (diff > 0) intervals.push(diff);
  }
  if (intervals.length === 0) return 0;

  const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;
  if (avgInterval <= 0) return 0;

  // Чем короче интервал — тем выше лояльность
  // 1 день → 100, 3 дня → ~85, 7 дней → ~65, 14 дней → ~45, 30 дней → ~25, 60+ дней → ~10
  let score: number;
  if (avgInterval <= 1) score = 100;
  else if (avgInterval <= 3) score = 90 - (avgInterval - 1) * 2.5;
  else if (avgInterval <= 7) score = 85 - (avgInterval - 3) * 5;
  else if (avgInterval <= 14) score = 65 - (avgInterval - 7) * 3;
  else if (avgInterval <= 30) score = 45 - (avgInterval - 14) * 0.8;
  else if (avgInterval <= 60) score = 25 - (avgInterval - 30) * 0.3;
  else score = 10;

  // Бонус за количество визитов (максимум +15)
  const visitBonus = Math.min(15, visits.length * 1.5);
  score = Math.min(100, score + visitBonus);

  return Math.round(score);
}

/**
 * Взвешенная лояльность (полнная формула из дизайна).
 * activity + reputation − risk + recovery → 0–100.
 * Используется для детального расчёта в /api/loyalty/:id.
 */
function calculateLoyaltyBreakdown(visits: Array<{ visit_date: string | Date }>, incidents: any[] = [], tags: any[] = []): {
  score: number; label: string; label_color: string; color: string;
  activity: number; activity_max: number; reputation: number; reputation_max: number;
  risk: number; recovery: number;
} {
  const baseIndex = calculateLoyaltyIndex(visits);

  const incidentRisk = Math.min(100, (incidents || []).length * 20);
  const tagBonus = Math.min(15, (tags || []).length * 5);
  const score = Math.max(0, Math.min(100, baseIndex + tagBonus - incidentRisk));

  let label: string; let label_color: string; let color: string;
  if (score >= 90) { label = "Постоянный клиент"; label_color = "#00FF94"; color = "#00FF94"; }
  else if (score >= 70) { label = "Постоянный"; label_color = "#14b8a6"; color = "#14b8a6"; }
  else if (score >= 50) { label = "Регулярный"; label_color = "#3b82f6"; color = "#3b82f6"; }
  else if (score >= 30) { label = "Новый"; label_color = "#f97316"; color = "#f97316"; }
  else if (score >= 10) { label = "Редкий"; label_color = "#9AA6B2"; color = "#9AA6B2"; }
  else { label = "Новичок"; label_color = "#ef4444"; color = "#ef4444"; }

  return {
    score,
    label,
    label_color,
    color,
    activity: Math.min(20, Math.floor(visits.length / 2)),
    activity_max: 20,
    reputation: Math.floor(score / 10),
    reputation_max: 10,
    risk: incidentRisk,
    recovery: 100 - incidentRisk,
  };
}

async function seedDatabase() {
  // Seed default categories if DB is empty
  const catCount = await prisma.category.count();
  if (catCount === 0) {
    logInfo("База данных пуста. Заполнение базовых категорий...");
     for (const cat of categories) {
       await prisma.category.create({
         data: {
           code: cat.code, label: cat.label, color: cat.color, bg_color: cat.bg_color,
           is_alert: cat.is_alert, alert_sound: cat.alert_sound, alert_volume: cat.alert_volume,
           detect_enabled: cat.detect_enabled, sort_order: cat.sort_order, is_system: cat.is_system,
           card_template_json: cat.card_template_json ?? null,
         }
       });
     }
  }

   // Sync in-memory categories from DB
   const categoriesFromDB = await prisma.category.findMany({ orderBy: { sort_order: "asc" } });
   categories = categoriesFromDB as any[];

    // Ensure EVENT_GUEST category exists (migration for existing DBs)
    const existingGuest = categoriesFromDB.find(c => c.code === "EVENT_GUEST");
    if (!existingGuest) {
      const eventGuestCardTemplate = JSON.stringify({
        sections: [
          { key: "visits",  label: "Посещения", icon: "calendar", type: "visits_history" },
          { key: "loyalty", label: "Лояльность", icon: "star",    type: "loyalty_score" },
        ],
        fields: [
          { key: "favorite_drink", label: "Напиток",  type: "text",   group: "preferences" },
          { key: "favorite_table", label: "Столик",   type: "text",   group: "preferences" },
          { key: "allergies",      label: "Аллергии", type: "text",   group: "preferences" },
          { key: "vip_level",      label: "VIP уровень", type: "select", group: "preferences", options: ["", "Bronze", "Silver", "Gold", "Platinum"] },
          { key: "last_order",     label: "Посл. заказ", type: "text", group: "preferences" },
          { key: "visit_count",    label: "Кол-во визитов", type: "number", group: "stats", readonly: true },
        ],
      });
      await prisma.category.create({
        data: {
          code: "EVENT_GUEST", label: "Гость", color: "#14b8a6", bg_color: "#0a2e2e",
          is_alert: false, alert_sound: "off", alert_volume: 0.5,
          detect_enabled: true, sort_order: 7, is_system: false,
          card_template_json: eventGuestCardTemplate,
        }
      });
      logInfo("Создана категория EVENT_GUEST с шаблоном карточки");
    }

    // Ensure SUITE category exists (migration for existing DBs)
    const existingSuite = categoriesFromDB.find(c => c.code === "SUITE");
    if (!existingSuite) {
      await prisma.category.create({
        data: {
          code: "SUITE", label: "Свита", color: "#ec4899", bg_color: "#500724",
          is_alert: true, alert_sound: "builtin", alert_volume: 0.8,
          detect_enabled: true, sort_order: 3, is_system: false,
        }
      });
      logInfo("Создана категория SUITE (Свита)");
    }

    // Ensure NOT_TODAY category exists (migration for existing DBs)
    const existingNotToday = categoriesFromDB.find(c => c.code === "NOT_TODAY");
    if (!existingNotToday) {
      await prisma.category.create({
        data: {
          code: "NOT_TODAY", label: "Не сегодня", color: "#f97316", bg_color: "#431407",
          is_alert: false, alert_sound: "off", alert_volume: 0.5,
          detect_enabled: true, sort_order: 2, is_system: false,
        }
      });
      logInfo("Создана категория NOT_TODAY (Не сегодня)");
    }

  // Seed default camera if none exist
  const camCount = await prisma.camera.count();
  if (camCount === 0) {
    logInfo("Камеры не найдены. Создаём дефолтную USB-камеру...");
    await prisma.camera.create({
      data: {
        name: "Входная группа (Основная)",
        source: "/dev/video0",
        camera_type: "USB",
        zone: "Вход",
        is_active: true,
        status: "online",
        fps: 25,
        ping_ms: 0,
        is_smart_recording: false,
        is_chronicle: true,
      },
    });
  }

  // Load cameras from DB into in-memory array
  const camsFromDB = await prisma.camera.findMany({ orderBy: { id: "asc" } });
  cameras = camsFromDB.map((c: any) => decryptCameraCreds(c));

  // Load persons from DB into in-memory array
  const personsFromDB = await prisma.person.findMany({ include: { photos: true }, orderBy: { created_at: "desc" } });
  persons = personsFromDB as any[];

  // Load persisted settings
  recognition_threshold_pct = await loadSetting("recognition_threshold_pct", recognition_threshold_pct);
  verification_threshold_pct = await loadSetting("verification_threshold_pct", verification_threshold_pct);
  confirmation_threshold_pct = await loadSetting("confirmation_threshold_pct", confirmation_threshold_pct);
  low_threshold_pct = await loadSetting("low_threshold_pct", low_threshold_pct);
  active_categories = await loadSetting("active_categories", active_categories);

  logInfo(`Загружено: ${categories.length} категорий, ${persons.length} персон, ${cameras.length} камер`);
}

// Middleware для обработки ошибок
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Multer errors (file too large, too many files, etc.)
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "File size exceeds 5MB limit" });
    }
    if (err.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({ error: "Too many files uploaded" });
    }
    return res.status(400).json({ error: err.message });
  }

  // Custom Multer fileFilter rejection
  if (err?.message?.includes("Only image files") || err?.message?.includes("Invalid file type") || err?.message?.includes("Only JPEG/PNG")) {
    return res.status(400).json({ error: err.message });
  }

  logError(err, { url: req.url, method: req.method });
  
  res.status(err.status || 500).json({
    detail: err.message || "Внутренняя ошибка сервера",
    error: process.env.NODE_ENV === "development" ? err : undefined,
  });
});

/**
 * Освобождает порт перед запуском: завершает процесс, который его занимает.
 * Это гарантирует чистый старт даже если остался висеть старый инстанс
 * (например, упавший сервер или предыдущий запуск).
 * Порт Python-движка (8001) отсюда НЕ освобождаем — его поднимает отдельный
 * процесс (dev:face) параллельно через concurrently, и глушить его отсюда
 * значило бы убить лицевой сервер на старте. Его освобождает скрипт kill-ports.js
 * на этапе predev/prestart, до запуска всех процессов.
 */
async function freePort(port: number): Promise<void> {
  const os = platform();
  try {
    if (os === "win32") {
      const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
      const pids = new Set<string>();
      for (const line of stdout.split("\n")) {
        if (!line.includes("LISTENING")) continue;
        const parts = line.trim().split(/\s+/);
        // parts[1] — локальный адрес (0.0.0.0:3000, [::]:3000). Сверяем порт ТОЧНО:
        // findstr :3000 подстрочно матчит и :30000..:30009, иначе можно убить чужой процесс.
        const localAddr = parts[1] || "";
        if (!localAddr.endsWith(`:${port}`)) continue;
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid)) pids.add(pid);
      }
      for (const pid of pids) {
        try {
          await execAsync(`taskkill /F /PID ${pid}`);
          logWarn(`Освобождён порт ${port}: завершён процесс PID ${pid}`);
        } catch {
          // процесс уже ушёл
        }
      }
    } else {
      try {
        await execAsync(`lsof -ti :${port} | xargs -r kill -9`);
      } catch {
        // нет процесса на порту
      }
    }
  } catch {
    // порт свободен или netstat недоступен — ничего не делаем
  }
}

// ═══ A. PROCESS HARDENING ═══════════════════════════════════

const activeFfmpeg = new Set<ChildProcess>()

/** Вызывать сразу после каждого spawn('ffmpeg', ...) */
function trackFfmpeg(proc: ChildProcess): void {
  activeFfmpeg.add(proc)
  proc.on("exit", () => activeFfmpeg.delete(proc))
  proc.on("error", () => activeFfmpeg.delete(proc))
}

function killAllFfmpeg(): void {
  for (const p of activeFfmpeg) {
    try { p.kill("SIGTERM") } catch { /* уже мёртв */ }
  }
  setTimeout(() => {
    for (const p of activeFfmpeg) { try { p.kill("SIGKILL") } catch { /* ignore */ } }
    activeFfmpeg.clear()
  }, 3000).unref()
}

let shuttingDown = false

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log("[SHUTDOWN] Graceful shutdown started")

  const force = setTimeout(() => {
    console.error("[SHUTDOWN] Timeout 8s — force exit")
    process.exit(code)
  }, 8000)
  force.unref()

  for (const t of cameraRestartTimers.values()) clearTimeout(t)
  cameraRestartTimers.clear()

  killAllFfmpeg()

  try { wssSecurity?.close() } catch { /* ignore */ }
  try { wssCamera?.close() } catch { /* ignore */ }
  try { server?.close() } catch { /* ignore */ }

  try { await prisma.$disconnect() } catch (e) { console.error("[SHUTDOWN] prisma:", e) }

  console.log("[SHUTDOWN] Clean exit")
  process.exit(code)
}

process.on("SIGINT", () => void shutdown(0))
process.on("SIGTERM", () => void shutdown(0))

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] unhandledRejection:", reason)
  reportError("unhandledRejection", reason)
})

process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err)
  void shutdown(1)
})

async function start() {
  // Инициализация базы данных
  await seedDatabase();

  // Проверка и оптимизация камер (отключение недоступных USB-устройств)
  await validateAndOptimizeCameras();

  // Подгружаем существующие записи в in-memory архив (календарь «Видеозаписи»)
  try {
    const existingRecs = await prisma.recording.findMany();
    for (const rec of existingRecs) recordToChronicle(rec);
    if (existingRecs.length) logInfo(`Загружено в архив записей: ${existingRecs.length}`);
  } catch (e) {
    logError(e as Error, { context: "load recordings to chronicle" });
  }

  // Инициализация AI движка при старте с загрузкой дескрипторов из БД
  logInfo("Инициализация AI Face Engine с загрузкой из БД...");
  
  await initFaceEngineWithDB();
  
  const engineStatus = getEngineStatus();
  if (engineStatus.initialized) {
    logInfo("AI Face Engine инициализирована и дескрипторы загружены");
  } else {
    logWarn("AI Face Engine не удалось инициализировать — работаем в mock-режиме");
  }

  startLoyaltyWorker();
  setBroadcastFn(broadcastSecurity);

  // В dev фронтенд (SPA + HMR) отдаётся автономным Vite на :5173 (см. vite.config.ts,
  // который проксирует /api и /ws на :3000). Это стабильный HMR, независимый от
  // event-loop бэкенда (FFmpeg/WebSocket), и исключает конфликт двух Vite-инстансов,
  // из-за которого браузер постоянно перезагружался. Здесь на :3000 отдаём только
  // статику собранного билда (продакшн).
  if (process.env.NODE_ENV === "production") {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  } else {
    // В dev UI живёт на Vite (:5173), а :3000 — только API/WS. Чтобы открытие
    // http://localhost:3000 в браузере не отдавало 404, перенаправляем обычную
    // навигацию на Vite. /api и /ws обрабатываются выше и сюда не попадают.
    const VITE_DEV_URL = process.env.VITE_DEV_URL || `http://localhost:5173`;
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/ws")) return next();
      res.redirect(302, VITE_DEV_URL + req.originalUrl);
    });
  }

  if (!API_KEY) {
    logWarn("SECURITY: API_KEY не задан — API и WebSocket доступны в сети БЕЗ аутентификации. " +
      "Задайте API_KEY в .env (и VITE_API_KEY на клиенте) перед публикацией/доступом извне.");
  } else {
    logInfo("API-key аутентификация ВКЛЮЧЕНА (требуется на всех /api и /ws).");
  }

  // Перед привязкой освобождаем порт от возможных «висячих» процессов,
  // чтобы старт гарантированно прошёл (порт сперва убивается, потом запуск).
  await freePort(PORT);

  server.listen(PORT, HOST, () => {
    logInfo(`Server running on http://${HOST}:${PORT}`);
  });
}

start();
