#!/usr/bin/env python3
"""
Face Detection & Recognition Server (FastAPI + InsightFace + FAISS)
Production-ready implementation for high-load security systems.
Optimized for 10,000+ persons with FAISS exact search (IndexFlatIP).
"""

import asyncio
import os
import sys
import io
import json
import logging

# ─── CUDA DLL PATH FIX ──────────────────────────────────────────────────
# onnxruntime-gpu needs CUDA/cuDNN DLLs from pip-installed nvidia-* packages.
# On Windows, LoadLibrary doesn't search Python's site-packages automatically.
_nvidia_pkg_dir = os.path.join(sys.prefix, "Lib", "site-packages", "nvidia")
if os.path.isdir(_nvidia_pkg_dir):
    _bin_dirs = [os.path.join(_nvidia_pkg_dir, p, "bin") for p in os.listdir(_nvidia_pkg_dir) if os.path.isdir(os.path.join(_nvidia_pkg_dir, p, "bin"))]
    _path = os.environ.get("PATH", "")
    for _bd in _bin_dirs:
        if _bd not in _path:
            _path = _bd + os.pathsep + _path
    os.environ["PATH"] = _path
    # Also set DLL directory for Windows LoadLibrary (needed for DLL dependencies)
    try:
        import ctypes
        _scripts_dir = os.path.join(sys.prefix, "Scripts")
        ctypes.windll.kernel32.SetDllDirectoryA(_scripts_dir)
    except Exception:
        pass

import sqlite3
import base64
import time
import threading
import math
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path

import cv2
import numpy as np
import faiss
from fastapi import FastAPI, File, UploadFile, HTTPException, Depends, Header, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

# ─── Configuration ────────────────────────────────────────────────────────────

FRAME_SKIP: int = int(os.getenv("FACE_FRAME_SKIP", "2"))
# Пороги для ЖИВОЙ детекции (умеренные — баланс между полнотой и ложными срабатываниями)
MIN_FACE_SIZE: int = int(os.getenv("FACE_MIN_FACE_SIZE", "40"))
MIN_DETECTION_SCORE: float = float(os.getenv("FACE_MIN_DET_SCORE", "0.6"))
COOLDOWN_SECONDS: int = int(os.getenv("FACE_COOLDOWN_SECONDS", "30"))
# .env хранит пороги в процентах (0-100), см. .env.example.
# Косинусное сходство FAISS лежит в диапазоне [-1, 1], поэтому переводим в доли.
RECOGNITION_THRESHOLD: float = float(os.getenv("FACE_RECOGNITION_THRESHOLD", "45")) / 100
CONFIRMATION_THRESHOLD: float = float(os.getenv("FACE_CONFIRMATION_THRESHOLD", "55")) / 100
LOW_THRESHOLD: float = float(os.getenv("FACE_LOW_THRESHOLD", "40")) / 100
# Пороги для ИЗВЛЕЧЕНИЯ ЭМБЕДДИНГА (регистрация/обучение) — максимально мягкие:
# здесь мы ХОТИМ вытащить вектор даже из неидеального кадра (размытие/поворот/темнота).
EMBED_MIN_DET_SCORE: float = float(os.getenv("FACE_EMBED_MIN_DET_SCORE", "0.35"))
EMBED_MIN_FACE_SIZE: int = int(os.getenv("FACE_EMBED_MIN_FACE_SIZE", "28"))

# ── ПОРОГИ КАЧЕСТВА ДЛЯ ВОРОТ (ENROLLMENT GATE) ───────────────────────────────
# Жёсткие пороги при ЗАПИСИ РЕФЕРЕНСНОГО эмбеддинга. Мусорные кадры (размытие,
# критический наклон головы, темнота, несколько лиц) НЕ должны попадать в БД —
# иначе они портят поиск. Для живого распознавания используется мягкий путь.
# Нормированная резкость (0..1, через вариацию Лапласиана).
ENROLL_SHARPNESS_SCORE_MIN: float = float(os.getenv("FACE_ENROLL_SHARPNESS_MIN", "0.35"))
# Допустимый угол поворота головы (градусы) по pitch/yaw.
ENROLL_PITCH_MAX_DEG: float = float(os.getenv("FACE_ENROLL_PITCH_MAX", "35.0"))
ENROLL_YAW_MAX_DEG: float = float(os.getenv("FACE_ENROLL_YAW_MAX", "35.0"))
# Средняя яркость лица (0..255, grayscale). Ниже — «темнота».
ENROLL_BRIGHTNESS_MIN: float = float(os.getenv("FACE_ENROLL_BRIGHTNESS_MIN", "40.0"))
# Максимум лиц в кадре при записи (несколько лиц = неоднозначность).
ENROLL_MAX_FACES: int = int(os.getenv("FACE_ENROLL_MAX_FACES", "1"))
# Калибровочный коэффициент «средняя яркость -> примерный люкс» (грубо, для UI).
BRIGHTNESS_TO_LUX: float = float(os.getenv("FACE_BRIGHTNESS_TO_LUX", "0.8"))
ENABLE_PREPROCESS: bool = os.getenv("FACE_ENABLE_PREPROCESS", "1") not in ("0", "false", "False")
API_KEY: str = os.getenv("FACE_API_KEY", "")
DB_PATH: str = os.getenv("DB_PATH", "prisma/dev.db")

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(level=logging.INFO, format="[FaceEngine] %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

# Файловый лог для диагностики ошибок (особенно 500)
_log_file = Path(__file__).parent / "logs" / "face_server.log"
_log_file.parent.mkdir(exist_ok=True)
_file_handler = logging.FileHandler(_log_file, encoding="utf-8")
_file_handler.setFormatter(logging.Formatter("[%(asctime)s] %(levelname)s: %(message)s"))
logger.addHandler(_file_handler)

# ─── Paths ────────────────────────────────────────────────────────────────────

MODELS_DIR = Path(__file__).parent / "models"
MODELS_DIR.mkdir(exist_ok=True)

# ─── FastAPI App ──────────────────────────────────────────────────────────────

app = FastAPI(title="Smart Security - Face Engine", version="4.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def _on_shutdown():
    """Gracefully shut down the FAISS serial executor on server exit."""
    await faiss_executor.shutdown()

# ─── Global State ─────────────────────────────────────────────────────────────

face_app = None
is_initialized = False
used_provider = "CPUExecutionProvider"

faiss_index: Optional[faiss.IndexFlatIP] = None
faiss_index_id_to_person: List[Dict[str, Any]] = []
faiss_lock = threading.Lock()


class FaissSerialExecutor:
    """
    Serial executor for FAISS operations.

    Uses an asyncio.Queue to ensure all operations are executed sequentially
    in a dedicated background task. This prevents:
    - Race conditions between search() and rebuild()
    - Segfaults with GPU FAISS (CUDA context is thread-bound)
    - Event loop blocking on large index rebuild

    All callers must `await` the result. Operations are queued and processed
    one at a time by a single worker task.
    """

    def __init__(self):
        self._queue: Optional[asyncio.Queue] = None
        self._worker_task: Optional[asyncio.Task] = None

    async def _ensure_worker(self):
        """Lazily start the background worker on first use."""
        if self._worker_task is not None:
            return
        self._queue = asyncio.Queue()
        self._worker_task = asyncio.create_task(self._worker())

    async def _worker(self):
        """Background worker that processes FAISS operations serially."""
        while True:
            item = await self._queue.get()
            if item is None:
                break
            op, args, kwargs, future = item
            try:
                result = await asyncio.to_thread(op, *args, **kwargs)
                future.set_result(result)
            except Exception as e:
                future.set_exception(e)
            finally:
                self._queue.task_done()

    async def submit(self, op, *args, **kwargs):
        """Submit a synchronous FAISS operation for serial execution."""
        await self._ensure_worker()
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        await self._queue.put((op, args, kwargs, future))
        return await future

    async def shutdown(self):
        """Gracefully shut down the worker."""
        if self._queue is not None:
            await self._queue.put(None)
        if self._worker_task is not None:
            await self._worker_task
        self._worker_task = None
        self._queue = None


# Singleton executor instance
faiss_executor = FaissSerialExecutor()

last_recognition_time: Dict[str, float] = {}
cooldown_lock = threading.Lock()

_frame_counter = 0
frame_lock = threading.Lock()

_is_index_dirty = False
_last_indexed_count = 0


# ─── Security Middleware ──────────────────────────────────────────────────────

def verify_api_key(x_api_key: str = Header(None, alias="X-API-Key")):
    if not API_KEY:
        return True
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")
    return True


# ─── GPU Provider Selection ───────────────────────────────────────────────────

def get_optimal_providers() -> List[str]:
    """Determines best available GPU acceleration."""
    import onnxruntime as ort
    available_providers = ort.get_available_providers()
    providers: List[str] = []

    if "CUDAExecutionProvider" in available_providers:
        providers.append("CUDAExecutionProvider")
        logger.info("NVIDIA GPU detected. Using CUDA.")
    elif "DmlExecutionProvider" in available_providers:
        providers.append("DmlExecutionProvider")
        logger.info("AMD/Intel GPU detected. Using DirectML.")
    elif "OpenVINOExecutionProvider" in available_providers:
        providers.append("OpenVINOExecutionProvider")
        logger.info("Intel GPU/CPU detected. Using OpenVINO.")
    elif "ROCMExecutionProvider" in available_providers:
        providers.append("ROCMExecutionProvider")
        logger.info("AMD GPU detected. Using ROCm.")
    else:
        logger.warning("No GPU providers found. Falling back to CPU.")

    providers.append("CPUExecutionProvider")
    return providers


# ─── InsightFace Initialization ───────────────────────────────────────────────

def initialize_face_engine() -> Tuple[Any, str]:
    """Initializes InsightFace with smart fallback."""
    used_provider_local = "CPUExecutionProvider"
    try:
        import insightface
        import onnxruntime as ort
        target_providers = get_optimal_providers()
        ort.set_default_logger_severity(3)

        if target_providers == ["CPUExecutionProvider"]:
            logger.info("Initializing InsightFace on CPU...")
            app_instance = insightface.app.FaceAnalysis(
                name="buffalo_l", root=str(MODELS_DIR), providers=["CPUExecutionProvider"]
            )
            app_instance.prepare(ctx_id=-1, det_size=(640, 640))
            logger.info("InsightFace loaded on CPU.")
            return app_instance, "CPUExecutionProvider"

        try:
            logger.info(f"Attempting GPU initialization with: {target_providers[:-1]}")
            app_instance = insightface.app.FaceAnalysis(
                name="buffalo_l", root=str(MODELS_DIR), providers=target_providers
            )
            app_instance.prepare(ctx_id=0, det_size=(640, 640))
            # Test inference to verify GPU actually works (catches cuDNN/LoadLibrary errors
            # that only manifest during model execution, not during prepare)
            try:
                _test_img = np.zeros((640, 640, 3), dtype=np.uint8)
                _test_img[:] = 128
                _ = app_instance.get(_test_img)
            except Exception as test_err:
                raise RuntimeError(f"GPU test inference failed: {test_err}")
            used_provider_local = target_providers[0]
            logger.info(f"InsightFace loaded on {used_provider_local}.")
            return app_instance, used_provider_local
        except Exception as e:
            logger.error(f"GPU initialization failed: {e}")
            logger.warning("Falling back to CPU...")
            app_instance = insightface.app.FaceAnalysis(
                name="buffalo_l", root=str(MODELS_DIR), providers=["CPUExecutionProvider"]
            )
            app_instance.prepare(ctx_id=-1, det_size=(640, 640))
            logger.info("InsightFace loaded on CPU (compatibility mode).")
            return app_instance, "CPUExecutionProvider"

    except Exception as e:
        logger.error(f"Fatal initialization error: {e}")
        import traceback
        traceback.print_exc()
        logger.error("Running in demo mode (no AI).")
        return None, "none"


# ─── Startup ──────────────────────────────────────────────────────────────────

try:
    face_app, used_provider = initialize_face_engine()
    if face_app is not None:
        is_initialized = True
except Exception as e:
    logger.error(f"Startup initialization error: {e}")
    is_initialized = False

# AI Manager instance - NOT initialized at startup to avoid event loop conflicts
# Will be initialized on first request to /api/ai endpoints
ai_manager = None
ai_manager_initialized = False


# ─── FAISS Helpers ────────────────────────────────────────────────────────────

def _build_faiss_index(descriptors: List[Dict[str, Any]]) -> None:
    """Атомарно перестраивает FAISS индекс, блокируя чтение только на время замены."""
    global faiss_index, faiss_index_id_to_person

    if not descriptors:
        with faiss_lock:
            faiss_index = None
            faiss_index_id_to_person = []
        logger.info("FAISS index cleared (no descriptors).")
        return

    dim = 512
    matrix = np.zeros((len(descriptors), dim), dtype=np.float32)
    person_mapping = []

    for i, item in enumerate(descriptors):
        arr = np.array(item["descriptor"], dtype=np.float32)
        norm = np.linalg.norm(arr)
        if norm > 1e-12:
            matrix[i] = arr / norm
        person_mapping.append({
            "person_id": item["person_id"],
            "person_name": item["person_name"],
            "category": item.get("category", ""),
            "photo_path": item.get("photo_path", ""),
        })

    new_index = faiss.IndexFlatIP(dim)
    new_index.add(matrix)

    with faiss_lock:
        faiss_index = new_index
        faiss_index_id_to_person = person_mapping

    logger.info(f"FAISS index atomically swapped: {new_index.ntotal} vectors, dim={dim}.")


def get_faiss_matches(query_vector: np.ndarray, top_k: int = 5) -> List[Dict[str, Any]]:
    """Searches FAISS and returns mapped person data."""
    if faiss_index is None or faiss_index.ntotal == 0:
        return []

    query = np.array(query_vector, dtype=np.float32).reshape(1, -1)
    norm = np.linalg.norm(query)
    if norm > 1e-12:
        query = query / norm

    with faiss_lock:
        scores, indices = faiss_index.search(query, min(top_k, faiss_index.ntotal))

    results: List[Dict[str, Any]] = []
    for score, idx in zip(scores[0], indices[0]):
        if idx == -1:
            continue
        if idx >= len(faiss_index_id_to_person):
            continue
        results.append({
            "score": float(score),
            "person": faiss_index_id_to_person[idx],
        })
    return results


# ─── Async wrappers via FaissSerialExecutor ─────────────────────────────────

async def search_faiss_async(query_vector: np.ndarray, top_k: int = 5) -> List[Dict[str, Any]]:
    """Searches the FAISS index via the serial executor. Thread-safe."""
    return await faiss_executor.submit(get_faiss_matches, query_vector, top_k=top_k)


async def rebuild_faiss_index_async(descriptors: List[Dict[str, Any]]) -> None:
    """Rebuilds the FAISS index via the serial executor. Thread-safe.

    Skips rebuild if the index already has the same number of vectors
    and is not marked dirty.
    """
    global _is_index_dirty, _last_indexed_count

    current_count = len(descriptors)
    if not _is_index_dirty and current_count == _last_indexed_count and faiss_index is not None:
        logger.info(f"FAISS index already up-to-date ({current_count} vectors), skipping rebuild.")
        return

    logger.info(f"Rebuilding FAISS index: {current_count} descriptors (dirty={_is_index_dirty})")
    await faiss_executor.submit(_build_faiss_index, descriptors)
    _last_indexed_count = current_count
    _is_index_dirty = False


def get_faiss_ntotal() -> int:
    """Thread-safe read of the index size."""
    with faiss_lock:
        return faiss_index.ntotal if faiss_index is not None else 0
# ─── SQLite Auto-Load ─────────────────────────────────────────────────────────

def load_descriptors_from_sqlite(db_path: str = DB_PATH) -> List[Dict[str, Any]]:
    """Loads descriptors directly from SQLite for auto-indexing on startup with WAL mode."""
    if not os.path.exists(db_path):
        logger.warning(f"SQLite DB not found at {db_path}, skipping auto-index.")
        return []

    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("""
            SELECT fd.person_id, p.name as person_name, p.category, fd.photo_path, fd.descriptor
            FROM FaceDescriptor fd
            JOIN Person p ON p.id = fd.person_id
        """)
        rows = cursor.fetchall()
        conn.close()

        descriptors: List[Dict[str, Any]] = []
        for row in rows:
            desc_raw = row["descriptor"]
            if isinstance(desc_raw, bytes):
                desc_raw = desc_raw.decode("utf-8")

            desc_list: List[float] = []
            if isinstance(desc_raw, str):
                if desc_raw.strip().startswith("["):
                    desc_list = json.loads(desc_raw)
                else:
                    try:
                        decoded = base64.b64decode(desc_raw)
                        desc_list = np.frombuffer(decoded, dtype=np.float32).tolist()
                    except Exception:
                        desc_list = []

            if not desc_list or len(desc_list) != 512:
                continue

            descriptors.append({
                "person_id": row["person_id"],
                "person_name": row["person_name"],
                "category": row["category"] or "",
                "photo_path": row["photo_path"] or "",
                "descriptor": desc_list,
            })

        logger.info(f"Loaded {len(descriptors)} valid descriptors from SQLite.")
        return descriptors
    except Exception as e:
        logger.error(f"Failed to load descriptors from SQLite: {e}")
        return []

# ─── Startup Auto-Index (✅ ТЕПЕРЬ 100% БЕЗОПАСНО: вызов ПОСЛЕ объявления) ───

if is_initialized:
    try:
        initial_descriptors = load_descriptors_from_sqlite()
        if initial_descriptors:
            _build_faiss_index(initial_descriptors)  # ✅ ТЕПЕРЬ ЭТО РАБОТАЕТ!
        else:
            logger.info("No descriptors found in DB. FAISS index is empty.")
    except Exception as e:
        logger.error(f"Auto-index build failed: {e}")


# ─── Image Helpers ────────────────────────────────────────────────────────────

def load_image_from_bytes(data: bytes) -> Optional[np.ndarray]:
    """Decodes image bytes to RGB numpy array. Handles EXIF rotation and CMYK/P modes."""
    if not data:
        return None
    try:
        img = Image.open(io.BytesIO(data))
        # Применяем EXIF-ориентацию (иначе rotated фото с телефона могут крашить face_app.get)
        try:
            from PIL import ImageOps
            img = ImageOps.exif_transpose(img)
        except Exception:
            pass
        # Конвертируем любой режим в RGB (CMYK, P, LA, RGBA и т.д.)
        if img.mode != "RGB":
            img = img.convert("RGB")
        img_rgb = np.array(img)
    except Exception as e:
        logger.error(f"Image decode failed: {e}")
        import traceback
        traceback.print_exc()
        return None
    if img_rgb.size == 0:
        return None
    return img_rgb


# ─── Quality Gate ─────────────────────────────────────────────────────────────

def passes_quality_gate(face: Any) -> bool:
    """
    Filters low-quality detections before embedding extraction.
    Rejects:
      - det_score < MIN_DETECTION_SCORE
      - face width < MIN_FACE_SIZE
    """
    score = float(face.det_score) if hasattr(face, "det_score") else 0.0
    if score < MIN_DETECTION_SCORE:
        logger.debug(f"Quality gate: score {score:.3f} < {MIN_DETECTION_SCORE}")
        return False

    bbox = face.bbox.astype(int).tolist()
    width = int(bbox[2] - bbox[0])
    if width < MIN_FACE_SIZE:
        logger.debug(f"Quality gate: width {width} < {MIN_FACE_SIZE}")
        return False

    return True


def passes_quality_gate_from_dict(face_dict: Dict[str, Any]) -> bool:
    """
    Filters low-quality detections from AI Manager result (dict format).
    """
    score = float(face_dict.get("det_score", 0))
    if score < MIN_DETECTION_SCORE:
        logger.debug(f"Quality gate (dict): score {score:.3f} < {MIN_DETECTION_SCORE}")
        return False

    bbox = face_dict.get("bbox", [0, 0, 0, 0])
    width = int(bbox[2] - bbox[0])
    if width < MIN_FACE_SIZE:
        logger.debug(f"Quality gate (dict): width {width} < {MIN_FACE_SIZE}")
        return False

    return True


# ─── Quality Assessment (CV metrics) ──────────────────────────────────────────

def _crop_face_region(img: np.ndarray, bbox: np.ndarray, pad_ratio: float = 0.2) -> Optional[np.ndarray]:
    """Возвращает кроп лица с запасом по краям (RGB) либо None."""
    if img is None or img.size == 0:
        return None
    try:
        x1, y1, x2, y2 = bbox.astype(int).tolist()[:4]
        w = max(1, x2 - x1)
        h = max(1, y2 - y1)
        pad = int(max(w, h) * pad_ratio)
        top = max(0, y1 - pad)
        left = max(0, x1 - pad)
        bottom = min(img.shape[0], y2 + pad)
        right = min(img.shape[1], x2 + pad)
        if right <= left or bottom <= top:
            return None
        return img[top:bottom, left:right]
    except Exception:
        return None


def estimate_sharpness(face_crop: Optional[np.ndarray]) -> float:
    """
    Резкость лица через дисперсию Лапласиана (вариацию).
    Низкое значение = размытие в движении / расфокус.
    """
    if face_crop is None or face_crop.size == 0:
        return 0.0
    try:
        gray = cv2.cvtColor(face_crop, cv2.COLOR_RGB2GRAY) if face_crop.ndim == 3 else face_crop
        return float(cv2.Laplacian(gray, cv2.CV_64F).var())
    except Exception:
        return 0.0


def estimate_brightness(face_crop: Optional[np.ndarray]) -> float:
    """Средняя яркость лица (grayscale 0..255). Низкая = недостаточная освещённость."""
    if face_crop is None or face_crop.size == 0:
        return 0.0
    try:
        gray = cv2.cvtColor(face_crop, cv2.COLOR_RGB2GRAY) if face_crop.ndim == 3 else face_crop
        return float(np.mean(gray))
    except Exception:
        return 0.0


def estimate_head_pose(kps: Optional[np.ndarray], img_shape: tuple) -> Optional[Dict[str, float]]:
    """
    Оценка позы головы (pitch/yaw/roll в градусах) через PnP по 5 ландмаркам
    InsightFace (порядок: [right eye, left eye, nose, right mouth, left mouth]).
    Возвращает None, если решить PnP не удалось.
    """
    if kps is None or len(kps) < 5 or img_shape is None or len(img_shape) < 2:
        return None
    try:
        # image_points: [nose, left eye, right eye, left mouth, right mouth]
        image_points = np.array([
            [float(kps[2][0]), float(kps[2][1])],
            [float(kps[1][0]), float(kps[1][1])],
            [float(kps[0][0]), float(kps[0][1])],
            [float(kps[4][0]), float(kps[4][1])],
            [float(kps[3][0]), float(kps[3][1])],
        ], dtype=np.float64)

        # Усреднённая 3D-модель лица (мм), ось Y вниз.
        model_points = np.array([
            [0.0, 0.0, 0.0],            # nose tip
            [-225.0, 170.0, -135.0],    # left eye
            [225.0, 170.0, -135.0],     # right eye
            [-150.0, -150.0, -125.0],   # left mouth corner
            [150.0, -150.0, -125.0],    # right mouth corner
        ], dtype=np.float64)

        h, w = img_shape[:2]
        focal_length = float(w)
        center = (w / 2.0, h / 2.0)
        camera_matrix = np.array(
            [[focal_length, 0.0, center[0]], [0.0, focal_length, center[1]], [0.0, 0.0, 1.0]],
            dtype=np.float64,
        )
        dist_coeffs = np.zeros((4, 1), dtype=np.float64)

        success, rvec, _ = cv2.solvePnP(
            model_points, image_points, camera_matrix, dist_coeffs, flags=cv2.SOLVEPNP_ITERATIVE
        )
        if not success:
            return None

        rmat, _ = cv2.Rodrigues(rvec)
        sy = math.sqrt(rmat[0, 0] ** 2 + rmat[1, 0] ** 2)
        singular = sy < 1e-6
        if not singular:
            pitch = math.atan2(rmat[2, 1], rmat[2, 2])
            yaw = math.atan2(-rmat[2, 0], sy)
            roll = math.atan2(rmat[1, 0], rmat[0, 0])
        else:
            pitch = math.atan2(-rmat[1, 2], rmat[1, 1])
            yaw = math.atan2(-rmat[2, 0], sy)
            roll = 0.0

        return {
            "pitch": round(math.degrees(pitch), 2),
            "yaw": round(math.degrees(yaw), 2),
            "roll": round(math.degrees(roll), 2),
        }
    except Exception as e:
        logger.debug(f"Head pose estimation failed: {e}")
        return None


def _norm_sharpness(lap_var: float, ref: float = 200.0) -> float:
    """Нормировка дисперсии Лапласиана в 0..1: 0 -> 0, ref -> ~0.86."""
    return float(min(1.0, max(0.0, 1.0 - math.exp(-lap_var / ref))))


def _norm_brightness(mean_gray: float, max_b: float = 255.0) -> float:
    return float(min(1.0, max(0.0, mean_gray / max_b)))


def compute_face_quality(face: Any, img: Optional[np.ndarray], face_count: int = 1) -> Dict[str, Any]:
    """
    Считает комплексные метрики качества для одного лица.
    Возвращает сырые метрики, нормированные суб-скоры и итоговый score (0..1).
    """
    crop = _crop_face_region(img, face.bbox) if img is not None else None
    sharp = estimate_sharpness(crop)
    bright = estimate_brightness(crop)
    pose = estimate_head_pose(face.kps, img.shape) if (img is not None and hasattr(face, "kps")) else None

    sharp_n = _norm_sharpness(sharp)
    bright_n = _norm_brightness(bright)
    if pose is not None:
        max_angle = max(abs(pose["pitch"]), abs(pose["yaw"]), abs(pose["roll"]))
        pose_n = max(0.0, 1.0 - max_angle / 90.0)
    else:
        pose_n = 0.5

    # Итоговый score — жёсткое пересечение (min) суб-скоров: один провал =
    # низкое качество. Яркость/резкость масштабируются, чтобы «нормальный»
    # кадр давал ~0.8-0.95, а мусорный — < 0.3.
    score = round(min(sharp_n, 0.4 + 0.6 * bright_n, pose_n), 4)

    return {
        "sharpness": round(sharp, 2),
        "sharpness_score": round(sharp_n, 4),
        "brightness": round(bright, 2),
        "brightness_score": round(bright_n, 4),
        "approx_lux": round(bright * BRIGHTNESS_TO_LUX, 1),
        "pitch": pose["pitch"] if pose else None,
        "yaw": pose["yaw"] if pose else None,
        "roll": pose["roll"] if pose else None,
        "face_count": int(face_count),
        "score": score,
    }


def compute_face_quality_from_dict(face_dict: Dict[str, Any], img: Optional[np.ndarray], face_count: int = 1) -> Dict[str, Any]:
    """
    Считает комплексные метрики качества для одного лица из dict (AI Manager формат).
    Использует bbox из dict и landmarks для оценки позы.
    """
    bbox = face_dict.get("bbox", [0, 0, 0, 0])
    crop = _crop_face_region(img, np.array(bbox)) if img is not None else None
    
    sharp = estimate_sharpness(crop)
    bright = estimate_brightness(crop)
    
    # Try to get keypoints from dict
    kps = face_dict.get("kps")
    pose = estimate_head_pose(np.array(kps) if kps else None, img.shape) if img is not None else None

    sharp_n = _norm_sharpness(sharp)
    bright_n = _norm_brightness(bright)
    if pose is not None:
        max_angle = max(abs(pose["pitch"]), abs(pose["yaw"]), abs(pose["roll"]))
        pose_n = max(0.0, 1.0 - max_angle / 90.0)
    else:
        pose_n = 0.5

    # Итоговый score — жёсткое пересечение (min) суб-скоров
    score = round(min(sharp_n, 0.4 + 0.6 * bright_n, pose_n), 4)

    return {
        "sharpness": round(sharp, 2),
        "sharpness_score": round(sharp_n, 4),
        "brightness": round(bright, 2),
        "brightness_score": round(bright_n, 4),
        "approx_lux": round(bright * BRIGHTNESS_TO_LUX, 1),
        "pitch": pose["pitch"] if pose else None,
        "yaw": pose["yaw"] if pose else None,
        "roll": pose["roll"] if pose else None,
        "face_count": int(face_count),
        "score": score,
    }


def enrollment_issues(quality: Dict[str, Any]) -> List[str]:
    """
    Возвращает список причин, по которым кадр НЕ годится для записи
    референсного эмбеддинга. Пустой список = кадр годен.
    """
    issues: List[str] = []
    if quality.get("sharpness_score", 1.0) < ENROLL_SHARPNESS_SCORE_MIN:
        issues.append("Размытие в движении (Motion Blur)")
    pitch = quality.get("pitch")
    if pitch is not None and abs(pitch) > ENROLL_PITCH_MAX_DEG:
        issues.append(f"Недопустимый угол поворота головы (Pitch > {ENROLL_PITCH_MAX_DEG:g}°)")
    yaw = quality.get("yaw")
    if yaw is not None and abs(yaw) > ENROLL_YAW_MAX_DEG:
        issues.append(f"Недопустимый угол поворота головы (Yaw > {ENROLL_YAW_MAX_DEG:g}°)")
    if quality.get("brightness", 255.0) < ENROLL_BRIGHTNESS_MIN:
        issues.append("Недостаточная освещённость лица")
    if quality.get("face_count", 1) > ENROLL_MAX_FACES:
        issues.append("Обнаружено несколько лиц в кадре")
    return issues


# ─── Cooldown / Debounce ──────────────────────────────────────────────────────

def get_cooldown_key(person_id: Any, category: str = "") -> str:
    return f"{category}:{person_id}"


def is_on_cooldown(person_id: Any, category: str = "") -> bool:
    """Returns True if person was recognized recently. Cleans up expired entries."""
    key = get_cooldown_key(person_id, category)
    now = time.time()
    with cooldown_lock:
        expired_keys = [k for k, v in last_recognition_time.items() if now - v > (COOLDOWN_SECONDS * 2)]
        for k in expired_keys:
            del last_recognition_time[k]

        last_time = last_recognition_time.get(key, 0.0)
        if now - last_time < COOLDOWN_SECONDS:
            logger.debug(f"Cooldown active for {key} ({now - last_time:.1f}s < {COOLDOWN_SECONDS}s)")
            return True
        last_recognition_time[key] = now
    return False


# ─── Frame Skipping ───────────────────────────────────────────────────────────

def should_process_frame() -> bool:
    """
    Frame skipping logic.
    Processes only every N-th frame to reduce inference load by 50-66%.
    """
    global _frame_counter
    with frame_lock:
        _frame_counter += 1
        if FRAME_SKIP <= 1:
            return True
        return _frame_counter % FRAME_SKIP == 0


# ─── API Endpoints ────────────────────────────────────────────────────────────

@app.get("/status")
async def get_status() -> Dict[str, Any]:
    """Returns AI engine status."""
    return {
        "initialized": is_initialized,
        "backend": "insightface" if is_initialized else "demo",
        "provider": used_provider,
        "faiss_vectors": get_faiss_ntotal(),
        "frame_skip": FRAME_SKIP,
        "min_det_score": MIN_DETECTION_SCORE,
        "min_face_size": MIN_FACE_SIZE,
        "cooldown_seconds": COOLDOWN_SECONDS,
        "recognition_threshold": RECOGNITION_THRESHOLD,
        "enroll_sharpness_min": ENROLL_SHARPNESS_SCORE_MIN,
        "enroll_pitch_max_deg": ENROLL_PITCH_MAX_DEG,
        "enroll_yaw_max_deg": ENROLL_YAW_MAX_DEG,
        "enroll_brightness_min": ENROLL_BRIGHTNESS_MIN,
        "enroll_max_faces": ENROLL_MAX_FACES,
    }


@app.get("/health")
async def get_health() -> Dict[str, Any]:
    """Health check endpoint with full AI module status."""
    import platform
    
    result: Dict[str, Any] = {
        "status": "ok",
        "initialized": is_initialized,
        "version": "4.0.0",
        "system": {
            "platform": platform.system(),
            "python": platform.python_version(),
        },
    }
    
    # CUDA status
    import subprocess
    cuda_available = False
    cuda_version = None
    try:
        result_cuda = subprocess.run(
            ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5
        )
        if result_cuda.returncode == 0:
            cuda_version = result_cuda.stdout.strip()
            cuda_available = True
    except Exception:
        pass
    
    result["cuda_available"] = cuda_available
    result["cuda_version"] = cuda_version
    
    # GPU status
    gpu_detected = False
    gpu_name = None
    gpu_available = False
    try:
        import onnxruntime as ort
        providers = ort.get_available_providers()
        gpu_detected = "CUDAExecutionProvider" in providers or "DmlExecutionProvider" in providers
        gpu_available = "CUDAExecutionProvider" in providers or "DmlExecutionProvider" in providers
        
        if gpu_available:
            try:
                import torch
                if torch.cuda.is_available():
                    gpu_name = torch.cuda.get_device_name(0) if torch.cuda.device_count() > 0 else "Unknown GPU"
            except Exception:
                gpu_name = "GPU (ONNX)"
    except Exception:
        pass
    
    result["gpu_detected"] = gpu_detected
    result["gpu_name"] = gpu_name
    result["gpu_available"] = gpu_available
    result["gpu_provider"] = used_provider if is_initialized else None
    
    # AI Modules status - honest checks based on actual module availability
    modules: Dict[str, Any] = {}

    # Load ai_config to get active modules
    ai_config_path = Path(__file__).parent / "ai_config.json"
    active_config = {"detector": "scrfd", "recognizer": "arcface", "tracker": "none"}
    if ai_config_path.exists():
        try:
            with open(ai_config_path, 'r', encoding='utf-8') as f:
                config = json.load(f)
                active_config = config.get("active", active_config)
        except Exception:
            pass

    # Проверяем статус модулей, инстанцируя их и читая info.status
    _module_status_cache: Dict[str, bool] = {}

    def _check_module_installed(module_path: str, class_name: str) -> bool:
        """Проверяет, установлен ли модуль, импортируя и инстанцируя его."""
        if module_path in _module_status_cache:
            return _module_status_cache[module_path]
        try:
            from backend.ai.base import ModuleStatus as _MS
            mod = __import__(module_path, fromlist=[class_name])
            cls = getattr(mod, class_name)
            instance = cls()
            result = instance.info.status != _MS.NOT_INSTALLED
        except Exception:
            result = False
        _module_status_cache[module_path] = result
        return result

    def _module_status(installed: bool, active: bool) -> str:
        """Вычисляет статус модуля для UI: 'ok', 'pending', 'error'."""
        if not installed:
            return "error"
        return "ok" if active else "pending"

    # SCRFD — использует InsightFace buffalo_l (det_10g.onnx)
    scrfd_installed = is_initialized
    modules["scrfd"] = {
        "installed": scrfd_installed,
        "loaded": active_config.get("detector") == "scrfd" and scrfd_installed,
        "active": active_config.get("detector") == "scrfd" and scrfd_installed,
        "status": _module_status(scrfd_installed, scrfd_installed and active_config.get("detector") == "scrfd"),
        "version": "10GF" if scrfd_installed else None,
        "provider": "CUDA" if scrfd_installed else None,
        "description": "SCRFD детектор от InsightFace (buffalo_l)",
        "weight_file": "models/buffalo_l/det_10g.onnx",
    }

    # YOLO-Face — пока не реализован (TODO в исходнике)
    yoloface_installed = _check_module_installed("backend.ai.detectors.yoloface", "YOLOFace")
    modules["yoloface"] = {
        "installed": yoloface_installed,
        "loaded": active_config.get("detector") == "yoloface" and yoloface_installed,
        "active": active_config.get("detector") == "yoloface" and yoloface_installed,
        "status": _module_status(yoloface_installed, yoloface_installed and active_config.get("detector") == "yoloface"),
        "version": "v8" if yoloface_installed else None,
        "provider": "GPU" if yoloface_installed else None,
        "description": "YOLO-Face детектор (YOLOv8)",
    }

    # RetinaFace — пока не реализован (TODO в исходнике)
    retinaface_installed = _check_module_installed("backend.ai.detectors.retinaface", "RetinaFace")
    modules["retinaface"] = {
        "installed": retinaface_installed,
        "loaded": active_config.get("detector") == "retinaface" and retinaface_installed,
        "active": active_config.get("detector") == "retinaface" and retinaface_installed,
        "status": _module_status(retinaface_installed, retinaface_installed and active_config.get("detector") == "retinaface"),
        "version": "0.1" if retinaface_installed else None,
        "provider": "GPU" if retinaface_installed else None,
        "description": "RetinaFace детектор (Multi-scale)",
    }

    # ArcFace — использует InsightFace buffalo_l (w600k_r50.onnx)
    arcface_installed = is_initialized
    modules["arcface"] = {
        "installed": arcface_installed,
        "loaded": active_config.get("recognizer") == "arcface" and arcface_installed,
        "active": active_config.get("recognizer") == "arcface" and arcface_installed,
        "status": _module_status(arcface_installed, arcface_installed and active_config.get("recognizer") == "arcface"),
        "version": "buffalo_l" if arcface_installed else None,
        "provider": "CUDA" if arcface_installed else None,
        "description": "ArcFace алгоритм распознавания (buffalo_l)",
        "weight_file": "models/buffalo_l/w600k_r50.onnx",
    }

    # AdaFace — не реализован
    modules["adaface"] = {
        "installed": False,
        "loaded": False,
        "active": False,
        "status": "error",
        "version": None,
        "provider": None,
        "description": "AdaFace алгоритм распознавания — не реализован",
    }

    # FAISS — импортирован на уровне модуля
    _faiss_active = get_faiss_ntotal() > 0
    modules["faiss"] = {
        "installed": True,
        "loaded": True,
        "active": _faiss_active,
        "status": _module_status(True, _faiss_active),
        "version": "1.11.0",
        "provider": "CPU/GPU",
        "description": "FAISS векторная база данных",
    }

    # ByteTrack — пока не реализован
    bytetrack_installed = _check_module_installed("backend.ai.trackers.bytetrack", "ByteTrack")
    modules["bytetrack"] = {
        "installed": bytetrack_installed,
        "loaded": active_config.get("tracker") == "bytetrack" and bytetrack_installed,
        "active": active_config.get("tracker") == "bytetrack" and bytetrack_installed,
        "status": _module_status(bytetrack_installed, bytetrack_installed and active_config.get("tracker") == "bytetrack"),
        "version": "1.0" if bytetrack_installed else None,
        "provider": "CPU" if bytetrack_installed else None,
        "description": "ByteTrack трекинг",
    }

    # BoT-SORT — пока не реализован
    botsort_installed = _check_module_installed("backend.ai.trackers.botsort", "BoTSORT")
    modules["botsort"] = {
        "installed": botsort_installed,
        "loaded": active_config.get("tracker") == "botsort" and botsort_installed,
        "active": active_config.get("tracker") == "botsort" and botsort_installed,
        "status": _module_status(botsort_installed, botsort_installed and active_config.get("tracker") == "botsort"),
        "version": "1.0" if botsort_installed else None,
        "provider": "CPU" if botsort_installed else None,
        "description": "BoT-SORT трекинг",
    }

    result["modules"] = modules
    
    return result


@app.post("/api/ai/set_detector")
async def set_detector(request: Request):
    """
    Переключить активный детектор
    
    Parameters:
        detector: Имя детектора в body (scrfd, yoloface, retinaface)
    """
    global ai_manager_initialized, ai_manager
    
    try:
        body = await request.json()
        detector = body.get("detector", "scrfd")
        
        logger.info(f"set_detector called with: {detector}")
        
        # Import and initialize AIManager if not already done
        if not ai_manager_initialized:
            sys.path.insert(0, str(Path(__file__).parent))
            from backend.ai.manager.ai_manager import AIManager
            ai_manager = AIManager.get_instance()
            ai_manager_initialized = True
            logger.info("AI Manager initialized on first request")
        
        # Use singleton instance for switching detector
        result = await ai_manager.switch_detector_async(detector)
        
        logger.info(f"set_detector result: {result}")
        
        return {
            "success": result.get('success', False),
            "detector": detector,
            "status": result.get('status', 'active'),
            "message": f"Детектор переключен на {detector}"
        }
    except Exception as e:
        import traceback
        logger.error(f"Failed to switch detector: {e}")
        logger.error(traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"Failed to switch detector: {str(e)}")


@app.post("/api/ai/set_recognizer")
async def set_recognizer(request: Request):
    """
    Переключить активный рекогнайзер
    
    Parameters:
        recognizer: Имя рекогнайзера в body (arcface, adaface)
    """
    global ai_manager_initialized, ai_manager
    
    try:
        body = await request.json()
        recognizer = body.get("recognizer", "arcface")
        
        logger.info(f"set_recognizer called with: {recognizer}")
        
        # Import and initialize AIManager if not already done
        if not ai_manager_initialized:
            sys.path.insert(0, str(Path(__file__).parent))
            from backend.ai.manager.ai_manager import AIManager
            ai_manager = AIManager.get_instance()
            ai_manager_initialized = True
            logger.info("AI Manager initialized on first request")
        
        # Use singleton instance for switching recognizer
        result = await ai_manager.switch_recognizer_async(recognizer)
        
        logger.info(f"set_recognizer result: {result}")
        
        return {
            "success": result.get('success', False),
            "recognizer": recognizer,
            "status": result.get('status', 'active'),
            "message": f"Рекогнайзер переключен на {recognizer}"
        }
    except Exception as e:
        import traceback
        logger.error(f"Failed to switch recognizer: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to switch recognizer: {str(e)}")


@app.post("/api/ai/set_tracker")
async def set_tracker(request: Request):
    """
    Переключить активный трекер
    
    Parameters:
        tracker: Имя трекера в body (bytetrack, botsort, none)
    """
    global ai_manager_initialized, ai_manager
    
    try:
        body = await request.json()
        tracker = body.get("tracker", "none")
        
        logger.info(f"set_tracker called with: {tracker}")
        
        # Import and initialize AIManager if not already done
        if not ai_manager_initialized:
            sys.path.insert(0, str(Path(__file__).parent))
            from backend.ai.manager.ai_manager import AIManager
            ai_manager = AIManager.get_instance()
            ai_manager_initialized = True
            logger.info("AI Manager initialized on first request")
        
        # Use singleton instance for switching tracker
        result = await ai_manager.switch_tracker_async(tracker)
        
        logger.info(f"set_tracker result: {result}")
        
        return {
            "success": result.get('success', False),
            "tracker": tracker,
            "status": result.get('status', 'active'),
            "message": f"Трекер переключен на {tracker}"
        }
    except Exception as e:
        import traceback
        logger.error(f"Failed to switch tracker: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to switch tracker: {str(e)}")


@app.get("/api/ai/status")
async def get_ai_status():
    """
    Получить полный статус AI системы
    
    Returns:
        Статус активных модулей и их версий
    """
    global ai_manager_initialized, ai_manager
    
    try:
        # Import and initialize AIManager if not already done
        if not ai_manager_initialized:
            sys.path.insert(0, str(Path(__file__).parent))
            from backend.ai.manager.ai_manager import AIManager
            ai_manager = AIManager.get_instance()
            ai_manager_initialized = True
            logger.info("AI Manager initialized on first request")
        
        # Get status from singleton instance
        status = ai_manager.get_status()
        
        # Add simple status fields for quick diagnostics
        active = status.get('active', {})
        
        # Get GPU info from face_server
        import subprocess
        cuda_available = False
        cuda_version = None
        try:
            result_cuda = subprocess.run(
                ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=5
            )
            if result_cuda.returncode == 0:
                cuda_version = result_cuda.stdout.strip()
                cuda_available = True
        except Exception:
            pass
        
        # Determine provider from used_provider
        gpu = "none"
        if cuda_available:
            gpu = "cuda"
        elif used_provider == "CPUExecutionProvider":
            gpu = "cpu"
        else:
            gpu = used_provider.lower()
        
        return {
            "detector": active.get("detector", "none"),
            "recognizer": active.get("recognizer", "none"),
            "tracker": active.get("tracker", "none"),
            "gpu": gpu,
            "loaded": ai_manager_initialized,
            "full_status": status
        }
    except Exception as e:
        import traceback
        logger.error(f"Failed to get AI status: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to get AI status: {str(e)}")


@app.post("/detect-faces", dependencies=[Depends(verify_api_key)])
async def detect_faces(
    image: UploadFile = File(...),
    max_faces: Optional[int] = 20,
    min_confidence: Optional[float] = None,
    with_descriptors: Optional[bool] = False,
    with_quality: Optional[bool] = False,
    detector: Optional[str] = None,
    det_size: Optional[str] = None,
    min_face_size: Optional[int] = None,
    min_det_score: Optional[float] = None,
):
    """Detects faces on image. Applies quality gate."""
    try:
        image_bytes = await image.read()
        img = load_image_from_bytes(image_bytes)

        if img is None or img.size == 0:
            raise HTTPException(status_code=400, detail="Empty or invalid image")

        # Determine detector instance
        active_detector = None
        requested_detector = detector
        if not requested_detector and ai_manager_initialized and ai_manager and ai_manager._config_data:
            requested_detector = ai_manager._config_data.get('active', {}).get('detector')
        if not requested_detector:
            requested_detector = 'scrfd'

        if ai_manager_initialized and ai_manager:
            try:
                active_detector = await ai_manager.get_detector(requested_detector)
            except Exception as ai_err:
                logger.warning(f"AI Manager detect failed, falling back to face_app: {ai_err}")

        effective_det_size = 640
        try:
            effective_det_size = int(det_size) if det_size else 640
        except Exception:
            effective_det_size = 640

        if active_detector is not None:
            try:
                faces_data = await active_detector.detect_with_embedding(image_bytes, det_size=effective_det_size)
            except Exception as ai_err:
                logger.warning(f"Active detector failed, falling back to face_app: {ai_err}")
                active_detector = None

        # Fallback to original face_app
        if active_detector is None:
            if not is_initialized or face_app is None:
                return {"faces": []}
            try:
                img_rgb = load_image_from_bytes(image_bytes)
                if img_rgb is None:
                    return {"faces": []}

                orig_h, orig_w = img_rgb.shape[:2]
                target = effective_det_size
                pad_x = 0
                pad_y = 0
                scale = 1.0

                if orig_w != target or orig_h != target:
                    scale = min(target / orig_w, target / orig_h)
                    new_w = int(round(orig_w * scale))
                    new_h = int(round(orig_h * scale))
                    img_resized = np.array(Image.fromarray(img_rgb).resize((new_w, new_h), Image.Resampling.LANCZOS))
                    canvas = np.zeros((target, target, 3), dtype=img_resized.dtype)
                    pad_x = (target - new_w) // 2
                    pad_y = (target - new_h) // 2
                    canvas[pad_y:pad_y + new_h, pad_x:pad_x + new_w] = img_resized
                    img_rgb = canvas

                faces_data = face_app.get(img_rgb)

                if scale != 1.0 or pad_x != 0 or pad_y != 0:
                    for face in faces_data:
                        if hasattr(face, "bbox") and face.bbox is not None:
                            bbox = face.bbox.astype(float)
                            bbox[0] = (bbox[0] - pad_x) / scale
                            bbox[1] = (bbox[1] - pad_y) / scale
                            bbox[2] = (bbox[2] - pad_x) / scale
                            bbox[3] = (bbox[3] - pad_y) / scale
                            face.bbox = bbox
                        if hasattr(face, "kps") and face.kps is not None:
                            kps = face.kps.astype(float)
                            kps[:, 0] = (kps[:, 0] - pad_x) / scale
                            kps[:, 1] = (kps[:, 1] - pad_y) / scale
                            face.kps = kps
            except Exception as face_err:
                logger.error(f"face_app.get() crashed in detect-faces: {face_err}")
                import traceback
                traceback.print_exc()
                raise HTTPException(status_code=500, detail=f"Face detection error: {face_err}")

        results: List[Dict[str, Any]] = []

        # Determine if faces_data is from AI Manager (list of dicts) or InsightFace (list of face objects)
        is_ai_manager_result = faces_data and isinstance(faces_data, list) and len(faces_data) > 0 and isinstance(faces_data[0], dict)

        faces_list = faces_data

        effective_min_face = min_face_size if min_face_size is not None else MIN_FACE_SIZE
        effective_min_score = min_det_score if min_det_score is not None else MIN_DETECTION_SCORE

        for face in faces_list[:max_faces]:
            if is_ai_manager_result:
                score = float(face.get("det_score", 0))
                bbox = face.get("bbox", [0, 0, 0, 0])
                width = int(bbox[2] - bbox[0]) if len(bbox) >= 2 else 0
                if score < effective_min_score or width < effective_min_face:
                    continue

                box = [int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])]
                detection: Dict[str, Any] = {
                    "box": {
                        "x": box[0],
                        "y": box[1],
                        "width": box[2] - box[0],
                        "height": box[3] - box[1],
                    },
                    "score": score,
                    "gender": int(face.get("gender")) if face.get("gender") is not None else None,
                    "gender_str": ("male" if face.get("gender") == 0 else "female") if face.get("gender") is not None else None,
                    "age": int(face.get("age")) if face.get("age") is not None else None,
                }
                if with_descriptors and face.get("embedding"):
                    detection["descriptor"] = face["embedding"]
                if with_quality:
                    quality = compute_face_quality_from_dict(face, img, len(faces_list))
                    detection["quality"] = quality
                    detection["pose"] = {
                        "pitch": quality["pitch"],
                        "yaw": quality["yaw"],
                        "roll": quality["roll"],
                    }
                    detection["enrollment_issues"] = enrollment_issues(quality)
                    detection["enrollment_ok"] = len(detection["enrollment_issues"]) == 0
            else:
                score = float(getattr(face, "det_score", 0))
                bbox = getattr(face, "bbox", np.array([0, 0, 0, 0]))
                width = int(bbox[2] - bbox[0]) if len(bbox) >= 2 else 0
                if score < effective_min_score or width < effective_min_face:
                    continue

                box = face.bbox.astype(int).tolist()
                detection: Dict[str, Any] = {
                    "box": {
                        "x": box[0],
                        "y": box[1],
                        "width": box[2] - box[0],
                        "height": box[3] - box[1],
                    },
                    "score": score,
                    "gender": int(face.gender) if hasattr(face, "gender") and face.gender is not None else None,
                    "gender_str": ("male" if getattr(face, "gender", None) == 0 else "female") if hasattr(face, "gender") and face.gender is not None else None,
                    "age": int(face.age) if hasattr(face, "age") and face.age is not None else None,
                }
                if with_descriptors and hasattr(face, "embedding") and face.embedding is not None:
                    detection["descriptor"] = face.embedding.tolist()
                if with_quality:
                    quality = compute_face_quality(face, img, len(faces_list))
                    detection["quality"] = quality
                    detection["pose"] = {
                        "pitch": quality["pitch"],
                        "yaw": quality["yaw"],
                        "roll": quality["roll"],
                    }
                    detection["enrollment_issues"] = enrollment_issues(quality)
                    detection["enrollment_ok"] = len(detection["enrollment_issues"]) == 0
            results.append(detection)

        return {"faces": results}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Detection error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/calibrate-detector", dependencies=[Depends(verify_api_key)])
async def calibrate_detector(
    image: UploadFile = File(...),
    detector: Optional[str] = "scrfd",
    det_size: Optional[str] = "640",
    min_face_size: Optional[int] = None,
    min_det_score: Optional[float] = None,
    runs: Optional[int] = 1,
):
    """
    Калибровка детектора: возвращает метрики производительности и качества.
    
    Parameters:
        detector: имя детектора (scrfd, yoloface, retinaface)
        det_size: размер детекции (640, 1024, 1280, 1600)
        min_face_size: минимальный размер лица (px)
        min_det_score: минимальный порог уверенности (0..1)
        runs: количество прогонов для усреднения времени (1-10)
    """
    try:
        if runs < 1: runs = 1
        if runs > 10: runs = 10
        
        image_bytes = await image.read()
        img = load_image_from_bytes(image_bytes)
        if img is None or img.size == 0:
            raise HTTPException(status_code=400, detail="Empty or invalid image")

        # Resolve detector
        active_detector = None
        if ai_manager_initialized and ai_manager:
            try:
                requested = detector or 'scrfd'
                active_detector = await ai_manager.get_detector(requested)
            except Exception as ai_err:
                logger.warning(f"AI Manager calibrate failed: {ai_err}")

        effective_det_size = 640
        try:
            effective_det_size = int(det_size) if det_size else 640
        except Exception:
            effective_det_size = 640

        effective_min_face = min_face_size if min_face_size is not None else MIN_FACE_SIZE
        effective_min_score = min_det_score if min_det_score is not None else MIN_DETECTION_SCORE

        times = []
        total_faces = 0
        all_faces = []
        
        for run in range(runs):
            start = time.time()
            
            if active_detector is not None:
                try:
                    faces_data = await active_detector.detect_with_embedding(image_bytes, det_size=effective_det_size)
                except Exception:
                    faces_data = []
            else:
                faces_data = []
            
            elapsed = time.time() - start
            times.append(elapsed)
            
            if run == 0:
                # Apply quality gate and collect faces from first run
                for face in faces_data:
                    score = float(face.get("det_score", 0)) if isinstance(face, dict) else 0
                    bbox = face.get("bbox", [0, 0, 0, 0]) if isinstance(face, dict) else [0, 0, 0, 0]
                    width = int(bbox[2] - bbox[0]) if len(bbox) >= 2 else 0
                    if score < effective_min_score or width < effective_min_face:
                        continue
                    all_faces.append({
                        "score": score,
                        "width": width,
                        "height": int(bbox[3] - bbox[1]) if len(bbox) >= 4 else 0,
                    })
                total_faces = len(all_faces)

        times.sort()
        avg_time = sum(times) / len(times) if times else 0
        median_time = times[len(times) // 2] if times else 0
        min_time = times[0] if times else 0
        max_time = times[-1] if times else 0

        return {
            "detector": detector or "scrfd",
            "det_size": effective_det_size,
            "min_face_size": effective_min_face,
            "min_det_score": effective_min_score,
            "runs": runs,
            "faces_detected": total_faces,
            "faces": all_faces,
            "timing": {
                "avg_ms": round(avg_time * 1000, 2),
                "median_ms": round(median_time * 1000, 2),
                "min_ms": round(min_time * 1000, 2),
                "max_ms": round(max_time * 1000, 2),
                "fps_estimate": round(1.0 / avg_time, 1) if avg_time > 0 else 0,
            },
            "image_size": {"width": img.shape[1], "height": img.shape[0]},
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Calibration error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/assess-quality", dependencies=[Depends(verify_api_key)])
async def assess_quality(image: UploadFile = File(...)):
    """
    Полная оценка качества кадра для извлечения эмбеддинга.
    Возвращает метрики для ВСЕХ лиц + агрегированный вердикт о пригодности
    кадра к записи референсного эмбеддинга (enrollment_issues / enrollment_ok).
    """
    try:
        image_bytes = await image.read()
        img = load_image_from_bytes(image_bytes)

        if img is None or img.size == 0:
            raise HTTPException(status_code=400, detail="Empty or invalid image")

        # Try AI Manager first
        faces_data = None
        if ai_manager_initialized and ai_manager:
            try:
                faces_data = await ai_manager.detect(image_bytes)
            except Exception as ai_err:
                logger.warning(f"AI Manager detect failed, falling back to face_app: {ai_err}")

        # Fallback to original face_app
        if not faces_data:
            if not is_initialized or face_app is None:
                return {
                    "face_detected": False,
                    "face_count": 0,
                    "quality": 0.0,
                    "issues": ["Сервис распознавания лиц недоступен"],
                    "faces": [],
                }
            try:
                faces_data = face_app.get(img)
            except Exception as face_err:
                logger.error(f"face_app.get() crashed in assess-quality: {face_err}, img shape={img.shape}, dtype={img.dtype}")
                import traceback
                traceback.print_exc()
                raise HTTPException(status_code=500, detail=f"Face detection error: {face_err}")

        face_count = len(faces_data)
        
        # Determine if faces_data is from AI Manager (list of dicts) or InsightFace (list of face objects)
        is_ai_manager_result = faces_data and isinstance(faces_data, list) and len(faces_data) > 0 and isinstance(faces_data[0], dict)
        
        if is_ai_manager_result:
            valid_faces = [f for f in faces_data if passes_quality_gate_from_dict(f)]
        else:
            valid_faces = [f for f in faces_data if passes_quality_gate(f)]

        face_payloads: List[Dict[str, Any]] = []
        for face in valid_faces:
            if is_ai_manager_result:
                quality = compute_face_quality_from_dict(face, img, face_count)
                bbox = face.get("bbox", [0, 0, 0, 0])
                box = [int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])]
                face_payloads.append({
                    "box": {"x": box[0], "y": box[1], "width": box[2] - box[0], "height": box[3] - box[1]},
                    "score": float(face.get("det_score", 0)),
                    "gender": ("male" if face.get("gender") == 0 else "female") if face.get("gender") is not None else None,
                    "age": int(face.get("age")) if face.get("age") is not None else None,
                    "quality": quality,
                    "pose": {"pitch": quality["pitch"], "yaw": quality["yaw"], "roll": quality["roll"]},
                    "enrollment_issues": enrollment_issues(quality),
                })
            else:
                quality = compute_face_quality(face, img, face_count)
                box = face.bbox.astype(int).tolist()
                face_payloads.append({
                    "box": {"x": box[0], "y": box[1], "width": box[2] - box[0], "height": box[3] - box[1]},
                    "score": float(face.det_score),
                    "gender": ("male" if getattr(face, "gender", None) == 0 else "female") if hasattr(face, "gender") and face.gender is not None else None,
                    "age": int(face.age) if hasattr(face, "age") and face.age is not None else None,
                    "quality": quality,
                    "pose": {"pitch": quality["pitch"], "yaw": quality["yaw"], "roll": quality["roll"]},
                    "enrollment_issues": enrollment_issues(quality),
                })

        if not valid_faces:
            return {
                "face_detected": face_count > 0,
                "face_count": face_count,
                "quality": 0.0,
                "issues": ["Лицо не обнаружено или слишком низкого качества"] if face_count > 0 else ["Лицо не обнаружено"],
                "faces": [],
            }

        # Первичное лицо = крупнейшее по площади бокса среди валидных.
        if is_ai_manager_result:
            primary = max(valid_faces, key=lambda f: (f.get("bbox", [0,0,0,0])[2] - f.get("bbox", [0,0,0,0])[0]) * (f.get("bbox", [0,0,0,0])[3] - f.get("bbox", [0,0,0,0])[1]))
            primary_quality = compute_face_quality_from_dict(primary, img, face_count)
        else:
            primary = max(valid_faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
            primary_quality = compute_face_quality(primary, img, face_count)
        issues = enrollment_issues(primary_quality)
        if face_count > ENROLL_MAX_FACES:
            issues.append("Обнаружено несколько лиц в кадре")

        return {
            "face_detected": True,
            "face_count": face_count,
            "quality": primary_quality["score"],
            "issues": issues,
            "enrollment_ok": len(issues) == 0,
            "primary": {
                "score": float(primary.get("det_score", primary.det_score if not is_ai_manager_result else 0)),
                "quality": primary_quality,
                "gender": ("male" if primary.get("gender") == 0 else "female") if primary.get("gender") is not None else (primary.gender if not is_ai_manager_result else None),
                "age": int(primary.get("age")) if primary.get("age") is not None else (primary.age if not is_ai_manager_result else None),
            },
            "faces": face_payloads,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Quality assessment error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/get-embedding", dependencies=[Depends(verify_api_key)])
async def get_embedding(
    image: UploadFile = File(...),
    strict: Optional[bool] = False,
):
    """
    Extracts face embedding from image.

    - strict=false (по умолчанию): МЯГКИЙ путь для живого распознавания —
      ворота по det_score/размеру, но вектор тянется даже из неидеального кадра.
    - strict=true: ЖЁСТКИЙ путь для ЗАПИСИ референсного эмбеддинга —
      мусорные кадры (размытие, критический наклон, темнота, несколько лиц)
      отклоняются с перечислением причин в issues.
    """
    try:
        image_bytes = await image.read()
        img = load_image_from_bytes(image_bytes)

        if not is_initialized or face_app is None:
            raise HTTPException(status_code=400, detail="AI not initialized")

        if img is None or img.size == 0:
            raise HTTPException(status_code=400, detail="Empty or invalid image")

        try:
            faces = face_app.get(img)
        except Exception as face_err:
            logger.error(f"face_app.get() crashed: {face_err}, img shape={img.shape}, dtype={img.dtype}")
            import traceback
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"Face detection error: {face_err}")

        if not faces:
            return {"descriptor": None, "error": "No face detected", "quality": None, "issues": ["Лицо не обнаружено"]}

        face = faces[0]
        if not passes_quality_gate(face):
            return {"descriptor": None, "error": "Low quality face", "quality": None, "issues": ["Низкое качество детекции лица"]}

        face_count = len(faces)
        quality = compute_face_quality(face, img, face_count)

        if strict:
            issues = enrollment_issues(quality)
            if issues:
                logger.info(f"Enrollment gate REJECTED: {issues} (score={quality['score']})")
                return {
                    "descriptor": None,
                    "error": "Enrollment quality gate failed",
                    "quality": quality,
                    "issues": issues,
                    "passed": False,
                }

        if not hasattr(face, "embedding") or face.embedding is None:
            return {"descriptor": None, "error": "Failed to extract embedding", "quality": quality, "issues": []}

        return {
            "descriptor": face.embedding.tolist(),
            "quality": quality,
            "issues": [],
            "passed": True,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Embedding error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/recognize", dependencies=[Depends(verify_api_key)])
async def recognize(
    image: UploadFile = File(...),
    top_k: Optional[int] = 5,
    category: Optional[str] = "",
    threshold: Optional[float] = None,
    apply_cooldown: Optional[bool] = True,
):
    """
    Full recognition pipeline.
    OPTIMIZED: Frame skip check happens BEFORE image decoding to save I/O and CPU.
    """
    if not should_process_frame():
        return {"matches": [], "status": "skipped"}

    try:
        image_bytes = await image.read()
        img = load_image_from_bytes(image_bytes)

        if not is_initialized or face_app is None:
            return {"matches": [], "status": "demo"}

        if img is None or img.size == 0:
            raise HTTPException(status_code=400, detail="Empty or invalid image")

        faces = face_app.get(img)
        if not faces:
            return {"matches": [], "status": "no_faces"}

        valid_faces = [f for f in faces if passes_quality_gate(f)]
        if not valid_faces:
            return {"matches": [], "status": "no_valid_faces"}

        primary_face = valid_faces[0]
        if not hasattr(primary_face, "embedding") or primary_face.embedding is None:
            return {"matches": [], "status": "no_embedding"}

        embedding = np.array(primary_face.embedding, dtype=np.float32)
        candidates = await search_faiss_async(embedding, top_k=top_k)
        effective_threshold = threshold if threshold is not None else RECOGNITION_THRESHOLD

        matches: List[Dict[str, Any]] = []
        needs_confirmation_data = None
        best_sim = 0.0

        for candidate in candidates:
            person = candidate["person"]
            sim = float(candidate["score"])

            if sim > best_sim:
                best_sim = sim

            # Не отбрасываем кандидата с ВЫСОКИМ сходством из-за несовпадения
            # категории: такой кандидат должен попасть к оператору на подтверждение
            # (серая зона / авто-распознавание), а не молча уходить в unknown.
            if category and person.get("category") != category:
                if sim < LOW_THRESHOLD:
                    continue

            if LOW_THRESHOLD <= sim < CONFIRMATION_THRESHOLD:
                needs_confirmation_data = {
                    "person_id": person["person_id"],
                    "person_name": person["person_name"],
                    "similarity": sim,
                    "photo_path": person.get("photo_path", ""),
                }
                continue

            if sim < effective_threshold:
                continue

            person_id = person["person_id"]
            if apply_cooldown and is_on_cooldown(person_id, person.get("category", "")):
                continue

            matches.append({
                "person_id": person_id,
                "person_name": person["person_name"],
                "category": person.get("category", ""),
                "photo_path": person.get("photo_path", ""),
                "similarity": sim,
            })

        matches.sort(key=lambda x: x["similarity"], reverse=True)

        response = {
            "matches": matches[:top_k],
            "status": "ok" if matches else ("needs_confirmation" if needs_confirmation_data else "unknown"),
            "total_vectors": get_faiss_ntotal(),
            "best_similarity": best_sim,
            "threshold": effective_threshold,
            "gender": ("male" if getattr(primary_face, "gender", None) == 0 else "female") if hasattr(primary_face, "gender") and primary_face.gender is not None else None,
            "age": int(primary_face.age) if hasattr(primary_face, "age") and primary_face.age is not None else None,
        }

        if needs_confirmation_data and not matches:
            response["confirmation_candidate"] = needs_confirmation_data

        return response
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Recognition error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/recognize-by-descriptor", dependencies=[Depends(verify_api_key)])
async def recognize_by_descriptor(
    payload: Dict[str, Any],
    top_k: Optional[int] = 5,
    category: Optional[str] = "",
    threshold: Optional[float] = None,
    apply_cooldown: Optional[bool] = True,
):
    """
    Recognition by precomputed descriptor (no re-detection).
    Expected JSON body:
    {
      "descriptor": [float, float, ...],
        "person_label": "optional_label_for_cooldown"
    }
    """
    # NOTE: намеренно НЕ вызываем should_process_frame() — дескриптор уже вычислен
    # детектором, здесь только дешёвый FAISS-поиск. Frame-skip здесь приводил к тому,
    # что половина вызовов возвращала status:"skipped" (пустые matches) → лицо
    # ошибочно считалось "неизвестным" и плодило дубликаты персон.
    try:
        descriptor_raw = payload.get("descriptor")
        if not descriptor_raw:
            raise HTTPException(status_code=400, detail="Missing descriptor")

        embedding = np.array(descriptor_raw, dtype=np.float32)
        if embedding.size == 0:
            raise HTTPException(status_code=400, detail="Empty descriptor")

        candidates = await search_faiss_async(embedding, top_k=top_k)
        effective_threshold = threshold if threshold is not None else RECOGNITION_THRESHOLD

        matches: List[Dict[str, Any]] = []
        needs_confirmation_data = None
        best_sim = 0.0

        for candidate in candidates:
            person = candidate["person"]
            sim = float(candidate["score"])

            if sim > best_sim:
                best_sim = sim

            # Не отбрасываем кандидата с ВЫСОКИМ сходством из-за несовпадения
            # категории: такой кандидат должен попасть к оператору на подтверждение
            # (серая зона / авто-распознавание), а не молча уходить в unknown.
            if category and person.get("category") != category:
                if sim < LOW_THRESHOLD:
                    continue

            if LOW_THRESHOLD <= sim < CONFIRMATION_THRESHOLD:
                needs_confirmation_data = {
                    "person_id": person["person_id"],
                    "person_name": person["person_name"],
                    "similarity": sim,
                    "photo_path": person.get("photo_path", ""),
                }
                continue

            if sim < effective_threshold:
                continue

            person_id = person["person_id"]
            if apply_cooldown and is_on_cooldown(person_id, person.get("category", "")):
                continue

            matches.append({
                "person_id": person_id,
                "person_name": person["person_name"],
                "category": person.get("category", ""),
                "photo_path": person.get("photo_path", ""),
                "similarity": sim,
            })

        matches.sort(key=lambda x: x["similarity"], reverse=True)

        response = {
            "matches": matches[:top_k],
            "status": "ok" if matches else ("needs_confirmation" if needs_confirmation_data else "unknown"),
            "total_vectors": get_faiss_ntotal(),
            "best_similarity": best_sim,
            "threshold": effective_threshold,
        }

        if needs_confirmation_data and not matches:
            response["confirmation_candidate"] = needs_confirmation_data

        return response
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Descriptor recognition error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/update-index", dependencies=[Depends(verify_api_key)])
async def update_index(payload: Dict[str, Any]):
    """
    Rebuilds FAISS index securely. Requires X-API-Key header.
    """
    try:
        persons = payload.get("persons", [])
        if not persons:
            await rebuild_faiss_index_async([])
            return {"status": "ok", "indexed": 0}

        await rebuild_faiss_index_async(persons)
        return {
            "status": "ok",
            "indexed": len(persons),
            "total_vectors": get_faiss_ntotal(),
        }
    except Exception as e:
        logger.error(f"Index update error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/compare-faces", dependencies=[Depends(verify_api_key)])
async def compare_faces(
    descriptor1: UploadFile = File(...),
    descriptor2: UploadFile = File(...)
):
    """Compares two embeddings using normalized dot product."""
    try:
        d1 = np.array(json.loads((await descriptor1.read()).decode()), dtype=np.float32)
        d2 = np.array(json.loads((await descriptor2.read()).decode()), dtype=np.float32)

        d1 = d1 / (np.linalg.norm(d1) + 1e-12)
        d2 = d2 / (np.linalg.norm(d2) + 1e-12)
        similarity = float(np.dot(d1, d2))
        return {"similarity": similarity}
    except Exception as e:
        logger.error(f"Comparison error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ─── Entrypoint ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
