#!/bin/bash
# NanoClaw 日次バックアップ
set -euo pipefail

PROJECT_DIR="/Users/helicoir_pc/root/repos/works/nanoclaw"
BACKUP_BASE="$HOME/Backups/nanoclaw"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="$BACKUP_BASE/$DATE"

mkdir -p "$BACKUP_DIR"

# SQLite DB
[ -d "$PROJECT_DIR/store" ] && cp -r "$PROJECT_DIR/store" "$BACKUP_DIR/store" 2>/dev/null || true

# グループメモリ (CLAUDE.md)
[ -d "$PROJECT_DIR/groups" ] && cp -r "$PROJECT_DIR/groups" "$BACKUP_DIR/groups" 2>/dev/null || true

# セッションデータ
[ -d "$PROJECT_DIR/data/sessions" ] && cp -r "$PROJECT_DIR/data/sessions" "$BACKUP_DIR/sessions" 2>/dev/null || true

# .env (Discord token 等)
[ -f "$PROJECT_DIR/.env" ] && cp "$PROJECT_DIR/.env" "$BACKUP_DIR/.env" 2>/dev/null || true

echo "$(date): backup completed → $BACKUP_DIR"

# 7日以上前のバックアップを削除
find "$BACKUP_BASE" -maxdepth 1 -mindepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true
echo "$(date): old backups cleaned"
