# "איך מכינים Windows להתקנת הבורד"

**מעמד התמיכה:** Windows נתמך דרך Ubuntu 24.04 בתוך WSL2 בלבד, והמסלול עבר קבלה מלאה (ראו [טבלת התמיכה](platform-support.md)). אין להריץ את הפרויקט ישירות ב-PowerShell, ב-CMD או ב-Git Bash: שם ההתקנה עוצרת בכוונה.

**שני תנאים שההתקנה לא יכולה לבדוק בשבילכם:** Claude Code חייב להיות מותקן ומחובר **בתוך Ubuntu**, ובחשבון עם מנוי **MAX**. מנוי Pro אינו מספיק לריצת הסוכנים של הבורד.

WSL2 מאפשר להריץ סביבת Linux בתוך Windows. הבורד והכלים ירוצו בתוך Ubuntu, ואת הממשק תפתחו בדפדפן הרגיל של Windows.

## 1. מתקינים WSL2

נדרש Windows 11, או Windows 10 בגרסה שתומכת ב-WSL2. פתחו PowerShell באמצעות **Run as administrator**:

```powershell
wsl --install -d Ubuntu-24.04
```

הפעולה עשויה לדרוש הפעלה מחדש. אחרי ההפעלה פתחו את Ubuntu מתפריט Start, ובחרו שם משתמש וסיסמה ל-Linux. בהקלדת סיסמה ב-Terminal התווים אינם מוצגים.

בדקו ב-PowerShell:

```powershell
wsl --list --verbose
```

בעמודת VERSION ליד Ubuntu צריך להופיע `2`. התקנת WSL ושדרוגו מפורטים אצל [Microsoft](https://learn.microsoft.com/en-us/windows/wsl/install).

## 2. עובדים בתוך Ubuntu

מכאן כל הפקודות נכתבות בחלון **Ubuntu**, ולא ב-PowerShell. התקינו את כלי הבסיס:

```bash
sudo apt update
sudo apt install -y git curl python3 python3-venv python3-pip build-essential bubblewrap socat
```

התקינו Node.js 24 בתוך Ubuntu באמצעות [nvm](https://github.com/nvm-sh/nvm#installing-and-updating). התקנת Node ב-Windows אינה מחליפה התקנה בתוך Ubuntu:

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh | bash
source ~/.bashrc
nvm install 24
nvm alias default 24
```

בדקו:

```bash
node --version
node -p 'process.platform'
python3 --version
```

הגרסה צריכה להיות `v24...` והפלט של הפקודה השנייה צריך להיות `linux`.

התקינו והתחברו ל-Claude בתוך Ubuntu:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

פתחו מחדש את Ubuntu, ואז:

```bash
claude auth login
claude --version
```

השתמשו בחשבון שלכם עם מנוי MAX. [Claude תומך בבידוד פקודות ב-WSL2](https://code.claude.com/docs/en/setup#setup-on-windows); התמיכה הזו אינה מחליפה את בדיקות הבידוד של הבורד עצמו.

## 3. שומרים את הפרויקט במערכת הקבצים של Linux

```bash
mkdir -p ~/projects
cd ~/projects
```

שכפלו לכאן את הריפו באמצעות כתובת ה-clone שבתפריט **Code** ב-GitHub. בריפו פרטי צריך להתחבר לחשבון GitHub בעל הגישה. אפשר להשתמש ב-GitHub CLI מתוך Ubuntu:

```bash
sudo apt install -y gh
gh auth login
```

לאחר ההתחברות, הזינו את קישור הריפו שקיבלתם:

```bash
read -r -p 'GitHub repository URL: ' CLIENT_REPO_URL
gh repo clone "$CLIENT_REPO_URL" campaign-board
cd campaign-board
```

הפרויקט, הנתונים ופרויקט הדפים צריכים להישאר תחת תיקיית Linux, למשל `~/projects`. אל תשתמשו ב-`/mnt/c`, ב-OneDrive או ב-Node/Chrome של Windows עבור התהליכים של הבורד. כך גם ממליצה [Microsoft לעבודה עם קבצים ב-WSL](https://learn.microsoft.com/en-us/windows/wsl/filesystems).

## 4. מתקינים את הבורד

```bash
./setup.sh
npm run doctor
```

ההתקנה מוסיפה גם את bubblewrap ואת תלויות המערכת של הדפדפן ב-Linux, ולכן ייתכן שתבקש סיסמת sudo. אשף ההגדרה יוצר פרופיל ותיקיית נתונים נפרדים ופרויקט דפים התחלתי. כדי לאפשר בניית דפים, הריצו את האשף עם `--enable-landing` (למשל `./setup.sh --enable-landing`).

ה-doctor מריץ בדיקה אמיתית בתוך ארגז החול ומדפיס `[PASS] Stage 5 sandbox (bubblewrap)`. אם הוא מדווח על כישלון בבידוד, עצרו. אין להסיר את מנגנון הבידוד כדי לעקוף את ההודעה.

## 4א. סודות (אופציונלי)

טוקן Meta ומפתחות אופציונליים נשמרים ב-Windows Credential Manager ונקראים מתוך WSL2. שומרים אותם ב-PowerShell של Windows, ואז ממשיכים בתוך Ubuntu:

```powershell
cmdkey /generic:<שם-השירות-מהפרופיל> /user:council /pass
```

שם השירות הוא הערך שבפרופיל הלקוח (למשל `meta.tokenKeychainService`). ה-doctor בודק שהפריט קיים בלי להדפיס אותו.

## 5. מפעילים מתוך Ubuntu

```bash
npm run dev
```

פתחו בדפדפן Windows את הכתובת שמודפסת, בדרך כלל `http://127.0.0.1:3000`. הגישה באמצעות localhost מתועדת אצל [Microsoft](https://learn.microsoft.com/en-us/windows/wsl/networking).

שמרו את חלון Ubuntu פתוח בזמן הריצה. התצוגה המקדימה של דף שנבנה נפתחת מעצמה בדפדפן של Windows. אחרי בדיקת ההפעלה יש לבצע [ריצה ראשונה](first-run.md).
