# Complete Design System

## Color Palettes

### Dark Premium (Default - "mentor Style")

```css
:root {
  /* Backgrounds */
  --bg-primary: #0a0a0a;        /* Pure black background */
  --bg-secondary: #1a1a1a;      /* Card backgrounds */
  --bg-card: #111111;           /* Elevated cards */
  --bg-gradient: linear-gradient(180deg, #0a0a0a 0%, #1a1a1a 100%);

  /* Text */
  --text-primary: #ffffff;       /* Main text */
  --text-secondary: #a3a3a3;     /* Secondary text */
  --text-muted: #737373;         /* Muted text */

  /* Accents */
  --accent-gold: #d4af37;        /* Primary accent - gold */
  --accent-yellow: #f59e0b;      /* CTA buttons */
  --accent-gold-light: #e5c158;  /* Lighter gold */

  /* Effects */
  --accent-glow: rgba(212, 175, 55, 0.3);
  --glow-gold: 0 0 20px rgba(212, 175, 55, 0.4);
  --glow-gold-intense: 0 0 40px rgba(212, 175, 55, 0.6);

  /* Borders */
  --border-gold: #d4af37;
  --border-subtle: #262626;
  --border-card: #333333;
}
```

### Light Clean (Alternative)

```css
:root {
  --bg-primary: #ffffff;
  --bg-secondary: #f5f5f5;
  --text-primary: #0a0a0a;
  --text-secondary: #525252;
  --accent-primary: #ef4444;     /* Bold red highlights */
  --accent-secondary: #fbbf24;   /* Yellow marker effect */
}
```

### SaaS/Tech (Alternative)

```css
:root {
  --bg-primary: #0f172a;         /* Deep navy */
  --accent-primary: #8b5cf6;     /* Vivid purple */
  --accent-secondary: #06b6d4;   /* Cyan */
  /* Glassmorphism */
  --glass-bg: rgba(255, 255, 255, 0.05);
  --glass-border: rgba(255, 255, 255, 0.1);
}
```

---

## Typography Scale

```css
:root {
  /* Font Family */
  --font-primary: "Assistant", "Heebo", Arial, sans-serif;
  --font-display: "Assistant", sans-serif;

  /* Scale (Mobile First) */
  --text-xs: 0.75rem;     /* 12px - disclaimers */
  --text-sm: 0.875rem;    /* 14px - small text */
  --text-base: 1rem;      /* 16px - body (MINIMUM) */
  --text-lg: 1.125rem;    /* 18px - large body */
  --text-xl: 1.25rem;     /* 20px - CTA buttons */
  --text-2xl: 1.5rem;     /* 24px - H3 */
  --text-3xl: 1.875rem;   /* 30px - H2 mobile */
  --text-4xl: 2.25rem;    /* 36px - H2 desktop */
  --text-5xl: 3rem;       /* 48px - H1 mobile */
  --text-6xl: 3.75rem;    /* 60px - H1 desktop */

  /* Font Weights */
  --font-normal: 400;
  --font-medium: 500;
  --font-semibold: 600;
  --font-bold: 700;
  --font-extrabold: 800;

  /* Line Heights */
  --leading-tight: 1.2;   /* Headlines */
  --leading-snug: 1.35;   /* Subheadlines */
  --leading-normal: 1.5;  /* Body text */
  --leading-relaxed: 1.75; /* Long-form copy */
}
```

### Typography Rules

| Element | Size | Weight | Line Height |
|---------|------|--------|-------------|
| H1 | 48-60px | 800 | 1.2 |
| H2 | 36px | 700 | 1.3 |
| H3 | 24px | 700 | 1.4 |
| Body | 16-18px | 400 | 1.5-1.8 |
| Small | 14px | 400 | 1.6 |
| CTA Button | 20px | 700 | - |

---

## Spacing System

```css
:root {
  /* Base unit: 4px */
  --space-1: 0.25rem;   /* 4px */
  --space-2: 0.5rem;    /* 8px */
  --space-3: 0.75rem;   /* 12px */
  --space-4: 1rem;      /* 16px */
  --space-5: 1.25rem;   /* 20px */
  --space-6: 1.5rem;    /* 24px */
  --space-8: 2rem;      /* 32px */
  --space-10: 2.5rem;   /* 40px */
  --space-12: 3rem;     /* 48px */
  --space-16: 4rem;     /* 64px */
  --space-20: 5rem;     /* 80px */
  --space-24: 6rem;     /* 96px */
  --space-32: 8rem;     /* 128px */

  /* Section spacing */
  --section-padding-mobile: 3rem;    /* 48px */
  --section-padding-desktop: 6rem;   /* 96px */
}
```

---

## Border Radius

```css
:root {
  --radius-none: 0;
  --radius-sm: 0.25rem;    /* 4px - subtle */
  --radius-md: 0.5rem;     /* 8px - cards */
  --radius-lg: 0.75rem;    /* 12px - buttons */
  --radius-xl: 1rem;       /* 16px - large cards */
  --radius-2xl: 1.5rem;    /* 24px - hero elements */
  --radius-full: 9999px;   /* Pills, badges */
}
```

---

## Shadows & Effects

```css
:root {
  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.1);
  --shadow-lg: 0 10px 15px rgba(0, 0, 0, 0.1);
  --shadow-xl: 0 20px 25px rgba(0, 0, 0, 0.15);
  --shadow-2xl: 0 25px 50px rgba(0, 0, 0, 0.25);

  /* Gold Glow (for dark theme) */
  --glow-gold: 0 0 20px rgba(212, 175, 55, 0.4);
  --glow-gold-intense: 0 0 40px rgba(212, 175, 55, 0.6);

  /* Glassmorphism */
  --glass-bg: rgba(255, 255, 255, 0.05);
  --glass-border: rgba(255, 255, 255, 0.1);
  --glass-blur: blur(10px);
}
```

---

## Tailwind Config

```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        'bg-primary': '#0a0a0a',
        'bg-secondary': '#1a1a1a',
        'bg-card': '#111111',
        'gold': '#d4af37',
        'gold-light': '#e5c158',
        'cta-yellow': '#f59e0b',
      },
      fontFamily: {
        'assistant': ['Assistant', 'Heebo', 'Arial', 'sans-serif'],
      },
      boxShadow: {
        'gold-glow': '0 0 20px rgba(212, 175, 55, 0.4)',
        'gold-glow-intense': '0 0 40px rgba(212, 175, 55, 0.6)',
      },
    },
  },
}
```
