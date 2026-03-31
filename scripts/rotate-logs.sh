#!/bin/bash
# ログローテーション: 10MB 超えたらローテート、7世代保持
LOG_DIR="/Users/helicoir_pc/root/repos/works/nanoclaw/logs"
MAX_SIZE=$((10 * 1024 * 1024))  # 10MB

rotate() {
  local log="$1"
  [ -f "$log" ] || return
  local size
  size=$(stat -f%z "$log" 2>/dev/null || echo 0)
  if [ "$size" -gt "$MAX_SIZE" ]; then
    for i in 6 5 4 3 2 1; do
      [ -f "${log}.${i}" ] && mv "${log}.${i}" "${log}.$((i+1))"
    done
    cp "$log" "${log}.1"
    : > "$log"
    echo "$(date): rotated $log (was ${size} bytes)"
  fi
}

rotate "$LOG_DIR/nanoclaw.log"
rotate "$LOG_DIR/nanoclaw.error.log"

# 7世代超えを削除
find "$LOG_DIR" -name "*.log.[89]" -o -name "*.log.10" | xargs rm -f 2>/dev/null
