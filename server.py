#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
日程同步 · 局域网服务端
只用 Python 标准库，不需要安装任何依赖。

用法：
    python3 server.py             # 默认端口 8765
    python3 server.py -p 9000     # 指定端口

启动后，同一 Wi-Fi 下的手机浏览器访问控制台打印的「手机访问」地址即可。
"""

import argparse
import json
import os
import queue
import socket
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = BASE_DIR
DATA_DIR = os.path.join(BASE_DIR, "data")
DATA_FILE = os.path.join(DATA_DIR, "data.json")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
MAX_BODY = 2 * 1024 * 1024  # 2MB

EVENT_KEYS = ("id", "kind", "title", "date", "start", "end", "allDay", "color",
              "remind", "note", "done", "deleted", "updatedAt")
TODO_KEYS = ("id", "kind", "title", "due", "priority", "done", "note",
             "deleted", "updatedAt")


def now_ms() -> int:
    return int(time.time() * 1000)


def empty_doc() -> dict:
    return {"rev": 0, "updatedAt": now_ms(), "items": []}


class Store:
    """数据仓库：内存文档 + 落盘 + SSE 广播"""

    def __init__(self, path: str):
        self.path = path
        self.lock = threading.RLock()
        self.clients = []
        self.doc = self._load()
        if not os.path.exists(self.path):
            self._save()
        self._daily_backup_if_needed()

    # ---------- 读写 ----------
    def _load(self) -> dict:
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                doc = json.load(fh)
            if not isinstance(doc, dict) or not isinstance(doc.get("items"), list):
                raise ValueError("bad data file")
            doc.setdefault("rev", 0)
            return doc
        except FileNotFoundError:
            return empty_doc()
        except Exception as exc:  # 损坏的文件先留档，避免直接覆盖丢数据
            try:
                os.makedirs(DATA_DIR, exist_ok=True)
                bad = self.path + ".broken-" + time.strftime("%Y%m%d-%H%M%S")
                os.replace(self.path, bad)
                print(f"[警告] 数据文件损坏，已另存为 {bad}（{exc}）")
            except Exception:
                pass
            return empty_doc()

    def _save(self) -> None:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self.doc, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, self.path)

    def _daily_backup_if_needed(self) -> None:
        """每天第一次写入前，把前一天的数据存一份快照，保留最近 30 天"""
        try:
            if not os.path.exists(self.path):
                return
            os.makedirs(BACKUP_DIR, exist_ok=True)
            name = "backup-" + time.strftime("%Y-%m-%d") + ".json"
            dst = os.path.join(BACKUP_DIR, name)
            if not os.path.exists(dst):
                with open(self.path, "r", encoding="utf-8") as src, open(dst, "w", encoding="utf-8") as out:
                    out.write(src.read())
            files = sorted(f for f in os.listdir(BACKUP_DIR) if f.startswith("backup-") and f.endswith(".json"))
            for old in files[:-30]:
                try:
                    os.remove(os.path.join(BACKUP_DIR, old))
                except OSError:
                    pass
        except Exception:
            pass

    # ---------- 查询 ----------
    def snapshot(self) -> dict:
        with self.lock:
            return {"rev": self.doc.get("rev", 0),
                    "updatedAt": self.doc.get("updatedAt", 0),
                    "serverTime": now_ms(),
                    "items": list(self.doc["items"])}

    # ---------- 合并写入 ----------
    def patch(self, incoming: list) -> dict:
        with self.lock:
            index = {it.get("id"): it for it in self.doc["items"] if isinstance(it, dict) and it.get("id")}
            changed = False
            accepted = 0
            for raw in incoming:
                if not isinstance(raw, dict):
                    continue
                item = self._clean(raw)
                if not item:
                    continue
                cur = index.get(item["id"])
                if cur is None or (item.get("updatedAt") or 0) >= (cur.get("updatedAt") or 0):
                    index[item["id"]] = item
                    accepted += 1
                    changed = True
            if changed:
                self._daily_backup_if_needed()
                self.doc["items"] = list(index.values())
                self.doc["rev"] = int(self.doc.get("rev", 0)) + 1
                self.doc["updatedAt"] = now_ms()
                self._save()
                self.broadcast(self.doc["rev"])
            return {"rev": self.doc.get("rev", 0), "accepted": accepted, "total": len(self.doc["items"])}

    @staticmethod
    def _clean(raw: dict):
        kind = raw.get("kind")
        if kind not in ("event", "todo"):
            return None
        iid = raw.get("id")
        if not isinstance(iid, str) or not iid or len(iid) > 64:
            return None
        keys = EVENT_KEYS if kind == "event" else TODO_KEYS
        out = {}
        for k in keys:
            if k in raw:
                out[k] = raw[k]
        out["id"] = iid
        out["kind"] = kind
        out["title"] = str(out.get("title", "") or "")[:120]
        out["note"] = str(out.get("note", "") or "")[:2000]
        out["updatedAt"] = int(out.get("updatedAt") or now_ms())
        out["deleted"] = bool(out.get("deleted"))
        if kind == "event":
            out["date"] = str(out.get("date", "") or "")[:10]
            out["start"] = str(out.get("start", "") or "")[:5]
            out["end"] = str(out.get("end", "") or "")[:5]
            out["color"] = str(out.get("color", "work") or "work")[:16]
            out["allDay"] = bool(out.get("allDay"))
            remind = out.get("remind")
            out["remind"] = "" if remind in ("", None) else max(0, min(10080, int(remind)))
            out["done"] = bool(out.get("done"))
        else:
            out["due"] = str(out.get("due", "") or "")[:10]
            try:
                out["priority"] = max(1, min(3, int(out.get("priority") or 2)))
            except (TypeError, ValueError):
                out["priority"] = 2
            out["done"] = bool(out.get("done"))
        if not out["title"] and not out["deleted"]:
            return None
        return out

    # ---------- SSE 客户端 ----------
    def add_client(self, q: queue.Queue) -> None:
        with self.lock:
            self.clients.append(q)

    def remove_client(self, q: queue.Queue) -> None:
        with self.lock:
            if q in self.clients:
                self.clients.remove(q)

    def broadcast(self, rev) -> None:
        with self.lock:
            clients = list(self.clients)
        for q in clients:
            try:
                q.put_nowait(rev)
            except queue.Full:
                pass


STORE = None  # type: Store
PORT = 8765


def local_ipv4_list():
    ips = set()
    try:
        host = socket.gethostname()
        for info in socket.getaddrinfo(host, None, socket.AF_INET):
            ips.add(info[4][0])
    except Exception:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("223.5.5.5", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127.") and not ip.startswith("169.254."))


class Handler(SimpleHTTPRequestHandler):
    server_version = "ScheduleSync/1.0"
    protocol_version = "HTTP/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    # ---------- 工具 ----------
    def _json(self, obj, status=200, cache=False):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store" if not cache else "no-cache")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length <= 0 or length > MAX_BODY:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def log_message(self, fmt, *args):
        # 只在出错时打日志，避免刷屏
        if args and str(args[1])[:1] in ("4", "5"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---------- 路由 ----------
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/info":
            return self._api_info()
        if path == "/api/data":
            return self._json(STORE.snapshot())
        if path == "/api/stream":
            return self._api_stream()
        if path.startswith("/api/"):
            return self._json({"error": "not found"}, 404)
        if path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/patch":
            data = self._read_body()
            if not isinstance(data, dict) or not isinstance(data.get("items"), list):
                return self._json({"error": "bad request"}, 400)
            return self._json(STORE.patch(data["items"]))
        return self._json({"error": "not found"}, 404)

    def _api_info(self):
        ips = local_ipv4_list()
        urls = [f"http://{ip}:{PORT}" for ip in ips]
        return self._json({
            "app": "schedule-sync",
            "port": PORT,
            "urls": urls,
            "local": f"http://localhost:{PORT}",
            "serverTime": now_ms(),
            "dataFile": DATA_FILE,
            "rev": STORE.snapshot()["rev"],
        })

    def _api_stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        q = queue.Queue(maxsize=64)
        STORE.add_client(q)
        try:
            hello = json.dumps({"rev": STORE.snapshot()["rev"], "hello": True}).encode("utf-8")
            self.wfile.write(b"data: " + hello + b"\n\n")
            self.wfile.flush()
            while True:
                try:
                    rev = q.get(timeout=25)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                payload = json.dumps({"rev": rev}).encode("utf-8")
                self.wfile.write(b"data: " + payload + b"\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            STORE.remove_client(q)

    # 静态文件缓存策略
    def end_headers(self):
        if self.path.split("?")[0].startswith(("/api/",)):
            pass
        elif self.path.endswith((".js", ".css", ".html")) or self.path == "/":
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def find_free_port(start: int, tries: int = 12) -> int:
    for p in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("0.0.0.0", p))
                return p
            except OSError:
                continue
    raise SystemExit(f"端口 {start}-{start + tries - 1} 都被占用，请用 -p 指定其他端口")


def main():
    global STORE, PORT
    ap = argparse.ArgumentParser(description="日程同步 · 局域网服务端")
    ap.add_argument("-p", "--port", type=int, default=8765, help="监听端口（默认 8765）")
    ap.add_argument("--host", default="0.0.0.0", help="监听地址（默认 0.0.0.0）")
    args = ap.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    PORT = find_free_port(args.port)
    STORE = Store(DATA_FILE)

    httpd = ThreadingHTTPServer((args.host, PORT), Handler)
    httpd.daemon_threads = True

    print("=" * 56)
    print("  日程同步服务已启动")
    print("=" * 56)
    print(f"  电脑访问:  http://localhost:{PORT}")
    for ip in local_ipv4_list():
        print(f"  手机访问:  http://{ip}:{PORT}   （手机连同一个 Wi-Fi）")
    print(f"  数据文件:  {DATA_FILE}")
    print(f"  当前数据:  {len(STORE.snapshot()['items'])} 条记录，版本 {STORE.snapshot()['rev']}")
    print("  停止服务:  Ctrl + C")
    print("=" * 56)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
