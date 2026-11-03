import argparse
from pathlib import Path
from ultralytics import YOLO

parser = argparse.ArgumentParser()
parser.add_argument("--data", required=True, help="Path to exported data.yaml")
parser.add_argument("--epochs", type=int, default=70)
parser.add_argument("--model", default=str(Path(__file__).resolve().parents[1] / "models" / "yolo26n.pt"))
args = parser.parse_args()

data = Path(args.data).resolve()
if not data.is_file():
    parser.error(f"Dataset configuration not found: {data}")

model = YOLO(args.model)
results = model.train(
    data=str(data),
    epochs=args.epochs,
    imgsz=640,
    project="checkout_yolo_runs",
    name="products",
    exist_ok=False,
    plots=True,
)

best = Path(results.save_dir) / "weights" / "best.pt"
if not best.is_file():
    raise RuntimeError(f"Training ended without a best checkpoint: {best}")

print(f"Best model: {best}")

trained = YOLO(str(best))
trained.val(data=str(data), split="test", imgsz=640, plots=True)
print("Test-set evaluation complete. Inspect per-class results and sample predictions.")
