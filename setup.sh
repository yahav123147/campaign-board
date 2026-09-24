#!/bin/bash
# Campaign Council: התקנה מלאה + בדיקת בריאות. מריצים מתוך תיקיית הפרויקט.
set -euo pipefail

echo "== Campaign Council setup =="

command -v node >/dev/null || { echo "חסר Node.js 20.9+. התקינו מ-nodejs.org ואז הריצו שוב."; exit 1; }
command -v npm >/dev/null || { echo "חסר npm 9+. התקינו Node.js עם npm ואז הריצו שוב."; exit 1; }
command -v git >/dev/null || { echo "חסר Git ליצירת סביבת דפי הנחיתה."; exit 1; }
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

if [[ "$(uname)" == "Linux" ]]; then
  if grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null && [[ "$PWD" == /mnt/* ]]; then
    echo "ב-WSL2 הפרויקט חייב לשבת בתוך מערכת הקבצים של לינוקס (למשל ~/campaign-board), לא תחת /mnt."
    echo "העתיקו: cp -r \"$PWD\" ~/campaign-board && cd ~/campaign-board && ./setup.sh"
    exit 1
  fi
  # bubblewrap is the sandbox for page builds; webp brings cwebp, the image
  # converter macOS ships as sips. Each is installed only when missing, so a
  # host that already has one still gets the other.
  LINUX_MISSING=()
  command -v bwrap >/dev/null || LINUX_MISSING+=(bubblewrap)
  command -v cwebp >/dev/null || LINUX_MISSING+=(webp)
  if (( ${#LINUX_MISSING[@]} )); then
    if command -v sudo >/dev/null && command -v apt-get >/dev/null; then
      echo "-- מתקין ${LINUX_MISSING[*]} (ארגז החול לבניית דפים, המרת תמונות)..."
      sudo apt-get install -y "${LINUX_MISSING[@]}"
    else
      echo "חסר: ${LINUX_MISSING[*]}. התקינו: sudo apt-get install -y ${LINUX_MISSING[*]} ואז הריצו שוב."
      exit 1
    fi
  fi
fi

echo "-- מתקין תלויות Node..."
npm ci

echo "-- מתקין Chromium ל-Playwright..."
if [[ "$(uname)" == "Linux" ]]; then
  # Installs Chromium system libraries too (Ubuntu/WSL2; may ask for sudo).
  npx playwright install --with-deps chromium
else
  npx playwright install chromium
fi

echo "-- מקים סביבת Python לכלי התמונות..."
python3 -m venv "$HOME/.campaign-council-venv"
# shellcheck disable=SC1091
source "$HOME/.campaign-council-venv/bin/activate"
python3 -m pip install --quiet --upgrade pip
python3 -m pip install --quiet -r requirements-image-core.txt

if [[ -e .env.local || -L .env.local ]]; then
  echo "-- .env.local קיים; ההגדרות והפרופיל הקיימים נשמרו."
else
  echo "-- הגדרת לקוח וסביבת דפי נחיתה פרטית..."
  node scripts/configure-client.mjs "$@"
fi

echo ""
echo "== בדיקת בריאות =="
if ! npm run doctor; then
  echo "ההתקנה הסתיימה, אך המערכת עדיין אינה מוכנה לריצה. השלימו את ההגדרות והחסימות בדוח והריצו npm run doctor שוב."
fi

echo ""
echo "השלימו את החסימות בדוח doctor, ואז: npm run dev. הפרופיל והתיקיות המדויקות הוצגו בתהליך ההגדרה."
