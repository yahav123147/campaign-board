# התקנת סקיל העיצוב בריפו דפי הנחיתה

שלב 5 של הבורד בונה דפי Next.js בתוך repository דפי נחיתה של הלקוח, ושופט אותם לפי סקיל עיצוב ושער QA שיושבים בתוך אותו repository.

התקנה:

```bash
mkdir -p <landing-repo>/.agents/skills/landing-design-agent
cp -R vendor/landing-skill/* <landing-repo>/.agents/skills/landing-design-agent/
```

ואז בפרופיל הלקוח:

```json
"landing": {
  "designStandardPath": ".agents/skills/landing-design-agent/SKILL.md",
  "qaScriptPath": ".agents/skills/landing-design-agent/scripts/landing-qa.mjs"
}
```

הסקיל הוא נקודת פתיחה מלאה (Dark Premium RTL). מומלץ להתאים את הצבעים, הפונטים והכללים למותג של הלקוח, הוא נקרא מהדיסק בכל ריצה, כך ששינוי תופס מיד.
