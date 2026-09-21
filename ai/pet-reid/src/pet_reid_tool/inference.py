"""犬隻 Re-ID 推論介面——公開展示版。

這個檔案的對外介面與正式版完全相同（`PetReIdShadowRuntime.embed()` 收圖片
bytes、回傳一個 L2 正規化後的向量，附上模型版本與輸入雜湊），但實作換成了
**ImageNet 預訓練權重直接取特徵**。

為什麼要這樣換：
  正式版載入的是用私有資料集訓練出來的 checkpoint，那份權重與訓練配方是這個
  專案唯一真正的競爭力來源，不公開。但「介面長什麼樣、服務怎麼包、輸入怎麼
  驗證、向量怎麼保證正規化」這些工程決定本身沒有保密價值，留著才能讓人看懂
  整條路徑怎麼運作。

  換成公開權重之後，這支程式仍然可以跑、可以測、可以接上 server.py 起服務，
  只是檢索準確度會明顯差於正式版——ImageNet 特徵能分辨「狗 vs 貓」，不太能
  分辨「這隻柴犬 vs 那隻柴犬」。這正是自訓模型要解的問題。

正式版與這裡的差異，只有兩處：
  1. 建構子會讀 checkpoint 與 model card，並比對 SHA-256 與訓練來源宣告，
     確認這份權重沒有混入營運中的 App 使用者照片。
  2. 骨幹後面接自訓的投影層與 BatchNorm，輸出維度由訓練設定決定。

其餘的輸入驗證、EXIF 轉正、大小限制、正規化檢查、回應格式都是一樣的。
"""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import hmac
import io
import math
import threading
from typing import Any

from PIL import Image, ImageOps


# 單張圖片上限。超過這個大小就直接拒絕，不進到解碼階段，避免用超大圖把服務打掛。
MAX_IMAGE_BYTES = 10 * 1024 * 1024
SUPPORTED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}


@dataclass(frozen=True)
class ShadowEmbeddingResult:
    """一次推論的結果。欄位與正式版一致。"""

    model_version: str
    preprocessing_version: str
    input_sha256: str
    source_width: int
    source_height: int
    embedding: list[float]

    def as_response(self) -> dict[str, Any]:
        return {
            "schema_version": "pet-reid-embedding-response-v1",
            "model_version": self.model_version,
            "preprocessing_version": self.preprocessing_version,
            # 明確標示分數的性質是 cosine similarity，不是機率。下游不可以把它
            # 當成「有幾成把握是同一隻狗」顯示給使用者。
            "score_kind": "cosine_similarity",
            "embedding_dim": len(self.embedding),
            "embedding": self.embedding,
            "input_sha256": self.input_sha256,
            "source_width": self.source_width,
            "source_height": self.source_height,
            "normalized": True,
            # shadow_only 表示這條推論路徑只做觀測、不影響產品決策；
            # identity_confirmed 永遠是 False，確認身分是人的職責，不是模型的。
            "shadow_only": True,
            "identity_confirmed": False,
            # 經過這個端點的照片不會因此取得訓練資格，避免營運資料悄悄回流到訓練集。
            "training_eligible": False,
        }


def authorized(provided_token: str | None, expected_token: str) -> bool:
    """用固定時間比較驗證服務權杖，避免以比較耗時反推權杖內容。"""
    return bool(provided_token) and hmac.compare_digest(provided_token, expected_token)


class PetReIdShadowRuntime:
    """把一張圖片轉成可比對的向量。

    正式版的建構子是 `__init__(checkpoint_path, model_card_path)`；公開版不需要
    任何檔案，因為權重直接由 torchvision 下載 ImageNet 預訓練參數。
    """

    def __init__(self) -> None:
        try:
            import torch
            from torch import nn
            from torchvision import models, transforms
        except ImportError as error:
            raise RuntimeError(
                'Install inference dependencies with: python -m pip install -e ".[torch]"'
            ) from error

        # 骨幹與正式版相同（MobileNetV3-Small），差別在權重來源與後面接的層。
        # 這裡把分類頭換成 Identity，直接拿骨幹輸出的特徵當向量。
        backbone = models.mobilenet_v3_small(weights=models.MobileNet_V3_Small_Weights.IMAGENET1K_V1)
        embedding_dim = backbone.classifier[0].in_features
        backbone.classifier = nn.Identity()
        backbone.eval()

        self._torch = torch
        self._model = backbone
        self._transform = transforms.Compose(
            [
                transforms.Resize((224, 224), antialias=True),
                transforms.ToTensor(),
                transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
            ]
        )
        # ThreadingHTTPServer 會同時有多個請求進來，但 PyTorch 模型在 CPU 上共用
        # 同一份 buffer，因此推論時上鎖序列化，換取結果穩定。
        self._lock = threading.Lock()

        # 版本字串刻意標明這是 baseline，讓任何存下來的向量都能追溯到產生它的模型。
        self.model_version = "imagenet-mobilenetv3-small-baseline-v1"
        self.preprocessing_version = "resize224-imagenet-norm-v1"
        self.embedding_dim = embedding_dim

    def embed(self, image_bytes: bytes, content_type: str) -> ShadowEmbeddingResult:
        if content_type not in SUPPORTED_CONTENT_TYPES:
            raise ValueError("unsupported image content type")
        if not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
            raise ValueError("image size is outside the supported range")

        try:
            # 先 verify 再重新開檔：verify() 會消耗掉 file handle，不能直接接著用，
            # 但它能在真正解碼前擋掉結構壞掉的檔案。
            with Image.open(io.BytesIO(image_bytes)) as source:
                source.verify()
            with Image.open(io.BytesIO(image_bytes)) as source:
                # 手機拍的照片方向常記在 EXIF 而不是像素裡，不轉正的話同一隻狗
                # 直立和橫躺會被當成兩種東西。
                image = ImageOps.exif_transpose(source).convert("RGB")
        except Exception as error:
            raise ValueError("invalid image") from error

        source_width, source_height = image.size
        if source_width < 32 or source_height < 32:
            raise ValueError("image dimensions are too small")

        tensor = self._transform(image).unsqueeze(0)
        with self._lock, self._torch.inference_mode():
            features = self._model(tensor)[0]
            # 正式版的正規化做在模型裡，這裡在外面補上，確保輸出契約一致：
            # 下游用內積就等於 cosine similarity。
            normalized = self._torch.nn.functional.normalize(features, p=2, dim=0)

        embedding = [float(value) for value in normalized.cpu().tolist()]
        if len(embedding) != self.embedding_dim or not all(math.isfinite(value) for value in embedding):
            raise RuntimeError("model returned an invalid embedding")
        norm = math.sqrt(sum(value * value for value in embedding))
        if not 0.999 <= norm <= 1.001:
            raise RuntimeError("model returned a non-normalized embedding")

        return ShadowEmbeddingResult(
            model_version=self.model_version,
            preprocessing_version=self.preprocessing_version,
            # 存原始 bytes 的雜湊而不是檔名或路徑：可以用來去重與追溯，
            # 又不會把使用者的儲存位置寫進日誌。
            input_sha256=sha256(image_bytes).hexdigest(),
            source_width=source_width,
            source_height=source_height,
            embedding=embedding,
        )
