import dotenv
import os
from roboflow import Roboflow

dotenv.load_dotenv()


rf = Roboflow(api_key=os.getenv('ROBOFLOW_KEY'))
project = rf.workspace("luthfi-random-s-workspace").project(
    "self-checkout-yolo-products"
)
dataset = project.version(1).download("yolov11")
print(f"Dataset: {dataset.location}")
print(f"Training configuration: {dataset.location}/data.yaml")

