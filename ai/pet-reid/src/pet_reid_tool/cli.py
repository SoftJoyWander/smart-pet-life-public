"""資料集準備與分割模型訓練的命令列入口——公開展示版。

正式版還有兩個子指令沒有放進來：
  train      — Re-ID 基準模型的訓練流程，含取樣策略與損失設定，是訓練配方本身。
  field-eval — 用實地蒐集的照片量測 Top-K 與開集誤接受率，屬於私有評測流程。

保留下來的三個子指令處理的都是公開資料集（Oxford-IIIT Pet、MPDD），任何人用
同樣的指令都能重現同樣的 release 與同樣的雜湊。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .mpdd import build_mpdd_release
from .oxford import build_oxford_release
from .preprocess import derive_mpdd_preprocessing_release
from .segmentation import train_oxford_segmentation


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        description="Prepare auditable public-dataset releases for the Smart Pet Life dog Re-ID work"
    )
    commands = root.add_subparsers(dest="command", required=True)

    # 把資料集「凍結」成一份帶雜湊的清單，之後任何評測數字都能指回確切的那一批檔案。
    prepare = commands.add_parser("prepare", help="Audit MPDD and freeze a manifest release")
    prepare.add_argument("--source-root", type=Path, required=True)
    prepare.add_argument("--output", type=Path, required=True)
    prepare.add_argument("--config", type=Path, required=True)

    oxford_prepare = commands.add_parser(
        "oxford-prepare", help="Download, audit, and freeze Oxford-IIIT Pet segmentation data"
    )
    oxford_prepare.add_argument("--data-root", type=Path, default=Path("data"))
    oxford_prepare.add_argument("--output", type=Path, required=True)
    oxford_prepare.add_argument(
        "--config", type=Path, default=Path("configs/oxford_pet_segmentation_v1.json")
    )
    oxford_prepare.add_argument("--download", action="store_true")

    oxford_train = commands.add_parser(
        "oxford-train", help="Train and evaluate the Oxford pet foreground model"
    )
    oxford_train.add_argument("--data-root", type=Path, default=Path("data"))
    oxford_train.add_argument("--release-root", type=Path, required=True)
    oxford_train.add_argument("--output", type=Path, required=True)
    oxford_train.add_argument(
        "--config", type=Path, default=Path("configs/oxford_pet_segmentation_v1.json")
    )
    oxford_train.add_argument("--cache-root", type=Path, default=Path(".cache/torch"))

    # 用分割模型把背景中性化，降低「同一個院子」這種環境線索被模型當成身分特徵的機會。
    derive = commands.add_parser(
        "derive-mpdd", help="Create bbox and neutral-background MPDD releases"
    )
    derive.add_argument("--mpdd-source-root", type=Path, required=True)
    derive.add_argument("--mpdd-release-root", type=Path, required=True)
    derive.add_argument("--mpdd-config", type=Path, required=True)
    derive.add_argument("--segmentation-checkpoint", type=Path, required=True)
    derive.add_argument("--segmentation-model-card", type=Path, required=True)
    derive.add_argument(
        "--segmentation-config", type=Path, default=Path("configs/oxford_pet_segmentation_v1.json")
    )
    derive.add_argument("--output", type=Path, required=True)
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.command == "prepare":
        result = build_mpdd_release(
            args.source_root.resolve(), args.output.resolve(), args.config.resolve()
        )
    elif args.command == "oxford-prepare":
        result = build_oxford_release(
            args.data_root.resolve(),
            args.output.resolve(),
            args.config.resolve(),
            download=args.download,
        )
    elif args.command == "oxford-train":
        result = train_oxford_segmentation(
            args.data_root.resolve(),
            args.release_root.resolve(),
            args.config.resolve(),
            args.output.resolve(),
            args.cache_root.resolve(),
        )
    else:
        result = derive_mpdd_preprocessing_release(
            args.mpdd_source_root.resolve(),
            args.mpdd_release_root.resolve(),
            args.mpdd_config.resolve(),
            args.segmentation_checkpoint.resolve(),
            args.segmentation_model_card.resolve(),
            args.segmentation_config.resolve(),
            args.output.resolve(),
        )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
