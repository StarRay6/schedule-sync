#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then
  exec python3 server.py "$@"
else
  echo "没有检测到 python3，请先安装 Python 3。"
  read -r -p "按回车退出…"
fi
