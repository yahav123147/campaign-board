#!/bin/bash
# Campaign Council: התקנה מלאה + בדיקת בריאות. מריצים מתוך תיקיית הפרויקט.
set -euo pipefail

echo "== Campaign Council setup =="

if [[ "$(uname)" != "Darwin" ]]; then
  echo "אזהרה: הזרימה המלאה (שלב 5, שלב 8) נתמכת ב-macOS בלבד."
fi

command -v node >/dev/null || { echo "חסר Node.js 20.9+. התקינו מ-nodejs.org ואז הריצו שוב."; exit 1; }
command -v python3 >/dev/null || { echo "חסר Python 3.10+."; exit 1; }
# A stock Mac ships python3 3.9.6, and the pinned numpy needs 3.10+: without
# this gate the install got past every check and died inside pip.
PY_VERSION="$(python3 --version 2>&1 | awk '{print $2}')"
PY_MAJOR="${PY_VERSION%%.*}"
PY_MINOR="$(printf '%s' "$PY_VERSION" | cut -d. -f2)"
if [[ -z "$PY_MAJOR" || -z "$PY_MINOR" ]] || (( PY_MAJOR < 3 || (PY_MAJOR == 3 && PY_MINOR < 10) )); then
  echo "נדרש Python 3.10 ומעלה, ונמצא Python ${PY_VERSION:-לא ידוע} (python3 ב-PATH)."
  echo "התקינו מ-python.org או דרך brew install python@3.12, פתחו טרמינל חדש והריצו שוב."
  exit 1
fi
command -v claude >/dev/null || { echo "חסר Claude Code CLI. התקינו והריצו: claude auth login (מנוי MAX)."; exit 1; }

echo "-- מתקין תלויות Node..."
npm ci

echo "-- מתקין Chromium ל-Playwright..."
npx playwright install chromium

echo "-- מקים סביבת Python לכלי התמונות..."
python3 -m venv "$HOME/.campaign-council-venv"
# shellcheck disable=SC1091
source "$HOME/.campaign-council-venv/bin/activate"
python3 -m pip install --quiet --upgrade pip
python3 -m pip install --quiet -r requirements-image-core.txt

if [[ ! -f .env.local ]]; then
  cp .env.example .env.local
  echo "-- נוצר .env.local מהתבנית. ערכו אותו לפי ה-README."
fi

CONFIG_DIR="$HOME/.config/campaign-council"
mkdir -p "$CONFIG_DIR"
for f in copy-standard ads-standard creative-standard; do
  if [[ ! -f "$CONFIG_DIR/$f.md" ]]; then
    cp "config/standards/$f.default.md" "$CONFIG_DIR/$f.md"
    echo "-- הותקן תקן ברירת מחדל: $CONFIG_DIR/$f.md"
  fi
done
if [[ ! -f "$CONFIG_DIR/client-profile.json" ]]; then
  cp config/client-profile.example.json "$CONFIG_DIR/client-profile.json"
  chmod 600 "$CONFIG_DIR/client-profile.json"
  echo "-- נוצר פרופיל לקוח לדוגמה: $CONFIG_DIR/client-profile.json. מלאו אותו לפי ה-README."
fi

mkdir -p "$CONFIG_DIR/page-types"
for f in premium-lead-page webinar-page squeeze-page upsell-page; do
  if [[ ! -f "$CONFIG_DIR/page-types/$f.md" ]]; then
    cp "config/standards/page-types/$f.default.md" "$CONFIG_DIR/page-types/$f.md"
    echo "-- הותקנה תבנית סוג דף: $CONFIG_DIR/page-types/$f.md"
  fi
done

echo ""
echo "== בדיקת בריאות =="
npm run doctor || true

echo ""
echo "הצעדים הבאים: ערכו את $CONFIG_DIR/client-profile.json ואת .env.local (כולל CAMPAIGN_COUNCIL_CLIENT_PROFILE=$CONFIG_DIR/client-profile.json), התקינו את סקיל העיצוב לפי vendor/landing-skill/INSTALL.md אם שלב 5 פעיל, ואז: npm run dev"
