/**
 * Face Detection & Recognition Engine (v3.0)
 * Современная реализация с использованием FastAPI + InsightFace
 *
 * Улучшения v3.0:
 *  1. Health check Python-сервера с кэшированием статуса и автоматическим восстановлением
 *  2. Бинарное хранение дескрипторов (вместо JSON) — экономия ~30% места и быстрее парсинг
 *  3. Защита от Path Traversal — санитизация путей, проверка корневых директорий
 *  4. Оптимизированный поиск — кэширование эмбеддингов + partitioning по категориям
 */

import path from "path";
import fs from "fs";
import sharp from "sharp";
import fetch, { FormData, Blob } from "node-fetch";
import logger, { logInfo, logError, logWarn, logDebug } from "./src/lib/logger.js";
import { prisma } from "./db.js";

// ─── Конфигурация ────────────────────────────────────────────────────────────

const FACE_SERVER_URL = process.env.FACE_SERVER_URL || "http://localhost:8001";
const FACE_API_KEY = process.env.FACE_API_KEY || "";
const USE_PYTHON_SERVER = true;

// Health check
const HEALTH_CHECK_INTERVAL_MS = Number(process.env.FACE_HEALTH_CHECK_INTERVAL) || 10_000;
const HEALTH_CHECK_TIMEOUT_MS = Number(process.env.FACE_HEALTH_CHECK_TIMEOUT) || 5_000;

// Embedding cache
const EMBEDDING_CACHE_TTL_MS = Number(process.env.FACE_EMBEDDING_CACHE_TTL) || 5 * 60 * 1000; // 5 мин

// Path traversal protection
const MAX_PATH_DEPTH = 10;

// ─── Типы ────────────────────────────────────────────────────────────────────

export interface DetectedFace {
  box: { x: number; y: number; width: number; height: number };
  score: number;
  descriptor?: Float32Array;
  gender?: "male" | "female" | null;
  age?: number | null;
}

export interface RecognitionMatch {
  personId: number;
  personName: string;
  category: string;
  similarity: number;
  photoPath: string;
}

/** Кэш эмбеддингов: ключ = хеш пути, значение = { descriptor, timestamp } */
interface EmbeddingCacheEntry {
  descriptor: Float32Array;
  timestamp: number;
}

// ─── Глобальное состояние ────────────────────────────────────────────────────

let isInitialized = false;

/** Дескрипторы в памяти — partitioned по категориям для ускорения поиска */
const storedDescriptors: Array<{
  personId: number;
  personName: string;
  category: string;
  photoPath: string;
  descriptor: Float32Array;
  descriptorList: number[];
}> = [];

/** Кэш эмбеддингов: pathHash -> { descriptor, timestamp } */
const embeddingCache = new Map<string, EmbeddingCacheEntry>();

/** Статус здоровья Python-сервера */
let pythonServerHealthy = true;
let pythonServerLastCheck = 0;
let pythonServerCheckPromise: Promise<boolean> | null = null;

/** Таймер периодического health check */
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;

// ─── 1. HEALTH CHECK PYTHON-СЕРВЕРА ──────────────────────────────────────────

/**
 * Проверяет доступность Python-сервера.
 * Результат кэшируется до следующего интервала.
 */
async function checkPythonServerHealth(): Promise<boolean> {
  const now = Date.now();
  const timeSinceLastCheck = now - pythonServerLastCheck;

  // Если проверка была недавно — возвращаем кэшированный результат
  if (timeSinceLastCheck < HEALTH_CHECK_INTERVAL_MS && pythonServerLastCheck > 0) {
    return pythonServerHealthy;
  }

  // Если уже идёт асинхронная проверка — ждём её
  if (pythonServerCheckPromise) {
    return pythonServerCheckPromise;
  }

  pythonServerCheckPromise = (async () => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

      const response = await apiFetchWithKey(`${FACE_SERVER_URL}/health`, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Сервер может отвечать 200, но не инициализировать модели (нет buffalo_l) —
      // тогда детекция молча возвращает пустые кадры. Считаем здоровым только с initialized.
      let initialized = false;
      try {
        const body: any = await response.json();
        initialized = body?.initialized === true;
      } catch {
        initialized = false;
      }
      const isHealthy = response.ok && initialized;

      const wasHealthy = pythonServerHealthy;
      pythonServerHealthy = isHealthy;
      pythonServerLastCheck = Date.now();

      if (!wasHealthy && pythonServerHealthy) {
        logInfo("Python-сервер восстановлен", { url: FACE_SERVER_URL });
      } else if (wasHealthy && !pythonServerHealthy) {
        logWarn("Python-сервер недоступен", { url: FACE_SERVER_URL });
      }

      return pythonServerHealthy;
    } catch (err) {
      const wasHealthy = pythonServerHealthy;
      pythonServerHealthy = false;
      pythonServerLastCheck = Date.now();

      if (wasHealthy) {
        logWarn("Python-сервер недоступен (ошибка подключения)", {
          url: FACE_SERVER_URL,
          error: (err as Error).message,
        });
      }

      return false;
    } finally {
      pythonServerCheckPromise = null;
    }
  })();

  return pythonServerCheckPromise;
}

/** Запускает периодический health check */
function startHealthCheckTimer(): void {
  if (healthCheckTimer) return;

  healthCheckTimer = setInterval(async () => {
    try {
      await checkPythonServerHealth();
    } catch (err) {
      logError(err as Error, { context: "Health check timer" });
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  // Make it not prevent process exit
  if (healthCheckTimer.unref) {
    healthCheckTimer.unref();
  }
}

/** Останавливает периодический health check */
function stopHealthCheckTimer(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

/**
 * Проверяет здоровье сервера перед выполнением операции.
 * Возвращает true если сервер доступен, false если нет.
 */
async function ensurePythonServerAvailable(): Promise<boolean> {
  const healthy = await checkPythonServerHealth();
  if (!healthy) {
    logWarn("Python-сервер недоступен, операция отложена", {
      url: FACE_SERVER_URL,
      lastCheck: new Date(pythonServerLastCheck).toISOString(),
    });
  }
  return healthy;
}

// ─── 2. БИНАРНОЕ ХРАНЕНИЕ ДЕСКРИПТОРОВ ──────────────────────────────────────

/**
 * Конвертирует Float32Array в буфер для бинарного хранения.
 * Float32Array из 512 элементов = 512 * 4 = 2048 байт.
 */
function descriptorToBinary(descriptor: Float32Array): Buffer {
  const buffer = Buffer.allocUnsafe(descriptor.byteLength);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let i = 0; i < descriptor.length; i++) {
    view.setFloat32(i * 4, descriptor[i], true); // little-endian
  }
  return buffer;
}

/**
 * Конвертирует бинарный буфер обратно в Float32Array.
 */
function binaryToDescriptor(buffer: Buffer | string, length: number = 512): Float32Array {
  let buf: Buffer;

  if (typeof buffer === "string") {
    // Если это base64-строка (из JSON fallback)
    buf = Buffer.from(buffer, "base64");
  } else {
    buf = buffer;
  }

  const descriptor = new Float32Array(length);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < length && i * 4 < buf.length; i++) {
    descriptor[i] = view.getFloat32(i * 4, true); // little-endian
  }
  return descriptor;
}

/**
 * Конвертирует Float32Array в base64-строку для хранения в БД.
 * Бинарный формат: ~2048 байт → base64 ~2732 символа
 * vs JSON: 512 чисел → ~3000-4000 символов
 */
function descriptorToBase64(descriptor: Float32Array): string {
  const binary = descriptorToBinary(descriptor);
  return binary.toString("base64");
}

/**
 * Конвертирует base64-строку обратно в Float32Array.
 */
function base64ToDescriptor(base64: string, length: number = 512): Float32Array {
  return binaryToDescriptor(Buffer.from(base64, "base64"), length);
}

/**
 * Сохраняет дескриптор в БД в бинарном формате (base64).
 * Экономит ~30% места по сравнению с JSON.
 */
async function saveDescriptorToDB(
  personId: number,
  personName: string,
  category: string,
  photoPath: string,
  descriptor: Float32Array
): Promise<boolean> {
  try {
    // Удаляем существующий дескриптор для этого фото перед созданием нового —
    // предотвращает накопление дублей при повторных импортах и reindex.
    await prisma.faceDescriptor.deleteMany({
      where: { person_id: personId, photo_path: photoPath },
    });

    // Пробуем бинарный формат, fallback на JSON при ошибке
    try {
      const binaryData = descriptorToBase64(descriptor);
      await prisma.faceDescriptor.create({
        data: {
          person_id: personId,
          photo_path: photoPath,
          descriptor: binaryData,
        },
      });
      logDebug(`Дескриптор сохранён в бинарном формате для "${personName}" (ID: ${personId})`);
    } catch (binaryErr: any) {
      // Если бинарное поле не поддерживается схемой — fallback на JSON
      if (binaryErr?.code === "P2011" || binaryErr?.code === "P2005" || binaryErr?.message?.includes("descriptor")) {
        logWarn("Бинарное хранение не поддерживается схемой, используется JSON fallback", {
          personId,
          personName,
          errorCode: binaryErr?.code,
        });
        await prisma.faceDescriptor.create({
          data: {
            person_id: personId,
            photo_path: photoPath,
            descriptor: JSON.stringify(Array.from(descriptor)),
          },
        });
      } else {
        throw binaryErr;
      }
    }
    return true;
  } catch (err) {
    logError(err as Error, { context: "Сохранение дескриптора в БД", personId, personName, photoPath });
    return false;
  }
}

/**
 * Загружает дескрипторы из БД.
 * Поддерживает как бинарный, так и JSON формат (для обратной совместимости).
 */
async function loadDescriptorsFromDB(): Promise<void> {
  try {
    const descriptorsFromDB = await prisma.faceDescriptor.findMany({
      include: {
        person: {
          select: {
            name: true,
            category: true,
          },
        },
      },
    });

    storedDescriptors.length = 0;
    let binaryCount = 0;
    let jsonCount = 0;

    for (const d of descriptorsFromDB) {
      try {
        const descriptorRaw = d.descriptor;
        let descriptor: Float32Array;
        let descriptorList: number[];

        // Определяем формат: base64 (бинарный) или JSON-массив
        if (typeof descriptorRaw === "string") {
          // Пытаемся определить формат
          if (descriptorRaw.startsWith("[")) {
            // JSON-массив — старый формат
            descriptorList = JSON.parse(descriptorRaw);
            descriptor = new Float32Array(descriptorList);
            jsonCount++;
          } else {
            // Base64-строка — новый бинарный формат
            descriptor = base64ToDescriptor(descriptorRaw);
            descriptorList = Array.from(descriptor);
            binaryCount++;
          }
        } else {
          // Fallback на JSON для не-string данных
          descriptorList = Array.from(descriptorRaw as number[]);
          descriptor = new Float32Array(descriptorList);
          jsonCount++;
        }

        storedDescriptors.push({
          personId: d.person_id,
          personName: d.person.name,
          category: d.person.category,
          photoPath: d.photo_path,
          descriptor,
          descriptorList,
        });
      } catch (parseErr) {
        logError(parseErr as Error, { context: "Парсинг дескриптора из БД", descriptorId: d.id });
      }
    }

    logInfo(
      `Загружено ${storedDescriptors.length} дескрипторов из БД ` +
        `(бинарных: ${binaryCount}, JSON: ${jsonCount})`
    );
  } catch (err) {
    logError(err as Error, { context: "Загрузка дескрипторов из БД" });
  }
}

// ─── 3. ЗАЩИТА ОТ PATH TRAVERSAL ─────────────────────────────────────────────

/**
 * Проверяет и санитизирует путь к файлу.
 * Предотвращает атаки Path Traversal (например, ../../etc/passwd).
 *
 * @param requestedPath — путь, полученный от пользователя
 * @param allowedRoots — массив разрешённых корневых директорий
 * @returns абсолютный безопасный путь или null если путь недопустим
 */
export function sanitizePhotoPath(
  requestedPath: string,
  allowedRoots: string[] = [path.resolve(process.cwd(), "public")]
): string | null {
  if (!requestedPath || typeof requestedPath !== "string") {
    logWarn("sanitizePhotoPath: пустой или нестроковый путь");
    return null;
  }

  // Запрещаем null-байты
  if (requestedPath.includes("\0")) {
    logWarn("sanitizePhotoPath: обнаружен null-байт в пути", { path: requestedPath });
    return null;
  }

  // Нормализуем путь (убираем .., . и т.д.)
  const normalized = path.normalize(requestedPath);

  // Проверяем, нет ли попытки выйти за пределы (до нормализации и после)
  // После normalize ".." уже обработан, но проверяем исходный путь на явные попытки
  const parts = requestedPath.split(path.sep);
  let depth = 0;
  for (const part of parts) {
    if (part === "..") {
      depth--;
      if (depth < 0) {
        logWarn("sanitizePhotoPath: попытка path traversal (..)", { path: requestedPath });
        return null;
      }
    } else if (part !== "." && part !== "") {
      depth++;
    }
  }

  // Проверяем глубину
  if (depth > MAX_PATH_DEPTH) {
    logWarn("sanitizePhotoPath: слишком глубокий путь", { path: requestedPath, depth });
    return null;
  }

  // Получаем абсолютный путь
  const absolutePath = path.resolve(normalized);

  // Проверяем, что путь находится внутри одной из разрешённых директорий.
  // Используем path.relative + startsWith("..") вместо простого startsWith,
  // чтобы избежать prefix-bypass: /root/public-evil/... не должен проходить.
  const isWithinAllowedRoot = allowedRoots.some((root) => {
    const relative = path.relative(root, absolutePath);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });

  if (!isWithinAllowedRoot) {
    logWarn("sanitizePhotoPath: путь выходит за пределы разрешённых директорий", {
      requestedPath,
      absolutePath,
      allowedRoots,
    });
    return null;
  }

  // Проверяем существование файла
  if (!fs.existsSync(absolutePath)) {
    logWarn("sanitizePhotoPath: файл не существует", { path: absolutePath });
    return null;
  }

  // Проверяем, что это файл (не директория)
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) {
    logWarn("sanitizePhotoPath: путь указывает на директорию, а не файл", { path: absolutePath });
    return null;
  }

  return absolutePath;
}

/**
 * Безопасное разрешение относительного пути фото.
 * Упрощённая версия для внутренних вызовов.
 */
function safeResolvePhotoPath(relativePath: string): string | null {
  return sanitizePhotoPath(relativePath, [
    path.resolve(process.cwd(), "public"),
    path.resolve(process.cwd(), "public", "photos"),
    path.resolve(process.cwd(), "public", "snapshots"),
  ]);
}

// ─── 4. ОПТИМИЗИРОВАННЫЙ ПОИСК ──────────────────────────────────────────────

/**
 * Вычисляет хеш для кэширования эмбеддинга.
 * Использует путь + размер + время модификации для защиты от коллизий.
 */
function computeCacheKey(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${filePath}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${filePath}:no_stat`;
  }
}

/**
 * Очищает просроченные записи из кэша эмбеддингов.
 */
function pruneEmbeddingCache(): void {
  const now = Date.now();
  let pruned = 0;

  for (const [key, entry] of embeddingCache.entries()) {
    if (now - entry.timestamp > EMBEDDING_CACHE_TTL_MS) {
      embeddingCache.delete(key);
      pruned++;
    }
  }

  if (pruned > 0) {
    logDebug(`Очищен кэш эмбеддингов: удалено ${pruned} просроченных записей`);
  }
}

/**
 * Partitioning дескрипторов по категориям для ускорения поиска.
 * При поиске в конкретной категории просматривается только подмножество.
 */
function getDescriptorsByCategory(category: string | null): typeof storedDescriptors {
  if (!category) return storedDescriptors;
  return storedDescriptors.filter((d) => d.category === category);
}

// ─── ИНИЦИАЛИЗАЦИЯ ДВИЖКА ────────────────────────────────────────────────────

export async function initFaceEngine(): Promise<boolean> {
  if (isInitialized) return true;

  try {
    logInfo("Инициализация FaceEngine v3.0...");
    await loadDescriptorsFromDB();
    startHealthCheckTimer();
    await checkPythonServerHealth(); // первая проверка при старте
    logInfo("FaceEngine v3.0 готов к работе!");
    isInitialized = true;
    return true;
  } catch (err) {
    logError(err as Error, { context: "Инициализация FaceEngine" });
    isInitialized = false;
    return false;
  }
}

export async function initFaceEngineWithDB(): Promise<void> {
  await initFaceEngine();
}

/**
 * Получает статус здоровья Python-сервера.
 */
export function getPythonServerStatus(): {
  healthy: boolean;
  lastCheck: number;
  url: string;
} {
  return {
    healthy: pythonServerHealthy,
    lastCheck: pythonServerLastCheck,
    url: FACE_SERVER_URL,
  };
}

/**
 * Принудительная проверка здоровья Python-сервера с деталями.
 * Делает свежий запрос на /health и возвращает полную информацию о состоянии.
 */
export async function getPythonServerHealth(): Promise<{
  healthy: boolean;
  initialized: boolean;
  details: any;
}> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const response = await apiFetchWithKey(`${FACE_SERVER_URL}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const data: any = await response.json().catch(() => null);
    const initialized = data?.initialized === true;
    const healthy = response.ok && initialized;
    return { healthy, initialized, details: data };
  } catch {
    return { healthy: false, initialized: false, details: "Unreachable" };
  }
}

export function getEngineStatus(): {
  initialized: boolean;
  totalDescriptors: number;
  uniquePersons: number;
  models: string[];
  pythonServer: { healthy: boolean; lastCheck: number; url: string };
  cacheSize: number;
} {
  const uniquePersons = new Set(storedDescriptors.map((d) => d.personId)).size;
  return {
    initialized: isInitialized,
    totalDescriptors: storedDescriptors.length,
    uniquePersons,
    models: isInitialized ? ["InsightFace (buffalo_l)"] : [],
    pythonServer: getPythonServerStatus(),
    cacheSize: embeddingCache.size,
  };
}

// ─── API РАБОТЫ С PYTHON-СЕРВЕРОМ ────────────────────────────────────────────

function getApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (FACE_API_KEY) {
    headers["X-API-Key"] = FACE_API_KEY;
  }
  return headers;
}

async function apiFetchWithKey(input: string | URL, init: RequestInit = {}): Promise<any> {
  const headers = { ...(init.headers || {}), ...getApiHeaders() };
  return fetch(input, { ...init, headers } as any);
}

/**
 * Получает эмбеддинг с Python-сервера.
 * Blob создаётся из Uint8Array (совместимо с node-fetch v3).
 */
/**
 * Получает эмбеддинг с Python-сервера.
 * Blob создаётся из Uint8Array (совместимо с node-fetch v3).
 *
 * @param strict — true для ЖЁСТКОГО ворота записи (enrollment): мусорные кадры
 *   (размытие/наклон/темнота/несколько лиц) отклоняются с перечислением причин.
 */
async function getEmbeddingFromServer(
  imageBuffer: Buffer,
  strict: boolean = false
): Promise<{ descriptor: Float32Array | null; quality: any | null; issues: string[]; passed: boolean; error?: string }> {
  try {
    const formData = new FormData();
    // Конвертируем Buffer в Uint8Array для Blob
    const uint8Array = new Uint8Array(imageBuffer);
    const blob = new Blob([uint8Array], { type: "image/jpeg" });
    formData.append("image", blob as any, "image.jpg");
    if (strict) formData.append("strict", "true");

    const response = await apiFetchWithKey(`${FACE_SERVER_URL}/get-embedding`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json() as {
      descriptor?: number[];
      quality?: any;
      issues?: string[];
      passed?: boolean;
      error?: string;
    };

    return {
      descriptor: result.descriptor ? new Float32Array(result.descriptor) : null,
      quality: result.quality ?? null,
      issues: result.issues ?? [],
      passed: result.passed ?? (result.descriptor ? true : false),
      error: result.error,
    };
  } catch (e) {
    logError(e as Error, { context: "Получение эмбеддинга с Python-сервера" });
    return { descriptor: null, quality: null, issues: [], passed: false, error: (e as Error).message };
  }
}

/**
 * Полная оценка качества кадра через /assess-quality (резкость, поза, яркость,
 * количество лиц) для решения о пригодности к извлечению эмбеддинга.
 */
async function assessQualityFromServer(imageBuffer: Buffer): Promise<any | null> {
  try {
    const formData = new FormData();
    const uint8Array = new Uint8Array(imageBuffer);
    const blob = new Blob([uint8Array], { type: "image/jpeg" });
    formData.append("image", blob as any, "image.jpg");

    const response = await apiFetchWithKey(`${FACE_SERVER_URL}/assess-quality`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    return await response.json();
  } catch (e) {
    logError(e as Error, { context: "Оценка качества с Python-сервера" });
    return null;
  }
}

async function detectFacesFromServer(
  imgBuffer: Buffer,
  options: { detector?: string; det_size?: number; min_face_size?: number; min_det_score?: number } = {}
): Promise<DetectedFace[]> {
  try {
    const formData = new FormData();
    const uint8Array = new Uint8Array(imgBuffer);
    const blob = new Blob([uint8Array], { type: "image/jpeg" });
    formData.append("image", blob as any, "image.jpg");
    formData.append("with_descriptors", "true");
    if (options.detector) formData.append("detector", options.detector);
    if (options.det_size) formData.append("det_size", String(options.det_size));
    if (options.min_face_size) formData.append("min_face_size", String(options.min_face_size));
    if (options.min_det_score !== undefined && options.min_det_score !== null) formData.append("min_det_score", String(options.min_det_score));

    const response = await apiFetchWithKey(`${FACE_SERVER_URL}/detect-faces`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      if (response.status === 400) {
        logDebug(`Детекция: кадр пустой или невалиден (400), пропуск`);
        return [];
      }
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json() as {
      faces: Array<{ box: any; score: number; descriptor?: number[]; gender?: string; age?: number }>;
    };

    return result.faces.map((f: any) => ({
      box: f.box,
      score: f.score,
      descriptor: f.descriptor ? new Float32Array(f.descriptor) : undefined,
      gender: f.gender ?? null,
      age: f.age ?? null,
    }));
  } catch (e) {
    logError(e as Error, { context: "Детекция с Python-сервера" });
    return [];
  }
}

async function recognizeDescriptorOnServer(
  descriptor: Float32Array,
  options: { category?: string; topK?: number; threshold?: number } = {}
): Promise<RecognitionMatch[]> {
  try {
    const payload = {
      descriptor: Array.from(descriptor),
      category: options.category || "",
    };

    const url = new URL(`${FACE_SERVER_URL}/recognize-by-descriptor`);
    url.searchParams.set("top_k", String(options.topK || 5));
    url.searchParams.set("apply_cooldown", "true");
    if (options.threshold !== undefined && options.threshold !== null) {
      url.searchParams.set("threshold", String(options.threshold));
    }

    const response = await apiFetchWithKey(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      logWarn(`Python recognition failed: ${response.status}`);
      return [];
    }

    const result = await response.json() as {
      matches: Array<{
        person_id: number;
        person_name: string;
        category: string;
        photo_path: string;
        similarity: number;
      }>;
      confirmation_candidate?: {
        person_id: number;
        person_name: string;
        category: string;
        photo_path: string;
        similarity: number;
      };
    };

    const mapped = result.matches.map((m) => ({
      personId: m.person_id,
      personName: m.person_name,
      category: m.category,
      photoPath: m.photo_path,
      similarity: m.similarity,
    }));

    // FIX: gray-zone candidates (LOW_THRESHOLD..CONFIRMATION_THRESHOLD, i.e. 40-55%)
    // were returned only in `confirmation_candidate`, which this function used to
    // ignore. As a result known people in that band were treated as unknown and
    // turned into "Неизвестный" guests instead of going to operator confirmation.
    // Surface the candidate so the live pipeline can route it correctly.
    if (!mapped.length && result.confirmation_candidate) {
      const c = result.confirmation_candidate;
      mapped.push({
        personId: c.person_id,
        personName: c.person_name,
        category: c.category,
        photoPath: c.photo_path,
        similarity: c.similarity,
      });
    }

    return mapped;
  } catch (e) {
    logError(e as Error, { context: "Распознавание дескриптора на Python" });
    return [];
  }
}

let _faissSyncTimer: ReturnType<typeof setTimeout> | null = null
const FAISS_SYNC_DEBOUNCE_MS = 3000

async function syncIndexWithPython(): Promise<void> {
  if (_faissSyncTimer) {
    clearTimeout(_faissSyncTimer)
  }
  _faissSyncTimer = setTimeout(async () => {
    _faissSyncTimer = null
    try {
      const persons = storedDescriptors.map((d) => ({
        person_id: d.personId,
        person_name: d.personName,
        category: d.category,
        photo_path: d.photoPath,
        descriptor: Array.from(d.descriptor),
      }))

      const response = await apiFetchWithKey(`${FACE_SERVER_URL}/update-index`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ persons }),
      })

      if (!response.ok) {
        logWarn(`Python index sync failed: ${response.status}`)
      } else {
        const result = await response.json() as { indexed?: number }
        logDebug(`FAISS index synced with Python: ${result.indexed ?? "?"} vectors`)
      }
    } catch (e) {
      logError(e as Error, { context: "Синхронизация индекса с Python" })
    }
}, FAISS_SYNC_DEBOUNCE_MS)
}

// ─── ОСНОВНЫЕ ФУНКЦИИ ────────────────────────────────────────────────────────

export async function detectFaces(
  imagePathOrBuffer: string | Buffer,
  options: {
    detector?: string;
    det_size?: number;
    min_face_size?: number;
    min_det_score?: number;
  } = {}
): Promise<DetectedFace[]> {
  // Проверяем здоровье сервера
  const healthy = await ensurePythonServerAvailable();
  if (!healthy) {
    logWarn("Python-сервер недоступен, детекция лиц невозможна");
    return [];
  }

  try {
    let imgBuffer: Buffer;

    if (typeof imagePathOrBuffer === "string") {
      const resolvedPath = safeResolvePhotoPath(imagePathOrBuffer);
      if (!resolvedPath) {
        logWarn("Недопустимый путь к файлу для детекции", { path: imagePathOrBuffer });
        return [];
      }
      imgBuffer = await fs.promises.readFile(resolvedPath);
    } else {
      imgBuffer = imagePathOrBuffer;
    }

    return await detectFacesFromServer(imgBuffer, options);
  } catch (err) {
    logError(err as Error, { context: "Детекция" });
    return [];
  }
}

export function detectFacesFast(
  imagePathOrBuffer: string | Buffer,
  options: any = {}
): Promise<DetectedFace[]> {
  return detectFaces(imagePathOrBuffer, options);
}

export async function getEmbedding(
  imagePathOrBuffer: string | Buffer
): Promise<Float32Array | null> {
  // Проверяем здоровье сервера
  const healthy = await ensurePythonServerAvailable();
  if (!healthy) {
    logWarn("Python-сервер недоступен, получение эмбеддинга невозможно");
    return null;
  }

  try {
    let imgBuffer: Buffer;

    if (typeof imagePathOrBuffer === "string") {
      const resolvedPath = safeResolvePhotoPath(imagePathOrBuffer);
      if (!resolvedPath) {
        logWarn("Недопустимый путь к файлу для эмбеддинга", { path: imagePathOrBuffer });
        return null;
      }
      imgBuffer = await fs.promises.readFile(resolvedPath);
    } else {
      imgBuffer = imagePathOrBuffer;
    }

    // Мягкий путь (strict=false) — для живого распознавания: вектор тянется
    // даже из неидеального кадра. Возвращаем только дескриптор.
    const res = await getEmbeddingFromServer(imgBuffer, false);
    return res.descriptor;
  } catch (err) {
    logError(err as Error, { context: "Получение эмбеддинга" });
    return null;
  }
}

/**
 * Извлекает эмбеддинг с ПОЛНОЙ оценкой качества.
 *
 * Для ЗАПИСИ референсного эмбеддинга (регистрация/обучение) используйте
 * `strict: true` — кадр пройдёт жёсткий ворот (резкость/поза/яркость/число лиц),
 * и при провале `passed` будет false, а `descriptor` — null. Garbage-кадры
 * таким образом НЕ попадают в БД.
 */
export async function extractEmbedding(
  imagePathOrBuffer: string | Buffer,
  options: { strict?: boolean } = {}
): Promise<{
  descriptor: Float32Array | null;
  quality: any | null;
  issues: string[];
  passed: boolean;
  error?: string;
}> {
  const strict = options.strict ?? false;

  const healthy = await ensurePythonServerAvailable();
  if (!healthy) {
    return {
      descriptor: null,
      quality: null,
      issues: ["Сервис распознавания лиц недоступен"],
      passed: false,
      error: "Python-сервер недоступен",
    };
  }

  try {
    let imgBuffer: Buffer;

    if (typeof imagePathOrBuffer === "string") {
      const resolvedPath = safeResolvePhotoPath(imagePathOrBuffer);
      if (!resolvedPath) {
        return {
          descriptor: null,
          quality: null,
          issues: ["Недопустимый путь к файлу"],
          passed: false,
          error: "Недопустимый путь к файлу",
        };
      }
      imgBuffer = await fs.promises.readFile(resolvedPath);
    } else {
      imgBuffer = imagePathOrBuffer;
    }

    return await getEmbeddingFromServer(imgBuffer, strict);
  } catch (err) {
    logError(err as Error, { context: "Извлечение эмбеддинга (strict)" });
    return { descriptor: null, quality: null, issues: [], passed: false, error: (err as Error).message };
  }
}

export async function registerPerson(
  personId: number,
  personName: string,
  category: string,
  photoPath: string,
  imagePathOrBuffer: string | Buffer
): Promise<{ success: boolean; hasEmbedding: boolean; error?: string }> {
  // Проверяем здоровье сервера
  const healthy = await ensurePythonServerAvailable();
  if (!healthy) {
    return {
      success: false,
      hasEmbedding: false,
      error:
        "Сервис распознавания лиц недоступен. Python-сервер (FastAPI) не отвечает. " +
        "Проверьте, что сервер запущен на " +
        FACE_SERVER_URL,
    };
  }

  try {
    // Жёсткий ворот при записи референсного эмбеддинга: мусорные кадры
    // (размытие/наклон/темнота/несколько лиц) отклоняются ДО сохранения в БД.
    const { descriptor, issues, error } = await extractEmbedding(imagePathOrBuffer, { strict: true });

    if (!descriptor || issues.length > 0) {
      const reason = issues.length > 0 ? issues.join("; ") : (error || "Лицо не обнаружено на фото");
      return { success: false, hasEmbedding: false, error: reason };
    }

    // Удаляем старый дескриптор с тем же фото
    const existingIdx = storedDescriptors.findIndex(
      (d) => d.personId === personId && d.photoPath === photoPath
    );
    if (existingIdx >= 0) {
      storedDescriptors.splice(existingIdx, 1);
    }

    // Добавляем новый дескриптор
    storedDescriptors.push({
      personId,
      personName,
      category,
      photoPath,
      descriptor,
      descriptorList: Array.from(descriptor),
    });

    // Сохраняем в БД (бинарный формат с fallback на JSON)
    await saveDescriptorToDB(personId, personName, category, photoPath, descriptor);

    logDebug(`Зарегистрирован дескриптор для "${personName}" (ID: ${personId})`);

    await syncIndexWithPython();

    return { success: true, hasEmbedding: true };
  } catch (err) {
    logError(err as Error, { context: "Регистрация", personId, personName });
    return { success: false, hasEmbedding: false, error: (err as any).message };
  }
}

export async function registerPersonFromDescriptor(
  personId: number,
  personName: string,
  category: string,
  photoPath: string,
  descriptor: Float32Array | number[]
): Promise<{ success: boolean; hasEmbedding: boolean; error?: string }> {
  try {
    const desc = descriptor instanceof Float32Array ? descriptor : new Float32Array(descriptor);

    if (!desc || desc.length === 0) {
      return { success: false, hasEmbedding: false, error: "Пустой дескриптор" };
    }

    // Удаляем старый дескриптор с тем же фото
    const existingIdx = storedDescriptors.findIndex(
      (d) => d.personId === personId && d.photoPath === photoPath
    );
    if (existingIdx >= 0) {
      storedDescriptors.splice(existingIdx, 1);
    }

    // Добавляем новый дескриптор
    storedDescriptors.push({
      personId,
      personName,
      category,
      photoPath,
      descriptor: desc,
      descriptorList: Array.from(desc),
    });

    // Сохраняем в БД (бинарный формат с fallback на JSON)
    const saved = await saveDescriptorToDB(personId, personName, category, photoPath, desc);
    if (!saved) {
      // Запись в БД не удалась → откатываем in-memory push, чтобы не держать дескриптор,
      // которого нет в БД, и честно сообщаем вызывающему (тот удалит неполную персону).
      const idx = storedDescriptors.findIndex(
        (d) => d.personId === personId && d.photoPath === photoPath
      );
      if (idx >= 0) storedDescriptors.splice(idx, 1);
      return { success: false, hasEmbedding: false, error: "Не удалось сохранить дескриптор в БД" };
    }

    logDebug(`Зарегистрирован дескриптор для "${personName}" (ID: ${personId})`);

    // Синхронизируем FAISS-индекс (если Python-сервер недоступен — не падаем,
    // дескриптор уже сохранён в БД и in-memory; индекс обновится при следующей синхронизации)
    await syncIndexWithPython().catch((e) =>
      logWarn("FAISS sync skipped (Python недоступен)", { error: (e as Error).message })
    );

    return { success: true, hasEmbedding: true };
  } catch (err) {
    logError(err as Error, { context: "Регистрация по дескриптору", personId, personName });
    return { success: false, hasEmbedding: false, error: (err as any).message };
  }
}

/**
 * Добавляет ДОПОЛНИТЕЛЬНЫЙ референсный дескриптор к УЖЕ существующей персоне
 * (используется при подтверждении оператора: «это тот же человек»).
 * Сохраняет дескриптор в БД и пересинхронизирует FAISS-индекс.
 */
export async function addEmbeddingToPerson(
  personId: number,
  personName: string,
  category: string,
  photoPath: string,
  descriptor: Float32Array | number[]
): Promise<{ success: boolean; hasEmbedding: boolean; error?: string }> {
  try {
    const desc = descriptor instanceof Float32Array ? descriptor : new Float32Array(descriptor);

    if (!desc || desc.length === 0) {
      return { success: false, hasEmbedding: false, error: "Пустой дескриптор" };
    }

    // Дедуп: убираем старый дескриптор с тем же фото
    const existingIdx = storedDescriptors.findIndex(
      (d) => d.personId === personId && d.photoPath === photoPath
    );
    if (existingIdx >= 0) storedDescriptors.splice(existingIdx, 1);

    storedDescriptors.push({
      personId,
      personName,
      category,
      photoPath,
      descriptor: desc,
      descriptorList: Array.from(desc),
    });

    const saved = await saveDescriptorToDB(personId, personName, category, photoPath, desc);
    if (!saved) {
      const idx = storedDescriptors.findIndex(
        (d) => d.personId === personId && d.photoPath === photoPath
      );
      if (idx >= 0) storedDescriptors.splice(idx, 1);
      return { success: false, hasEmbedding: false, error: "Не удалось сохранить дескриптор в БД" };
    }

    logDebug(`Добавлен доп. дескриптор для "${personName}" (ID: ${personId}) из подтверждения оператора`);

    await syncIndexWithPython().catch((e) =>
      logWarn("FAISS sync skipped (Python недоступен)", { error: (e as Error).message })
    );

    return { success: true, hasEmbedding: true };
  } catch (err) {
    logError(err as Error, { context: "Добавление дескриптора существующей персоне", personId, personName });
    return { success: false, hasEmbedding: false, error: (err as any).message };
  }
}

export async function unregisterPerson(personId: number): Promise<void> {
  const before = storedDescriptors.length;
  let i = storedDescriptors.length;
  while (i--) {
    if (storedDescriptors[i].personId === personId) {
      storedDescriptors.splice(i, 1);
    }
  }
  try {
    await prisma.faceDescriptor.deleteMany({
      where: { person_id: personId },
    });
  } catch (err) {
    logError(err as Error, { context: "Удаление из БД", personId });
  }
  logDebug(`Удалено ${before - storedDescriptors.length} дескрипторов персоны ID: ${personId}`);

  await syncIndexWithPython();
}

/**
 * Оптимизированный поиск по фото.
 *
 * Улучшения:
 *  - Кэширование эмбеддингов (избегает повторных запросов к Python)
 *  - Partitioning по категориям (при поиске в конкретной категории просматривается подмножество)
 *  - Быстрое сравнение через Float32Array (без JSON-парсинга)
 */
export async function searchByPhoto(
  imagePathOrBuffer: string | Buffer,
  threshold: number = 0.4,
  maxResults: number = 5,
  options: { category?: string } = {}
): Promise<RecognitionMatch[]> {
  // Проверяем здоровье сервера
  const healthy = await ensurePythonServerAvailable();
  if (!healthy) {
    logWarn("Python-сервер недоступен, поиск невозможен");
    return [];
  }

  try {
    let descriptor: Float32Array | null;

    if (typeof imagePathOrBuffer === "string") {
      const resolvedPath = safeResolvePhotoPath(imagePathOrBuffer);
      if (!resolvedPath) {
        logWarn("Недопустимый путь к файлу для поиска", { path: imagePathOrBuffer });
        return [];
      }

      // Проверяем кэш
      const cacheKey = computeCacheKey(resolvedPath);
      const now = Date.now();
      const cached = embeddingCache.get(cacheKey);

      if (cached && now - cached.timestamp < EMBEDDING_CACHE_TTL_MS) {
        logDebug(`Эмбеддинг взят из кэша для поиска: ${resolvedPath}`);
        descriptor = cached.descriptor;
      } else {
        const imgBuffer = await fs.promises.readFile(resolvedPath);
        descriptor = (await getEmbeddingFromServer(imgBuffer, false)).descriptor;

        // Сохраняем в кэш
        if (descriptor) {
          // Очищаем кэш если переполнен
          if (embeddingCache.size > 1000) {
            pruneEmbeddingCache();
          }
          embeddingCache.set(cacheKey, { descriptor, timestamp: Date.now() });
        }
      }
    } else {
      descriptor = (await getEmbeddingFromServer(imagePathOrBuffer, false)).descriptor;
    }

    if (!descriptor) {
      return [];
    }

    const matches = await recognizeDescriptorOnServer(descriptor, {
      category: options.category,
      topK: maxResults,
      threshold,
    });

    return matches.slice(0, maxResults);
  } catch (err) {
    logError(err as Error, { context: "Поиск по фото" });
    return [];
  }
}

/**
 * Ищет совпадение по уже вычисленному эмбеддингу.
 * При 10 000+ персон поиск выполняется на Python-сервере через FAISS.
 */
export async function searchByDescriptor(
  descriptor: Float32Array | null | undefined,
  threshold: number = 0.4,
  maxResults: number = 5,
  options: { category?: string } = {}
): Promise<RecognitionMatch[]> {
  if (!descriptor || descriptor.length === 0) return [];
  if (!isInitialized) return [];

  const matches = await recognizeDescriptorOnServer(descriptor, {
    category: options.category,
    topK: maxResults,
    threshold,
  });

  return matches.slice(0, maxResults);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function rebuildDescriptorIndex(persons: any[]): Promise<{ registered: number; failed: number }> {
  logInfo("Перестроение FAISS индекса...");
  await syncIndexWithPython();
  return { registered: storedDescriptors.length, failed: 0 };
}

export async function assessPhotoQuality(
  imagePathOrBuffer: string | Buffer
): Promise<{ faceDetected: boolean; faceCount: number; quality: number; issues: string[]; details: any }> {
  // Проверяем здоровье сервера
  const healthy = await ensurePythonServerAvailable();
  if (!healthy) {
    return {
      faceDetected: false,
      faceCount: 0,
      quality: 0,
      issues: ["Сервис распознавания лиц недоступен"],
      details: null,
    };
  }

  try {
    let imgBuffer: Buffer;

    if (typeof imagePathOrBuffer === "string") {
      const resolvedPath = safeResolvePhotoPath(imagePathOrBuffer);
      if (!resolvedPath) {
        return {
          faceDetected: false,
          faceCount: 0,
          quality: 0,
          issues: ["Недопустимый путь к файлу"],
          details: null,
        };
      }
      imgBuffer = await fs.promises.readFile(resolvedPath);
    } else {
      imgBuffer = imagePathOrBuffer;
    }

    // Реальная оценка качества (резкость, поза, яркость, число лиц) с сервера.
    const res = await assessQualityFromServer(imgBuffer);
    if (!res) {
      return {
        faceDetected: false,
        faceCount: 0,
        quality: 0,
        issues: ["Сервис распознавания недоступен"],
        details: null,
      };
    }

    const primary = res.primary?.quality ?? null;
    const details = primary
      ? {
          detScore: res.primary.score,
          sharpness: primary.sharpness,
          sharpness_score: primary.sharpness_score,
          brightness: primary.brightness,
          approx_lux: primary.approx_lux,
          pitch: primary.pitch,
          yaw: primary.yaw,
          roll: primary.roll,
          face_count: res.face_count,
          gender: res.primary.gender ?? null,
          age: res.primary.age ?? null,
        }
      : null;

    return {
      faceDetected: res.face_detected,
      faceCount: res.face_count,
      quality: res.quality,
      issues: res.issues || [],
      details,
    };
  } catch (err) {
    logError(err as Error, { context: "Оценка качества" });
    return {
      faceDetected: false,
      faceCount: 0,
      quality: 0,
      issues: ["Error"],
      details: null,
    };
  }
}

// ─── УТИЛИТЫ ─────────────────────────────────────────────────────────────────

/**
 * Получает количество дескрипторов по категориям.
 * Полезно для мониторинга и аналитики.
 */
export function getCategoryDistribution(): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const d of storedDescriptors) {
    dist[d.category] = (dist[d.category] || 0) + 1;
  }
  return dist;
}

/**
 * Очищает кэш эмбеддингов вручную.
 */
export function clearEmbeddingCache(): void {
  const count = embeddingCache.size;
  embeddingCache.clear();
  logInfo(`Кэш эмбеддингов очищен: удалено ${count} записей`);
}

/**
 * Принудительно перезапускает health check.
 */
export async function forceHealthCheck(): Promise<boolean> {
  pythonServerLastCheck = 0; // сбрасываем таймер
  return await checkPythonServerHealth();
}
