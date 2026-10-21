"""Launch the isolated UI verification server; never runs a background worker."""
import argparse
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
parser = argparse.ArgumentParser()
parser.add_argument("--environment", type=Path, required=True)
parser.add_argument("--web-dist", type=Path, required=True)
parser.add_argument("--port", type=int, default=38118)
args = parser.parse_args()
os.environ.update(json.loads(args.environment.read_text(encoding="utf-8")))
os.environ["LLMR_WEB_PORT"] = str(args.port)
from apps.api.app import main
from starlette.staticfiles import StaticFiles
import uvicorn
main.WEB_DIST = args.web_dist.resolve()
for route in main.app.routes:
    if getattr(route, "name", "") == "web":
        route.app = StaticFiles(directory=main.WEB_DIST, html=True)
uvicorn.run(main.app, host="127.0.0.1", port=args.port, log_level="warning")
