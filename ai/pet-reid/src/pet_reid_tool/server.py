"""Re-ID 向量服務——公開展示版。

與正式版的差異只有一處：正式版還掛了一個「畫面裡到底有沒有狗」的前置判斷端點
（`/v1/dog-presence`），那個模型沒有公開，所以這裡整段拿掉。Re-ID 端點本身的
驗證、限制與回應格式完全相同。

為什麼用標準函式庫的 HTTPServer 而不是 FastAPI：
  這個服務只有兩條路由、跑在 Cloud Run 上、輸入是單一張圖片。多一個 web 框架
  就多一份相依與一份攻擊面，換來的便利在這個規模用不到。
"""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from typing import Any

from .inference import MAX_IMAGE_BYTES, PetReIdShadowRuntime, authorized


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def create_handler(runtime: PetReIdShadowRuntime, service_token: str) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "SmartPetLifePetReId/0.1"

        def _respond(self, status: int, value: Any) -> None:
            body = _json_bytes(value)
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            # 健康檢查不需要權杖，但也因此不能洩漏任何有價值的東西，
            # 只回報版本與「這是 shadow 路徑」的事實。
            if self.path != "/health":
                self._respond(404, {"error": "not_found"})
                return
            self._respond(
                200,
                {
                    "status": "ok",
                    "model_version": runtime.model_version,
                    "preprocessing_version": runtime.preprocessing_version,
                    "shadow_only": True,
                },
            )

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/v1/pet-reid/embedding":
                self._respond(404, {"error": "not_found"})
                return
            if not authorized(self.headers.get("X-Service-Token"), service_token):
                self._respond(401, {"error": "unauthorized"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self._respond(400, {"error": "invalid_content_length"})
                return
            # 先看 Content-Length 再決定要不要讀 body，避免把超大請求整個吃進記憶體。
            if length <= 0 or length > MAX_IMAGE_BYTES:
                self._respond(413, {"error": "image_size_not_supported"})
                return

            body = self.rfile.read(length)
            try:
                result = runtime.embed(body, self.headers.get_content_type())
            except ValueError as error:
                # 輸入問題回 400，並把訊息轉成穩定的錯誤代碼形式，方便呼叫端分辨。
                self._respond(400, {"error": str(error).replace(" ", "_")})
                return
            except Exception:
                # 其他例外一律回一個不帶細節的 500：堆疊內容可能包含檔案路徑。
                self._respond(500, {"error": "inference_failed"})
                return
            self._respond(200, result.as_response())

        def log_message(self, format: str, *args: Any) -> None:
            # 日誌裡不可以出現物件路徑、簽名網址、請求內容或任何可直接識別的資料。
            print(json.dumps({"event": "pet_reid_http", "message": format % args}))

    return Handler


def main() -> None:
    service_token = os.environ.get("PET_REID_SERVICE_TOKEN", "")
    # 長度下限寫死在程式裡，讓部署時忘記設或設成弱權杖會直接啟動失敗，
    # 而不是帶著一個形同虛設的驗證上線。
    if len(service_token) < 32:
        raise RuntimeError("PET_REID_SERVICE_TOKEN must contain at least 32 characters")

    runtime = PetReIdShadowRuntime()
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), create_handler(runtime, service_token))
    print(
        json.dumps(
            {
                "event": "pet_reid_ready",
                "port": port,
                "model_version": runtime.model_version,
                "preprocessing_version": runtime.preprocessing_version,
                "shadow_only": True,
            }
        )
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
