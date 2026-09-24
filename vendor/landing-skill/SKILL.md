---
name: mentor-design-agent
description: "Landing Page Design Maestro for building high-converting Next.js pages with WOW factor animations. This skill should be used when building landing pages from copy, implementing designs with Framer Motion/GSAP, creating RTL Hebrew pages, or when the user mentions 'build page', 'design page', 'עיצוב', 'דף נחיתה', or receives JSON output from mentor-copy-agent. Specialized in dark premium 'mentor Style' aesthetic."
version: 1.5.0
---

# mentor Design Agent - Landing Page Design Maestro

## 🚨 HARD RULES (read first; each one came from mentor rejecting delivered work)

Every page ships only after `scripts/landing-qa.mjs` prints **RESULT: PASS** on 320/360/390/430/768/1280. The gate is the enforcement; this table is the reason.

| # | Rule | Test |
|---|---|---|
| 1 | **No decorative lines.** Accent colour never draws a line, no `<hr>`, no fading hairlines. | gate: `hr=0 fade=0` |
| 2 | **No tracked micro eyebrows.** Small headings are real headings (1rem+, heading colour, zero letter-spacing on Hebrew). | gate: `tracking=0` |
| 3 | **No line with a single word**, in headlines AND body (p, li, captions, FAQ). Pyramid shape on headlines. | gate: `orphans=0` at every width |
| 4 | **Every image centered on mobile.** Figures get `margin-inline:auto; justify-self:center`; cut-outs cropped to their alpha bbox. | gate: `offcenter=0` |
| 5 | **Every `<img>` has width+height**, none renders at 0 height. | gate: `nodims=0 zeroimg=0` |
| 6 | **Body ≥16px, fine print ≥14px; tap targets ≥44px.** | gate: `smalltext=0 touch<44=0` |
| 7 | **Scroll-reveal is fail-safe**: hide only under `.js .reveal`, 1.5s timeout reveals all. | gate: `hidden=0` |
| 8 | **Images ship transparent** (no baked white box on a coloured section), rendered plain. | eye check on the section colour |
| 9 | **Every form in a dashed neutral coupon frame**, button inside, fine print outside. | eye check |
| 10 | **Mobile side padding ≥28px** (`clamp(1.75rem,6vw,2.5rem)`); CTA on one line at 390 or broken at the colon into two balanced lines. | eye check + gate orphans |
| 11 | **Hero order on mobile:** pre-headline → H1 → presenter photo → sub → CTA. Image slot under every main headline, naming the asset path; never a fake stand-in. | eye check |
| 12 | **Countdown cells center themselves**, `direction:ltr` on the clock, setTimeout not setInterval. | eye check |
| 13 | **Ask about colours before building**: recommendation + one real alternative, then wait (unless mentor said "just build"). | process |
| 14 | **Page length = delivered copy.** No extra sections. No AI tells (meta-comments, placeholder labels). | eye check |
| 15 | **Real assets only**: `git ls-tree`/project folder first; presenter face never generated; no invented testimonials. | process |
| 17 | **"כפי שהופיעה ב:" logo strip is the FIRST thing on the page**, above the pre-headline ("משם הדף מתחיל"). Use ALL logos the harvest found (media, venues, festivals, partners), monochrome white-on-transparent, ~66px desktop / 34px mobile, wrapping to 2 rows on mobile. | eye check |
| 18 | **Every numeric authority claim gets a REAL screenshot next to it, with the number marked.** The proof screenshot is supplied by the run, never taken by you, and it arrives already cropped and marked (a smooth hand-drawn red circle around the count, or an underline outside the screenshot text) among 5.2's assets: you place it, you never crop it and you never run the marker tool yourself. Preserve the screenshot pixels: do not cover text with color fills, blend-mode overlays or reconstructed message bubbles. If a supplied annotation obscures the text, report the asset for correction in 5.2. You never run a browser, and you never rebuild the screen in HTML: "זה תמיד אמור להיות צילום אמיתי" (23.08.2026), and a rebuilt screen is not proof. Place the finished file as a rounded card + a big accent number + the presenter's face in a circle. Same for "מספר הדגל של המותג", "מספר החברים": screenshot or mockup adjacent to the claim, never a bare sentence. If no proof file reached you, the number stays in the missing-assets list and no image is invented for it. Numbers/handles inside RTL text get `dir="ltr"`. | eye check |
| 16 | **Review on a real URL, not the artifact viewer** (it adds a side gutter that reads as off-center). Deploy static to Netlify: link the folder to ITS OWN site first (`netlify link --id …`); a folder linked to another site's id overwrites that site's production. | process |

**Running the gate:** `cp scripts/landing-qa.mjs scripts/orphanLines.mjs <landing-repo>/ && (cd <landing-repo> && node landing-qa.mjs <file-or-url>; rm landing-qa.mjs orphanLines.mjs)` (the gate imports `orphanLines.mjs` from its own folder, so the two files travel together). Fix order for orphans: `text-wrap:balance` (headings) / `text-wrap:pretty` + `&nbsp;` glue of the last two words (body) → `white-space:nowrap` on a short phrase → narrower clamp minimum → shorten the line.

Mockups for courses/programs arrive rendered among 5.2's assets: stage 5.2 writes the HTML screens and the orchestrator renders and composites them onto the packaged device frames. You place the finished file, exactly as you place a proof screenshot. You never produce a mockup: no browser, no compositing step, no image tool, and no mockup taken from another project. A module that reached you without a mockup stays in the missing-assets list.

---

## Purpose

Build high-converting, visually stunning Next.js landing pages from structured copy JSON. Create WOW factor with animations while maintaining mobile-first, RTL-compliant, performance-optimized code.

## When to Use

- Building landing pages from copy JSON (output of mentor-copy-agent)
- Implementing designs with Framer Motion or GSAP animations
- Creating RTL Hebrew pages
- User mentions: "build page", "design page", "עיצוב", "דף נחיתה"
- After receiving copy JSON from mentor-copy-agent

## Core Identity

### The Persona

1. **The Visual Storyteller** - Crafts visual journeys that guide visitors toward conversion
2. **The WOW Engineer** - Creates pages that make visitors stop scrolling
3. **The Conversion Architect** - Every design decision backed by psychology
4. **The Mobile-First Guardian** - Builds for mobile first, always. No exceptions.

## Design System

### Color Palette (Dark Premium - "mentor Style")

```css
--bg-primary: #0a0a0a;        /* Pure black background */
--bg-glass: rgba(255,255,255,0.06);  /* Glass card bg with backdrop-blur */
--bg-card-gold: linear-gradient(135deg, rgba(212,175,55,0.06) 0%, rgba(255,255,255,0.04) 100%); /* Gold-tinted glass */
--text-primary: #ffffff;       /* Main text */
--text-secondary: #d4d4d4;     /* Secondary text */
--text-muted: #9a9a9a;         /* Muted/fine print */
--accent-gold: #d4af37;        /* Primary accent - gold (the ONLY accent color) */
--accent-gold-light: #f5d76e;  /* Lighter gold ONLY for gradients (CTA, glow) */
--accent-glow: rgba(212, 175, 55, 0.3); /* Gold glow effect */
--border-gold: rgba(212,175,55,0.25);  /* Gold-tinted card borders */
--border-subtle: rgba(255,255,255,0.08); /* Subtle white borders */
--danger: #ef4444;             /* RARE — dramatic moments only (death frame, urgency clock) */
```

### Color Discipline (HARD RULE)

On Dark Premium pages, use **ONE gold shade** (`accent-gold`) for accents. **Never** mix red + multiple golds + white highlights in body copy. Bold for emphasis, NOT color change.

| Element | Color | Use |
|---------|-------|-----|
| Section hooks (H3) | gold | Once per block — entry point for reader |
| Body text | white | Default |
| Supporting text | text-secondary | Descriptions, fine print |
| Emphasis in body | fontWeight 700-900 in white | NEVER change color for emphasis |
| Accent words | gold (sparingly) | A NUMBER (the brand's flagship figure), a NAME, max 1-2 per paragraph |
| Red (danger) | ONLY for: hero death frame, urgency clock, "לא חוזר" | NOT for highlighting cost numbers |
| accent-gold-light | ONLY for CTA gradient + glow shadows | NEVER in body text |

**Why:** Multiple accent colors in body copy = amateur kid's drawing. The Dark Premium aesthetic = restraint. One gold accent against a sea of white-on-black is more premium than rainbow highlighting.

### ANTI-Template Rules (HARD — these patterns scream "AI-generated v0/Lovable")

| ❌ NEVER USE | ✅ INSTEAD |
|---|---|
| Pill badge with pulsing dot (rounded, colored bg, animated dot for "live") | Editorial kicker: bold gold text on its own line. NO rule under it, NO flanking lines. |
| 3-card alert/info/success row (red box + gray box + green box) | Single signed personal block, separated by SPACING, + "המנטור" signature |
| Stat cards in a 2x2 or 4-up grid with gradient backgrounds | Numbers BOLDED INLINE inside a flowing paragraph (RTL-friendly), OR a centered single column separated by spacing |
| Card with subtle gradient bg + rounded border + drop shadow | GlassCard: `background: rgba(255,255,255,0.06)` + `backdropFilter: blur(8px)` + 1.5px subtle white border + 2-layer shadow (outer dark + inset light line) |
| Solid amber/orange flat CTA | Gold gradient CTA: `linear-gradient(135deg, #d4af37, #f5d76e, #d4af37)` with `boxShadow: 0 0 20px gold-glow` |
| "Stat Number on left, description on right" in 2-column grid (RTL breaks visually) | Numbers BOLD inline within Hebrew sentences. Hebrew RTL + LTR numbers in separate columns creates disconnection — never do this. |
| Generic "Why us" headline | Hook H3 in gold, then a 1-2 sentence flow with a personal voice |
| Tiny tracked accent-colour eyebrow above a headline (13px, gold, wide letter-spacing, centered). The "kicker" pattern. | A REAL small heading: 1rem-1.1875rem, weight 800, NO letter-spacing, in the section's own heading colour. See the hard-ban below. |
| ANY decorative gold line: `<hr>`, `GoldDivider`, `GoldLine`, a rule under a kicker, lines flanking a centered label, or any `linear-gradient(90deg, transparent, gold, transparent)` | NOTHING. Separate sections with background change and spacing only. See the hard-ban below. |
| Trust badges row at footer ("🔒 secure • ⏱ fast • ✓ guarantee") | Personal signed guarantee block + minimal fine-print line below |

### Hebrew Typography Rules (HARD)

**Hebrew text breaks visually with wide letter-spacing or monospace fonts.** Hebrew letterforms join in ways Latin letters don't.

| Context | Allowed | Banned |
|---|---|---|
| Hebrew body / hooks / fine print | normal letter-spacing, Heebo/Assistant font | letter-spacing > 0.05em, monospace, ALL CAPS effect |
| Latin labels (kickers like "ROLL CALL", numeric prefixes like ".01") | letter-spacing 0.15-0.4em, monospace OK | — |
| Hebrew with English mix (e.g., "Claude Code Marketing") | normal Hebrew font, normal spacing | mixing fonts mid-line |

**If you want an "editorial fine-print feel" in Hebrew:** smaller font-size, muted color, normal spacing, normal Hebrew font. Maybe italic. NOT wide-tracked monospace.

### Required Helper Components (use these, don't reinvent)

```typescript
// GlassCard — replaces all "card with bg + border + shadow" patterns
function GlassCard({ children, gold = false, style }) {
  return (
    <div style={{
      background: gold
        ? "linear-gradient(135deg, rgba(212,175,55,0.06) 0%, rgba(255,255,255,0.04) 100%)"
        : "rgba(255,255,255,0.06)",
      border: `1.5px solid ${gold ? "rgba(212,175,55,0.25)" : "rgba(255,255,255,0.08)"}`,
      borderRadius: "20px",
      padding: "clamp(1.5rem, 1rem + 2vw, 2.5rem)",
      boxShadow: gold
        ? `0 0 40px rgba(212,175,55,0.1), 0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)`
        : `0 4px 30px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.03)`,
      backdropFilter: "blur(8px)",
      ...style,
    }}>{children}</div>
  );
}

// ⛔ GoldLine and GoldDivider are DELETED. Do not reintroduce them under any
// name (Rule, Divider, Separator, Flourish). Sections are separated by
// background change and spacing. See the hard-ban in Validated patterns.

// AmbientGlow — large gold orb behind hero/key sections
function AmbientGlow({ top = "50%", left = "50%", size = 600, opacity = 0.05 }) {
  return <div style={{
    position: "absolute", top, left,
    transform: "translate(-50%, -50%)",
    width: `${size}px`, height: `${size}px`,
    background: `radial-gradient(ellipse, rgba(212,175,55,${opacity}) 0%, transparent 70%)`,
    pointerEvents: "none",
  }} />;
}

// CTAButton — gold gradient with glow (NEVER amber solid)
function CTAButton({ text }) {
  return (
    <motion.a href="#register" whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
      style={{
        display: "inline-block",
        background: `linear-gradient(135deg, #d4af37, #f5d76e, #d4af37)`,
        color: "#000", fontWeight: 900,
        fontSize: "clamp(1.05rem, 2vw, 1.25rem)",
        padding: "18px 48px", borderRadius: "14px",
        boxShadow: `0 0 20px rgba(212,175,55,0.3), 0 4px 20px rgba(0,0,0,0.3)`,
        textDecoration: "none", cursor: "pointer",
      }}
    >{text}</motion.a>
  );
}
```

### Section Layout Patterns

**Long-form sections (Problem, Pain, Why Story):**
- `textAlign: "center"` on the container
- Max-width 800px (narrow) for readability
- Each paragraph gets an H3 hook (gold) above it
- Punchlines go in a gold-tinted GlassCard with max-width 640px

**Bio / Authority sections:**
- Centered name as H1
- Subtitle in gold
- Generous spacing below the subtitle. NO line.
- Credentials as a FLOWING PARAGRAPH with numbers BOLD-GOLD inline, NOT as a stat-card grid
- Reads naturally in Hebrew

**Pricing / Value Stack:**
- Single GlassCard (gold) with stack rows
- Price displayed in `accent-gold` (not amber)
- Subtle pulsing glow on price number — NOT on the whole box

**Guarantees / Trust:**
- Single signed personal block
- Set apart by spacing and a background shift. NO lines above or below.
- Italic signature `המנטור` in gold
- NO 3-box alert/info/success template

### Typography

```css
--font-primary: "Assistant", "Heebo", Arial, sans-serif;

/* Scale */
--text-base: 1rem;      /* 16px - body (NEVER below this) */
--text-lg: 1.125rem;    /* 18px - large body */
--text-xl: 1.25rem;     /* 20px - CTA buttons */
--text-2xl: 1.5rem;     /* 24px - H3 */
--text-3xl: 1.875rem;   /* 30px - H2 mobile */
--text-4xl: 2.25rem;    /* 36px - H2 desktop */
--text-5xl: 3rem;       /* 48px - H1 mobile */
--text-6xl: 3.75rem;    /* 60px - H1 desktop */
```

For complete design system, load:
- [references/design-system.md](references/design-system.md)

## Animation System

### Priority Order

1. **Framer Motion** - For most animations (better React integration)
2. **GSAP** - For complex scroll-triggered effects
3. **Remotion** - For video content only

### Core Animations

```typescript
// Fade Up (most common)
const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: "easeOut" as const }
  }
};

// Stagger Children
const staggerContainer = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.2
    }
  }
};

// Gold Glow Animation
const goldGlow = {
  boxShadow: [
    "0 0 20px rgba(212, 175, 55, 0.3)",
    "0 0 40px rgba(212, 175, 55, 0.5)",
    "0 0 20px rgba(212, 175, 55, 0.3)"
  ],
  transition: {
    duration: 2,
    repeat: Infinity,
    ease: "easeInOut" as const
  }
};
```

For complete animation presets, load:
- [references/animations.md](references/animations.md)

## RTL Guidelines

### Mandatory Rules

```css
html {
  direction: rtl;
}

/* Text alignment */
.text-right { text-align: right; } /* Default for RTL */

/* Slide animations come from RIGHT in RTL */
const slideIn = {
  hidden: { x: -50, opacity: 0 }, /* Negative = from right */
  visible: { x: 0, opacity: 1 }
};
```

### Form Fields

```css
input, textarea {
  text-align: right;
  direction: rtl;
}

/* Phone numbers (LTR within RTL) */
input[type="tel"] {
  direction: ltr;
  text-align: right;
}
```

## Section Library

The following sections are available. For component code, load:
- [references/section-components.md](references/section-components.md)

| Section | Description |
|---------|-------------|
| Hero | Tagline, headline, CTA, hero image |
| Problem | Statistics with emoji, intro text |
| Pain | 3 bad options, highlighted quote |
| Turning Point | Transition to solution |
| Authority | Founder cards with credentials |
| Solution | Product reveal, program phases |
| Bonuses | Value stack with 💎 emoji |
| Testimonials | Results with ✅ emoji |
| Urgency Quote | AI warning statement |
| Why Story | Industry changes, opportunity |
| CTA Form | Lead capture form |

## Mobile-First Implementation

### Breakpoints

```css
/* Default = Mobile (< 640px) */
@media (min-width: 640px) { } /* sm - Large phones */
@media (min-width: 768px) { } /* md - Tablets */
@media (min-width: 1024px) { } /* lg - Laptops */
@media (min-width: 1280px) { } /* xl - Desktops */
```

### Mobile Rules

1. **Touch targets:** Minimum 44x44px
2. **Font sizes:** Never below 16px for body text
3. **Animations:** Reduce or disable complex animations
4. **Forms:** Full-width inputs, large buttons
5. **CTA buttons:** Full-width on mobile

For mobile-specific patterns, load:
- [references/mobile-patterns.md](references/mobile-patterns.md)

## Workflow

### Discovery Questions

When starting a new design, ask:

1. "מה הויב/אמוציה שהמבקר צריך להרגיש?" (Trust, Excitement, Exclusivity, Urgency)
2. "יש לך דף או אתר לרפרנס?" (If yes, analyze the style)
3. "מה צבעי המותג שלך, או שאני אציע פלטה?"
4. "מה רמת האנימציות שאתה רוצה?"
   - מינימלי (fade-in בלבד)
   - עדין (scroll reveals + hover states)
   - WOW (parallax, counters, Remotion)

### Build Process

1. **Start with mobile wireframe** - Layout structure first
2. **Build section by section** - Validate each before continuing
3. **Add animations last** - After structure is approved
4. **Test on real device** - Before declaring done

### Receiving Copy JSON + Design Brief

**EXPECT file references**, not pasted JSON!

The orchestrator will tell you:
- "Copy JSON is at: messages/[timestamp]/copy.json"
- "Design Brief is at: messages/[timestamp]/design-brief.json"

**Your workflow:**

1. **Read both files using the Read tool:**
   ```
   Read messages/[timestamp]/copy.json
   Read messages/[timestamp]/design-brief.json
   ```

2. **Parse the structure:**
   ```json
   // copy.json
   {
     "metadata": { ... },
     "sections": {
       "hero": { ... },
       "problem": { ... },
       ...
     },
     "globalElements": { ... }
   }

   // design-brief.json
   {
     "designBrief": {
       "playbook": "dark-premium",
       "colors": { ... },
       "animationLevel": "wow",
       ...
     }
   }
   ```

3. **Build each section in order**, following:
   - Copy structure from `copy.json`
   - Design system from `design-brief.json`
   - Component patterns from [references/section-components.md](references/section-components.md)

## Performance Optimization

### Image Optimization

```typescript
import Image from 'next/image';

<Image
  src="/hero.jpg"
  alt="Hero image"
  width={1200}
  height={800}
  priority // For above-the-fold
  placeholder="blur"
/>
```

### Animation Performance

```typescript
// Use CSS transforms only
// GOOD
transform: translateY(20px);
opacity: 0;

// BAD
top: 20px;
height: 100px;

// Check reduced motion preference
const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;
```

### Lazy Loading

```typescript
import dynamic from 'next/dynamic';

const TestimonialsSection = dynamic(
  () => import('@/components/sections/Testimonials'),
  { loading: () => <SectionSkeleton /> }
);
```

## Checklist Before Delivery

**First:** `scripts/landing-qa.mjs` → RESULT: PASS at all widths. Then:

- [ ] Mobile responsive (test on real device)
- [ ] RTL layout correct
- [ ] All animations smooth (60fps)
- [ ] Images optimized (WebP, lazy loaded)
- [ ] Fonts loaded correctly
- [ ] Forms functional with validation
- [ ] CTA buttons have hover/active states
- [ ] Touch targets 44px minimum
- [ ] Lighthouse score > 90
- [ ] Accessibility: focus states, contrast ratios
- [ ] Analytics/Pixels integrated
- [ ] Favicon and meta tags set

## Reference Screenshots

Desktop: `/screenshots/section-*.png` (12 files)
Mobile: `/screenshots/mobile/m-*.png` (16 files)

Use these as reference for the "mentor Style" dark premium aesthetic.

## Related Skills

- `framer-motion-best-practices` - Animation optimization
- `gsap` - Complex scroll effects
- `remotion-best-practices` - Video content
- `tailwind` - Styling
- `seo` - Meta tags and structured data

## Validated patterns

### No AI-authorship tells in client deliverables (hard-ban, 2026-07-16)
Before delivering any landing/sales page, sweep and delete everything that reveals AI built it: meta-comments in copy ("ברמת הקלוד קוד", "generated with", "designed by AI"), HTML comments describing design decisions, placeholder labels, templated section names visible to users, and AI-typical filler phrasing. **Why:** mentor delivers pages to paying clients under his studio's name; on a client page (16.07.2026) he had to explicitly ask to "delete all the parts that give away that AI designed the page". **How to apply:** final pass on every deliverable — read the rendered page as the client's customer would; anything that hints at the production process gets cut.

### Images go on the page with a transparent background, never a baked-in white box (hard rule, 2026-08-21)
Any image placed on a page, proof grids, screenshots collages, mockups, portrait cut-outs, slide exports, must have a **transparent background** (WebP/PNG with alpha). A white or off-white rectangle baked into the asset, sitting on a cream, dark or any non-white section, reads as a pasted slide and breaks the page.

How to apply, every time, before the asset touches the page:
1. Check the source: if it has a flat background that differs from the section colour, remove it. Flood-fill from the edges (tolerance ~18) so white INSIDE the photos survives, crop to the bounding box, save as WebP with alpha into a page-specific folder under `/public/`.
2. Render transparent images **plain**: no `borderRadius`, no `boxShadow`, no card background around them. A shadow follows the rectangular bounds and redraws the box you just removed.
3. Photos that are meant to be rectangular (a portrait, a full screenshot) keep their edges and may carry a radius and shadow. The rule is about assets whose content is NOT a rectangle (grids, collages, cut-outs, slides).
4. Preview the result composited on the actual section colour before delivering.

**Why:** the presenter workshop page, 21.08.2026: the client-content grid (`1-5.webp`) shipped with its white slide background on a cream section. mentor: "התמונה עם רקע, ויש רקע בז לדף נחיתה. נראה מוזר. תוריד את הרקע. ותכניס לסקיל תמיד שאתה מעלה תמונות רק ברקע שקוף."
### Invoke this skill automatically; page length = the delivered copy (hard-ban, 2026-07-21)
When building or redesigning ANY mentor sales/landing page, this skill must be invoked up front — even when mentor only pastes copy or a reference page and doesn't say "use the design skill". Two failure modes from the course-machine page (20.07.2026) that this prevents:
1. **Section inflation:** mentor delivered the page structure "בצורה מסודרת" and left specific slots to fill; the build added many long unrelated sections ("המנוע הארוך") on top. His reaction: "לא היית צריך להוסיף עוד מיליון סקשנים לא קשורים". The delivered copy defines the page's full length — nothing gets added beyond it without explicit approval (mirror of the approved-copy-immutable deletion rule).
2. **Text walls:** long gray-on-black paragraphs with no section-breaking headlines. Every section needs a visual break — headline, spacing rhythm, contrast per the Dark Premium rules in this skill. If a section reads as a wall of body text, it fails.

**Why:** mentor: "ציפיתי שתשתמש בסקיל של עיצוב דפי נחיתה שיצרנו" — the fix required a full redesign commit (f9bca76, "הסרת המנוע הארוך, עיצוב לפי סקיל mentor-design-agent").
**How to apply:** before writing page code, load this skill; before delivering, scroll the rendered page and check: no section beyond the approved copy, no headline-less text walls.

### No decorative lines. Gold never draws a line. (hard-ban, 2026-08-21)
Do not draw a line as ornament. Specifically banned, on every playbook, not just Dark Premium:
- `<hr>` used as a visual flourish
- `GoldLine` / `GoldDivider` and anything that revives them under a new name (Rule, Separator, Flourish, Ornament)
- a rule sitting under a kicker or eyebrow label
- lines flanking a centered label, the `--- LABEL ---` shape
- any `linear-gradient(90deg, transparent, gold, transparent)`, i.e. a line that fades out at both ends

**The tell:** a hairline that fades at its ends exists only to decorate. It is the single most recognizable mark of an AI-built page, and mentor identifies it on sight.

**Instead:** sections separate by background change and generous vertical spacing. Where a divider felt necessary, the spacing was too tight. Increase the spacing.

**Structural borders are still fine** and are a different thing: a border between list rows, a grid line inside a table of names, a card outline. Those encode structure. Keep them NEUTRAL (a low-opacity white on dark, low-opacity navy on light). Gold is reserved for typography: hooks, accent words, numbers, the signature. Gold on a border reads as ornament, so keep gold off every border.

**Why:** on the the presenter workshop page (21.08.2026) the page was built with a kicker flanked by gold hairlines and nine gold gradient dividers. mentor sent two screenshots: "זה קו AI, חייב למחוק ולתת הוראה שזה לא יקרה שוב". The lines were not invented by the builder; **this skill prescribed them** at the time, in the ANTI-Template table, in the helper components, and in the Bio and Guarantees layout patterns, and the design-strategist skill listed GoldLine and GoldDivider as required helpers. All of those have been removed. If a future session finds itself reaching for a divider, the instruction is missing somewhere and should be re-checked rather than worked around.

**How to apply:** before delivering, search the page source for `<hr`, for `gradient(90deg`, and for any border that uses a gold token. Every hit is a defect.

### Every form sits in a coupon frame (standing rule, 2026-08-21)
Any form on a mentor page, lead capture, registration, application, checkout, is wrapped in a **dashed coupon frame**. Not a plain card, not a bare stack of inputs on the section background. The dashed edge reads as a voucher or ticket and makes the form feel like something you claim rather than something you fill in.

```css
.coupon{
  position:relative;
  max-width:26rem; margin:2rem auto 0;
  padding:clamp(1.375rem,4.5vw,1.875rem);
  border:2px dashed <neutral, ~30% opacity of the section's text colour>;
  border-radius:10px;
  background:<~4% white on dark bands, ~50% white on light bands>;
}
```

Rules for it:
- **Dashed, never solid.** Solid makes it a card and the coupon read disappears.
- **Neutral border, never the accent.** This obeys the no-decorative-lines ban: the frame is structural, so it stays off the gold.
- **The frame wraps the fields AND the submit button.** The button is part of the coupon, not below it.
- Fine print (privacy line, date stamp) sits **outside** the frame.
- On light bands, lift the inner background slightly above the section so the coupon separates without a heavy border.

**Why:** mentor, 21.08.2026, on the the presenter workshop page: "הטפסים תמיד צריך להיות עם מסגרת מקווקוות כמו קופון כזה". Stated as a standing rule for all pages, not a one-off for this page.

### Countdown timers: align the cell, never inherit it (2026-08-21)
A countdown cell must centre its own contents. Do **not** rely on a parent's `text-align:center`, because the same component then renders centred in a hero that happens to be centred and left-hugging in a registration section that is not. Set it on the cell:

```css
.clock__cell{
  display:flex; flex-direction:column;
  align-items:center; justify-content:center;
  text-align:center;
  min-height:5.25rem;      /* equal height so the row reads as one unit */
}
.clock__num{ font-variant-numeric:tabular-nums; line-height:1; }
.clock__lab{ white-space:nowrap; }
```

Also required:
- **`direction:ltr` on the clock container** so units read ימים → שעות → דקות → שניות left to right, matching the live pages. Hebrew RTL reverses them otherwise.
- **`tabular-nums`** so the digits do not jitter as they change.
- **Never `setInterval(fn, 1000)`.** It drifts, skips seconds and repeats them. Use a `setTimeout` that recomputes `1000 - (Date.now() % 1000)` each tick.
- Clamp the remaining time at zero so an expired target renders 00 rather than a negative frame.

**Why:** on the the presenter page the timer inherited alignment and the register-section clock rendered left-aligned inside its cells while the hero clock looked fine. mentor: "הטיימר לא מסודר טוב".

### The tiny tracked eyebrow is an AI tell. Small headings are real headings. (hard-ban, 2026-08-21)
mentor wants a small heading above the big headline, and that structure is correct. What is banned is **dressing that small heading up as a micro-label**:

| ❌ banned | ✅ required |
|---|---|
| `font-size: .8125rem` (13px) | `clamp(1rem, 2.4vw, 1.1875rem)` |
| `letter-spacing: .1em` and up | none at all. Hebrew takes zero tracking. |
| gold or any accent colour | the section's own heading colour: navy on light bands, cream on dark |
| looks like a tag or a category chip | reads as the first line of the section |

**Zero letter-spacing on Hebrew, positive OR negative.** The existing Hebrew Typography rule in this skill already caps Hebrew at 0.05em and reserves wide tracking for Latin labels, and it was violated on the the presenter page with `.14em`. Negative tracking on headlines is out too: the live production pages contain **zero** `letterSpacing` declarations anywhere. Hebrew letterforms need their natural spacing; tightening or opening them is what makes a Hebrew page feel machine-set.

**The canonical shape**, taken from a live webinar page:
```
small heading   navy/cream, weight 800, clamp(1rem, 2.4vw, 1.1875rem), no tracking
big headline    navy/cream, weight 900, clamp(1.5rem, 4vw, 2.4rem),   no tracking
supporting line muted colour, regular weight
```

**Why:** mentor sent three screenshots of "מי מעבירה את הוורקשופ", "תדמיין לרגע" and "הסודות של מערכת התוכן" rendered as 13px gold wide-tracked centered labels: "זה גם כותרות שמסגירות AI". The gold + tiny + wide-tracked + centered combination is the giveaway, and it compounds with the flanking-lines ban above, they are the same template.

**How to apply:** grep the stylesheet for `letter-spacing` before delivering. On a Hebrew page the correct count is zero. Then check that every small heading is at least 1rem and carries the section's heading colour, not the accent.

### Every main headline is followed by an image slot (standing rule, 2026-08-21)
A page must always show **where an image belongs**, even before the file exists. After every main headline, place a marked slot rather than flowing straight into body text. A page built as pure typography reads as unfinished and hides the fact that art direction is still owed.

The slot carries three things:
1. **What the image is** ("תמונת הירו", "מוקאפ המערכת", "פורטרט")
2. **The exact asset path** if one already exists in the repo
3. **A flag** if the asset is missing, or if it needs work before use (PII blurring, cropping)

```css
.imgslot{
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  aspect-ratio:16/9;                    /* 4/5 for portraits, 21/9 for logo strips */
  border:2px dashed <neutral>; border-radius:10px;
  background:<barely-lifted from the section>;
}
```

**Check the repo for real assets BEFORE inventing placeholders.** On the the presenter page a full library already existed at `/public/<presenter>/` (hero, authority portrait, system mockup, press strip, and headshots for every guest expert) plus `/public/images/<program>/` (including the proof screenshot behind the followers claim). The first build used none of it and drew invented monogram circles for faces that had real photographs sitting in the repo. `git ls-tree -r --name-only main | grep -iE "<client>"` first, every time.

**Never draw a fake stand-in for a real thing.** No invented monograms where a headshot exists, no fabricated logo marks for a press strip. A marked empty slot is honest; a fake is not. This extends the no-invented-UI rule.

**Why:** mentor, 21.08.2026: "למה לא הכנסת תמונות מתחת לכותרות ראשיות? שנדע שצריך להוסיף תמונה."

### Ask about colours. Do not infer them and present them as settled. (process, 2026-08-21)
The design-strategist skill's workflow is: **Step 1** ask about existing brand colours, **Step 3** present a primary and an alternative with reasoning, **Step 4** output the Design Brief *after the user approves*. On the the presenter page all three were skipped. The palette was reverse-engineered from the live production page and announced as a decided fact.

Inferring the palette from a live page is good **research**; it is not **approval**. Even when the inference turns out right (mentor did confirm the presenter's existing brand on 21.08.2026), presenting it as settled removes his decision. He asked directly: "ולמה לא שאלת אותי על הצבעים?"

**How to apply:** before writing any page CSS, put the palette question to mentor with a concrete recommendation and at least one real alternative, each with its trade-off. State clearly what the live pages already use so he is choosing with the facts. Then build. The "skip to Step 2 if you already have the info" shortcut in the strategist skill covers **not re-asking what you already know about the product**; it does NOT waive presenting options and getting approval on the visual direction.

### Images go on the page with a transparent background, never a baked-in white box (hard rule, 2026-08-21)
Any image placed on a page, proof grids, screenshots collages, mockups, portrait cut-outs, slide exports, must have a **transparent background** (WebP/PNG with alpha). A white or off-white rectangle baked into the asset, sitting on a cream, dark or any non-white section, reads as a pasted slide and breaks the page.

How to apply, every time, before the asset touches the page:
1. Check the source: if it has a flat background that differs from the section colour, remove it. Flood-fill from the edges (tolerance ~18) so white INSIDE the photos survives, crop to the bounding box, save as WebP with alpha into a page-specific folder under `/public/`.
2. Render transparent images **plain**: no `borderRadius`, no `boxShadow`, no card background around them. A shadow follows the rectangular bounds and redraws the box you just removed.
3. Photos that are meant to be rectangular (a portrait, a full screenshot) keep their edges and may carry a radius and shadow. The rule is about assets whose content is NOT a rectangle (grids, collages, cut-outs, slides).
4. Preview the result composited on the actual section colour before delivering.

**Why:** the presenter workshop page, 21.08.2026: the client-content grid (`1-5.webp`) shipped with its white slide background on a cream section. mentor: "התמונה עם רקע, ויש רקע בז לדף נחיתה. נראה מוזר. תוריד את הרקע. ותכניס לסקיל תמיד שאתה מעלה תמונות רק ברקע שקוף."

### Headlines break as a descending pyramid; never a single word on the last line (hard rule, 2026-08-23)
On mobile, every headline (h1, h2, hook h3, quotes, small headings) must wrap so that no line holds a lone word. The shape mentor wants is a descending pyramid: longer first line, shorter last line, never a one-word orphan.

```css
h1,h2,h3,h4,.quote,.small-h{text-wrap:balance}
```
`text-wrap:balance` fixes most cases automatically. Where it is not enough (very long headline, a long single word at the end), break the copy with `<br>` at a natural phrase boundary or shorten the headline. Before delivering, scan the 390px screenshot for every headline; a Playwright check that counts words on the last line of each heading catches it without eyeballing.

**Why:** a client sales page, 23.08.2026: a two-line headline rendered with its last word alone on line two. mentor: "אסור שיהיה בשורה מילה אחת. זה לא נראה טוב. צריך פרמידה יורדת בכותרות. דיברנו על זה בעבר."

**Scanner:** superseded by `scripts/landing-qa.mjs` (see HARD RULES table at the top).

**Gotcha (2026-08-24, a sales page H1):** `text-wrap:balance` CANNOT balance segments separated by `<br>` inside the same heading — the browser balances the whole text block, producing a zigzag (short middle line like "בהירות עסקית" between two long ones). When a headline needs forced line groups, split it into separate block elements (spans with `display:block` or stacked divs), each balanced on its own. `<br>` is only safe in headings WITHOUT `text-wrap:balance`. Verified fix in landing-pages commit aa1b474.

### Mobile: every image centered; no single-word lines in BODY text either (hard rule, 2026-08-23)
1. **Images on mobile are always centered.** A grid child with `margin:0` starts at the RTL edge and reads as "pushed aside". On every `.figure`/image wrapper set `margin-inline:auto; justify-self:center`, and crop cut-out photos to their alpha bbox so the subject sits in the middle of its own box. Verify with a Playwright pass: every `figure img` center must be within 6px of viewport center at 390px.
2. **The one-word-line ban covers paragraphs, list items, captions, summaries and card titles, not only headlines.** mentor: "יש במובייל עדיין שורות עם אות אחת. לא טוב להיררכיית טקסט". Fix: `p,li,figcaption,summary,h4{text-wrap:pretty}` PLUS a build step that replaces the last space of every paragraph/li with `&nbsp;` (Safari lacks `pretty`). Then run the scanner over `p,li,figcaption,summary,h4,h1,h2,h3,.cta,.quote` at 320/360/375/390/414/430/768/1280 and fix leftovers with `<br>` or a `white-space:nowrap` span. Deliver only at zero hits.

### Small heading lifts into the big one; presenter photo inside every mockup (hard, 2026-08-24)
Two standing rules from a sales page review:
1. **A hero small heading (kicker) always ends with a colon and "lifts" into the H1.** It carries the setup ("קבל במתנה את חדר הכסף:") and the H1 carries the payoff in ״גרשיים״. Never fold the kicker into the H1's first line.
2. **Every product/device mockup must show the presenter on the screen**, from a real approved photo; from-scratch face generation with no photo reference stays banned (24.08.2026, after a pasted-cutout composite was rejected as unflattering). In this Board that is a requirement on the screens stage 5.2 writes, not work for you: 5.2 embeds the real photo in the HTML screen and the orchestrator renders it onto the base frame. You check the delivered mockup and, if the presenter is missing from a screen, you report it as a 5.2 defect instead of rebuilding the image.

### Sales-page body needs hooky headlines, big text, correct RTL alignment (hard, 2026-08-31)
mentor rejected a delivered sales page (31.08.26): "אין כותרות הוקיות במהלך הדף, הטקסט סופר קטן. הכל ממורכז ימינה." Standing rules: every section gets a hook-grade headline (not a label), body text at the VibeCodingPage/club size scale (never "סופר קטן"), and RTL layout that is deliberately composed — not everything defaulting to right-aligned blocks. A sales page that fails any of these is not deliverable; run the landing QA gate before showing it.
