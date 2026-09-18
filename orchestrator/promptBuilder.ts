import type { ClientProfile } from "@/config/clientProfile";
import type { Agent, Message, RoundNumber } from "@/types";
import { renderClientContext } from "./clientContext";

interface BuildAgentPromptArgs {
  agent: Agent;
  round: RoundNumber;
  brief: string;
  priorMessages: Message[];
  clientProfile?: ClientProfile;
}

const ROUND_GUIDANCE: Record<RoundNumber, string> = {
  1: `סבב 1, עמדה פותחת. אף אחד עוד לא ראה אותך. הצג את העמדה האסטרטגית שלך מהפרספקטיבה של התפקיד שלך, וסיים בהמלצה קונקרטית אחת ליישום. 150-200 מילים.`,
  2: `סבב 2, קונטרות. כעת אתה רואה את כל העמדות מסבב 1. **חובה: התעמת בשם עם לפחות סוכן אחד אחר.** ציטוט ספציפי + ביקורת קונקרטית + הצעה אלטרנטיבית. אסור "אני מסכים עם כולם". 150 מילים.`,
  3: `סבב 3, התכנסות סופית. (א) על מה אתה עומד למרות הביקורת. (ב) על מה אתה מודה ומשנה. (ג) המלצה קונקרטית אחת ליישום. 100-150 מילים.`,
};

export function buildAgentPrompt(args: BuildAgentPromptArgs): string {
  const { agent, round, brief, priorMessages, clientProfile } = args;

  const others = priorMessages.filter(m => m.agentSlug !== agent.slug);
  const transcriptByRound = formatPriorMessages(others, round);

  return [
    agent.systemPrompt,
    "",
    "---",
    "",
    renderClientContext(clientProfile),
    "",
    "---",
    "",
    `## ה-Brief של הקמפיין`,
    "",
    brief,
    "",
    "---",
    "",
    transcriptByRound,
    "",
    "---",
    "",
    `## הוראות לסבב הנוכחי`,
    "",
    ROUND_GUIDANCE[round],
    "",
    "תכתוב **רק** את התגובה שלך לסבב הזה. בלי הקדמות, בלי headers נוספים. רק התוכן.",
  ].join("\n");
}

function formatPriorMessages(messages: Message[], currentRound: RoundNumber): string {
  if (currentRound === 1 || messages.length === 0) {
    return `(זה סבב הפתיחה. אין עדיין עמדות קודמות.)`;
  }

  const sections: string[] = [`## עמדות הסוכנים האחרים`];

  for (let r = 1; r < currentRound; r++) {
    const round = messages.filter(m => m.round === r);
    if (round.length === 0) continue;
    sections.push("", `### סבב ${r}`);
    for (const msg of round) {
      sections.push("", `**${msg.agentSlug}:**`, "", msg.content);
    }
  }

  return sections.join("\n");
}

interface BuildSynthArgs {
  brief: string;
  allMessages: Message[];
  synthesizerPrompt: string;
  clientProfile?: ClientProfile;
  /** The board's copy rulebook. The synthesis writes the big promise, so it is bound by it. */
  copyStandard?: string;
}

export function buildSynthesizerPrompt(args: BuildSynthArgs): string {
  const { brief, allMessages, synthesizerPrompt, clientProfile, copyStandard } = args;
  const sections: string[] = [
    synthesizerPrompt,
    "",
    "---",
    "",
    renderClientContext(clientProfile),
    "",
    "---",
    "",
    "## ה-Brief המקורי",
    "",
    brief,
  ];

  for (let r = 1; r <= 3; r++) {
    const round = allMessages.filter(m => m.round === r);
    if (round.length === 0) continue;
    sections.push("", `## סבב ${r}`);
    for (const msg of round) {
      sections.push("", `### ${msg.agentSlug}`, "", msg.content);
    }
  }

  if (copyStandard?.trim()) {
    sections.push(
      "",
      "---",
      "",
      "## ספר הכללים של הקופי, מנצח את הטעם שלך",
      "",
      "ההבטחה המרכזית שאתה כותב במסמך הזה היא הבטחה של הבית, וחלים עליה כללי הספר הזה במלואם, ובראשם נוסחת ההבטחה הגדולה, הפנייה ליחיד ואיסור הריכוכים.",
      "",
      copyStandard.trim(),
    );
  }

  sections.push(
    "",
    "---",
    "",
    "## משימה",
    "",
    "כתוב את מסמך האסטרטגיה לפי הפורמט שב-system prompt שלך. אל תוסיף הקדמה או סיכום מחוץ למסמך."
  );

  return sections.join("\n");
}
