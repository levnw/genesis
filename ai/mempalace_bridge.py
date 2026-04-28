"""
MemPalace HTTP bridge — wraps MemPalace as two simple HTTP endpoints.
Run alongside genesis ai/ service: python mempalace_bridge.py
"""
import os
import json
from flask import Flask, request, jsonify

try:
    import mempalace
    MEMPALACE_AVAILABLE = True
except ImportError:
    MEMPALACE_AVAILABLE = False
    print("[bridge] WARNING: mempalace not installed. Install with: pip install mempalace")

app = Flask(__name__)
PORT = int(os.environ.get("MEMPALACE_PORT", 8765))

# Simple in-memory fallback when mempalace is not installed
_memory_store = []

@app.route("/health")
def health():
    return jsonify({"ok": True, "mempalace": MEMPALACE_AVAILABLE})

@app.route("/search", methods=["POST"])
def search():
    data  = request.get_json() or {}
    query = data.get("query", "")
    limit = int(data.get("limit", 5))

    if not query:
        return jsonify({"results": []})

    if MEMPALACE_AVAILABLE:
        try:
            results = mempalace.search(query, limit=limit)
            return jsonify({"results": results})
        except Exception as e:
            print(f"[bridge] mempalace search error: {e}")

    # Fallback: simple substring search over in-memory store
    results = [
        {"text": m, "score": 1.0}
        for m in _memory_store
        if query.lower() in m.lower()
    ][:limit]
    return jsonify({"results": results})

@app.route("/store", methods=["POST"])
def store():
    data = request.get_json() or {}
    text = data.get("text", "")

    if not text:
        return jsonify({"ok": False, "error": "text is required"})

    if MEMPALACE_AVAILABLE:
        try:
            mempalace.store(text)
            return jsonify({"ok": True})
        except Exception as e:
            print(f"[bridge] mempalace store error: {e}")

    # Fallback: in-memory store (not persistent)
    _memory_store.append(text)
    if len(_memory_store) > 500:
        _memory_store.pop(0)
    return jsonify({"ok": True, "fallback": True})

if __name__ == "__main__":
    print(f"[bridge] MemPalace bridge on port {PORT} (mempalace={'available' if MEMPALACE_AVAILABLE else 'NOT installed — using fallback'})")
    app.run(port=PORT, debug=False)
