"""
AIManager - Единая точка входа для AI операций

Весь остальной проект должен работать только через AIManager.
Не знает, какой Router используется внутри.
"""

import os
import json
import logging
import traceback
import asyncio
from pathlib import Path
from typing import Dict, Any, Optional

from ..detectors.scrfd import SCRFD
from ..detectors.yoloface import YOLOFace
from ..detectors.retinaface import RetinaFace
from ..recognizers.arcface import ArcFace
from ..trackers.bytetrack import ByteTrack
from ..database.faiss import FAISS
from ..router.detector_router import DetectorRouter
from ..router.recognizer_router import RecognizerRouter
from ..router.tracker_router import TrackerRouter
from ..base import ModuleStatus, ModuleInfo


class AIManager:
    """
    Единый менеджер AI операций.

    Скрывает детали реализации (рouters, конкретные модели) от остальной системы.
    Поддерживает динамическое переключение модулей без перезапуска.
    Детекторы хранятся в пуле: можно загружать несколько детекторов одновременно,
    чтобы разные камеры/зоны могли использовать разные модели без гонок за _active_detector.
    """

    CONFIG_PATH = Path(__file__).parent.parent.parent / "ai_config.json"
    _instance = None

    @staticmethod
    def get_instance() -> 'AIManager':
        """Get singleton instance."""
        return AIManager()

    def __new__(cls, config: dict = None):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self, config: dict = None):
        import logging
        logger = logging.getLogger(__name__)

        logger.info(f"AIManager.__init__ called, self._initialized={getattr(self, '_initialized', 'N/A')}")

        if self._initialized:
            logger.info("AIManager already initialized, skipping")
            return
        self.config = config or {}
        self._config_data = self._load_config()

        # Router instances
        self.detector_router = DetectorRouter(self._config_data.get('router', {}))
        self.recognizer_router = RecognizerRouter(self._config_data.get('router', {}))
        self.tracker_router = TrackerRouter(self._config_data.get('router', {}))

        # Module pools: храним по одному экземпляру на имя модуля
        self._detector_instances: Dict[str, Any] = {}
        self._recognizer_instances: Dict[str, Any] = {}
        self._tracker_instances: Dict[str, Any] = {}

        # Default active module names (для обратной совместимости с UI)
        self._active_detector_name: Optional[str] = None
        self._active_recognizer_name: Optional[str] = None
        self._active_tracker_name: Optional[str] = None

        self._faiss: Optional[FAISS] = None

        # Module classes mapping
        self._detector_classes = {
            'scrfd': SCRFD,
            'yoloface': YOLOFace,
            'retinaface': RetinaFace,
        }
        self._recognizer_classes = {
            'arcface': ArcFace,
            'adaface': ArcFace,
        }
        self._tracker_classes = {
            'bytetrack': ByteTrack,
            'botsort': ByteTrack,
        }

        self._initialized = True

    def _load_config(self) -> dict:
        """Загрузить конфигурацию из ai_config.json"""
        try:
            if self.CONFIG_PATH.exists():
                with open(self.CONFIG_PATH, 'r', encoding='utf-8') as f:
                    return json.load(f)
        except Exception as e:
            print(f"Failed to load ai_config.json: {e}")
        return {
            "active": {
                "detector": "scrfd",
                "recognizer": "arcface",
                "tracker": "none"
            },
            "detectors": {"scrfd": {"enabled": True}},
            "recognizers": {"arcface": {"enabled": True}},
            "trackers": {}
        }

    def _save_config(self) -> bool:
        """Сохранить конфигурацию в ai_config.json"""
        try:
            with open(self.CONFIG_PATH, 'w', encoding='utf-8') as f:
                json.dump(self._config_data, f, indent=2, ensure_ascii=False)
            return True
        except Exception as e:
            print(f"Failed to save ai_config.json: {e}")
            return False

    async def initialize(self) -> bool:
        """Инициализация AIManager и загрузка активных модулей"""
        self._config_data = self._load_config()

        active_detector = self._config_data.get('active', {}).get('detector', 'scrfd')
        active_recognizer = self._config_data.get('active', {}).get('recognizer', 'arcface')

        await self._load_detector(active_detector)
        await self._load_recognizer(active_recognizer)

        return True

    async def _load_detector(self, name: str) -> bool:
        """Загрузить детектор в пул (не выгружает остальные)"""
        import logging
        logger = logging.getLogger(__name__)

        logger.info(f"_load_detector called: {name}")

        try:
            if name == 'none':
                self._detector_instances.pop(name, None)
                self._active_detector_name = None
                self.detector_router._current_detector = None
                return True

            if name not in self._detector_classes:
                print(f"Unknown detector: {name}")
                logger.error(f"Unknown detector: {name}")
                return False

            if name in self._detector_instances:
                logger.info(f"Detector {name} already loaded, reusing")
                self._active_detector_name = name
                self.detector_router._current_detector = self._detector_instances[name]
                self._config_data['active']['detector'] = name
                if name in self._config_data.get('detectors', {}):
                    self._config_data['detectors'][name]['status'] = 'active'
                self._save_config()
                return True

            logger.info(f"Creating new detector instance: {name}")

            detector_class = self._detector_classes[name]
            instance = detector_class()

            logger.info(f"Initializing detector: {name}")

            await asyncio.to_thread(instance.initialize)

            self._detector_instances[name] = instance
            self._active_detector_name = name

            # Обновляем router
            self.detector_router._current_detector = instance

            # Обновляем статус в конфиге
            self._config_data['active']['detector'] = name
            if name in self._config_data.get('detectors', {}):
                self._config_data['detectors'][name]['status'] = 'active'

            self._save_config()

            logger.info(f"Loaded detector: {name}")
            return True

        except Exception as e:
            print(f"Failed to load detector {name}: {e}")
            import traceback as tb
            logger.error(f"Failed to load detector {name}: {e}")
            logger.error(tb.format_exc())
            return False

    async def _load_recognizer(self, name: str) -> bool:
        """Загрузить рекогнайзер в пул"""
        try:
            if name == 'none':
                self._recognizer_instances.pop(name, None)
                self._active_recognizer_name = None
                self.recognizer_router._current_recognizer = None
                return True

            if name not in self._recognizer_classes:
                print(f"Unknown recognizer: {name}")
                return False

            if name in self._recognizer_instances:
                self._active_recognizer_name = name
                self.recognizer_router._current_recognizer = self._recognizer_instances[name]
                self._config_data['active']['recognizer'] = name
                if name in self._config_data.get('recognizers', {}):
                    self._config_data['recognizers'][name]['status'] = 'active'
                self._save_config()
                return True

            recognizer_class = self._recognizer_classes[name]
            instance = recognizer_class()
            await asyncio.to_thread(instance.initialize)

            self._recognizer_instances[name] = instance
            self._active_recognizer_name = name

            self.recognizer_router._current_recognizer = instance

            self._config_data['active']['recognizer'] = name
            if name in self._config_data.get('recognizers', {}):
                self._config_data['recognizers'][name]['status'] = 'active'

            self._save_config()

            print(f"Loaded recognizer: {name}")
            return True

        except Exception as e:
            print(f"Failed to load recognizer {name}: {e}")
            return False

    async def _load_tracker(self, name: str) -> bool:
        """Загрузить трекер в пул"""
        try:
            if name == 'none':
                self._tracker_instances.pop(name, None)
                self._active_tracker_name = None
                self.tracker_router._current_tracker = None
                return True

            if name not in self._tracker_classes:
                print(f"Unknown tracker: {name}")
                return False

            if name in self._tracker_instances:
                self._active_tracker_name = name
                self.tracker_router._current_tracker = self._tracker_instances[name]
                self._config_data['active']['tracker'] = name
                if name in self._config_data.get('trackers', {}):
                    self._config_data['trackers'][name]['status'] = 'active'
                self._save_config()
                return True

            tracker_class = self._tracker_classes[name]
            instance = tracker_class()
            await asyncio.to_thread(instance.initialize)

            self._tracker_instances[name] = instance
            self._active_tracker_name = name

            self.tracker_router._current_tracker = instance

            self._config_data['active']['tracker'] = name
            if name in self._config_data.get('trackers', {}):
                self._config_data['trackers'][name]['status'] = 'active'

            self._save_config()

            print(f"Loaded tracker: {name}")
            return True

        except Exception as e:
            print(f"Failed to load tracker {name}: {e}")
            return False

    async def get_detector(self, name: str) -> Optional[Any]:
        """Получить детектор из пула, загружая при необходимости."""
        if not name or name == 'none':
            return None
        if name not in self._detector_instances:
            await self._load_detector(name)
        return self._detector_instances.get(name)

    async def get_recognizer(self, name: str) -> Optional[Any]:
        """Получить рекогнайзер из пула."""
        if not name or name == 'none':
            return None
        if name not in self._recognizer_instances:
            await self._load_recognizer(name)
        return self._recognizer_instances.get(name)

    async def get_tracker(self, name: str) -> Optional[Any]:
        """Получить трекер из пула."""
        if not name or name == 'none':
            return None
        if name not in self._tracker_instances:
            await self._load_tracker(name)
        return self._tracker_instances.get(name)

    async def detect(self, image_bytes: bytes, detector_name: str = None) -> list:
        """
        Детектировать лица на изображении через пул детекторов.

        Args:
            image_bytes: Байты изображения
            detector_name: Опциональное переопределение детектора для этого запроса

        Returns:
            Список детектированных лиц
        """
        name = detector_name or self._active_detector_name or 'scrfd'
        detector = await self.get_detector(name)
        if not detector:
            return []

        try:
            return await asyncio.to_thread(detector.detect_with_embedding, image_bytes)
        except Exception as e:
            logger = logging.getLogger(__name__)
            logger.error(f"Detector {name} failed: {e}")
            return []

    async def recognize(self, face_image: bytes, recognizer_name: str = None, category: str = None) -> dict:
        """Распознать лицо через пул рекогнайзеров."""
        name = recognizer_name or self._active_recognizer_name or 'arcface'
        recognizer = await self.get_recognizer(name)
        if not recognizer:
            return {'error': 'No recognizer loaded'}

        embedding = await asyncio.to_thread(recognizer.extract_embedding, face_image)
        if not embedding:
            return {'error': 'Failed to extract embedding'}

        faiss = FAISS()
        await faiss.initialize()
        results = await faiss.search(embedding, top_k=5)

        return {
            'embedding': embedding,
            'matches': results
        }

    async def search(self, embedding: list, category: str = None) -> list:
        """Поиск по эмбеддингу в базе."""
        faiss = FAISS()
        await faiss.initialize()
        return await faiss.search(embedding, top_k=5, threshold=0.4)

    async def track(self, frames: list, tracker_name: str = None) -> list:
        """Отследить лица по кадрам через пул трекеров."""
        name = tracker_name or self._active_tracker_name or 'none'
        tracker = await self.get_tracker(name)
        if not tracker:
            return []
        return await tracker.track(frames)

    async def switch_detector_async(self, name: str) -> dict:
        """Переключить детектор по умолчанию (для UI)."""
        success = await self._load_detector(name)
        return {
            'success': success,
            'detector': name,
            'status': 'active' if success else 'error'
        }

    async def switch_recognizer_async(self, name: str) -> dict:
        """Переключить рекогнайзер по умолчанию (для UI)."""
        success = await self._load_recognizer(name)
        return {
            'success': success,
            'recognizer': name,
            'status': 'active' if success else 'error'
        }

    async def switch_tracker_async(self, name: str) -> dict:
        """Переключить трекер по умолчанию (для UI)."""
        success = await self._load_tracker(name)
        return {
            'success': success,
            'tracker': name,
            'status': 'active' if success else 'error'
        }

    def get_status(self) -> dict:
        """Получить полный статус AI системы."""
        self._config_data = self._load_config()

        active_detector = self._active_detector_name or self._config_data.get('active', {}).get('detector', 'none')
        active_recognizer = self._active_recognizer_name or self._config_data.get('active', {}).get('recognizer', 'none')
        active_tracker = self._active_tracker_name or self._config_data.get('active', {}).get('tracker', 'none')

        detectors = self._config_data.get('detectors', {})
        recognizers = self._config_data.get('recognizers', {})
        trackers = self._config_data.get('trackers', {})

        modules_status = {}

        for name in ['scrfd', 'yoloface', 'retinaface']:
            mod = detectors.get(name, {})
            mod_status = mod.get('status', 'not_installed')
            installed = mod_status != 'not_installed'
            model_path = mod.get('model_path')
            if installed and model_path:
                from pathlib import Path
                model_file = Path(__file__).parent.parent.parent.parent / model_path
                installed = model_file.exists()
            modules_status[name] = {
                'installed': installed or name in self._detector_instances,
                'loaded': name == active_detector or name in self._detector_instances,
                'active': name == active_detector,
                'version': mod.get('version') if installed else None,
                'provider': mod.get('provider'),
            }

        for name in ['arcface', 'adaface']:
            mod = recognizers.get(name, {})
            mod_status = mod.get('status', 'not_instaled')
            installed = mod_status != 'not_installed'
            model_path = mod.get('model_path')
            if installed and model_path:
                from pathlib import Path
                model_file = Path(__file__).parent.parent.parent.parent / model_path
                installed = model_file.exists()
            modules_status[name] = {
                'installed': installed or name in self._recognizer_instances,
                'loaded': name == active_recognizer or name in self._recognizer_instances,
                'active': name == active_recognizer,
                'version': mod.get('version') if installed else None,
                'provider': mod.get('provider'),
            }

        for name in ['bytetrack', 'botsort']:
            mod = trackers.get(name, {})
            mod_status = mod.get('status', 'not_installed')
            installed = mod_status != 'not_installed'
            modules_status[name] = {
                'installed': installed or name in self._tracker_instances,
                'loaded': name == active_tracker or name in self._tracker_instances,
                'active': name == active_tracker,
                'version': mod.get('version') if installed else None,
                'provider': mod.get('provider'),
            }

        return {
            'active': {
                'detector': active_detector,
                'recognizer': active_recognizer,
                'tracker': active_tracker,
            },
            'modules': modules_status,
        }
