"""
Two-stage encoder inference server.
Listens on localhost:8765, accepts POST /classify with {"text": "..."}
Returns {"label": "FEEL", "confidence": 0.92, "stage": "s1"}
"""
import os, json, sys
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

import torch
import numpy as np
from transformers import AutoTokenizer, AutoModelForSequenceClassification
from http.server import HTTPServer, BaseHTTPRequestHandler

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "two-stage-output")
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

print(f"Loading models on {device}...")
tokenizer = AutoTokenizer.from_pretrained(f"{MODEL_DIR}/tokenizer/")
model_s1 = AutoModelForSequenceClassification.from_pretrained(f"{MODEL_DIR}/Stage_1_FEEL_vs_NON-FEEL")
model_s1.to(device).eval()
model_s2 = AutoModelForSequenceClassification.from_pretrained(f"{MODEL_DIR}/Stage_2_WHAT_WHERE_WHO")
model_s2.to(device).eval()
S2_MAP = {0: "WHAT", 1: "WHERE", 2: "WHO"}
print("Models ready.")

def classify(text):
    tokens = tokenizer(text, truncation=True, max_length=128, padding="max_length", return_tensors="pt")
    input_ids = tokens["input_ids"].to(device)
    attention_mask = tokens["attention_mask"].to(device)

    with torch.no_grad():
        # Stage 1: FEEL vs NON-FEEL
        s1_out = model_s1(input_ids, attention_mask=attention_mask)
        s1_probs = torch.softmax(s1_out.logits, dim=1)[0]
        feel_conf = s1_probs[1].item()

        if feel_conf > 0.5:
            return {"label": "FEEL", "confidence": round(feel_conf, 4), "stage": "s1"}

        # Stage 2: WHAT / WHERE / WHO
        s2_out = model_s2(input_ids, attention_mask=attention_mask)
        s2_probs = torch.softmax(s2_out.logits, dim=1)[0]
        s2_pred = torch.argmax(s2_out.logits, dim=1)[0].item()
        s2_conf = s2_probs[s2_pred].item()

        return {
            "label": S2_MAP[s2_pred],
            "confidence": round(s2_conf, 4),
            "stage": "s2",
            "probs": {S2_MAP[i]: round(s2_probs[i].item(), 4) for i in range(3)}
        }

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/classify":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            text = body.get("text", "")
            result = classify(text)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result, ensure_ascii=False).encode())
        elif self.path == "/batch":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            texts = body.get("texts", [])
            results = [classify(t) for t in texts]
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(results, ensure_ascii=False).encode())
        elif self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")

    def log_message(self, format, *args):
        pass  # Silence HTTP logs

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"Encoder server on http://127.0.0.1:{port}")
    server.serve_forever()
