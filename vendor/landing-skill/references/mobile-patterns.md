# Mobile Design Patterns

## Layout Changes

| Element | Desktop | Mobile |
|---------|---------|--------|
| Hero | Wide, image beside text | Stacked, image below |
| Stats cards | Horizontal row | Full-width, stacked |
| 3-Option cards | Side-by-side | Vertical stack |
| Program phases | Cards in row | Full-width, vertical |
| Bonuses grid | Multi-column | Single column |
| Forms | Centered, medium width | Full-width |
| CTA buttons | Auto width | Full-width |
| Founder profiles | 2 columns | Single column |

---

## Mobile Typography

```css
@media (max-width: 640px) {
  h1 { font-size: 2rem; }      /* 32px instead of 48-60px */
  h2 { font-size: 1.5rem; }    /* 24px instead of 36px */
  h3 { font-size: 1.25rem; }   /* 20px instead of 24px */
  body { font-size: 1rem; }    /* Keep 16px minimum */

  /* Tighter line heights on mobile */
  h1, h2 { line-height: 1.2; }
}
```

---

## Mobile Spacing

```css
@media (max-width: 640px) {
  /* Horizontal padding */
  .container { padding-inline: 1rem; }  /* 16px sides */

  /* Section spacing - tighter on mobile */
  section { padding-block: 2.5rem; }    /* 40px vs 96px desktop */

  /* Card padding */
  .card { padding: 1.25rem; }           /* 20px vs 32px desktop */

  /* Gap between stacked items */
  .stack { gap: 1rem; }                 /* 16px */
}
```

---

## Mobile Component Patterns

### Hero Section (Mobile)

```tsx
<section className="min-h-screen flex flex-col justify-center px-4 py-12">
  <p className="text-sm text-gray-400 text-center mb-2">{tagline}</p>
  <h2 className="text-lg text-gold text-center mb-1">{welcomeLine}</h2>
  <h1 className="text-2xl font-bold text-center mb-4">
    <span className="text-gold">the brand</span>
    <br />
    <span className="text-white">SCALE SYSTEM</span>
  </h1>
  <p className="text-base text-center text-gray-300 mb-6">{promise}</p>
  <button className="w-full bg-yellow-500 text-black py-4 rounded-lg font-bold">
    {ctaText}
  </button>
  <div className="mt-8">
    <Image src={heroImage} className="w-full rounded-lg" />
  </div>
</section>
```

### Stats Cards (Mobile)

```tsx
<div className="flex flex-col gap-4 px-4">
  {stats.map(stat => (
    <div className="border border-gold rounded-lg p-4 flex items-start gap-3">
      <span className="text-xl">👈</span>
      <p className="text-white text-right">{stat.text}</p>
    </div>
  ))}
</div>
```

### Form Section (Mobile)

```tsx
<div className="px-4">
  <div className="border border-gold rounded-xl p-6">
    <p className="text-center text-white mb-6">{formIntro}</p>
    <form className="space-y-4">
      <input
        className="w-full bg-transparent border border-gray-600 rounded-lg px-4 py-3 text-right"
        placeholder="שם מלא"
      />
      <input
        className="w-full bg-transparent border border-gray-600 rounded-lg px-4 py-3 text-right"
        placeholder="המייל שלך"
        type="email"
      />
      <input
        className="w-full bg-transparent border border-gray-600 rounded-lg px-4 py-3 text-right"
        placeholder="טלפון נייד"
        type="tel"
        dir="ltr"
      />
      <label className="flex items-start gap-2 text-sm text-gray-400">
        <input type="checkbox" className="mt-1" />
        <span>{consentText}</span>
      </label>
      <button className="w-full bg-yellow-500 text-black py-4 rounded-lg font-bold text-lg">
        {ctaText}
      </button>
    </form>
    <p className="text-xs text-gray-500 mt-4 text-center">{scarcityText}</p>
  </div>
</div>
```

### Bonus Card (Mobile)

```tsx
<div className="border border-gold rounded-xl p-5 mx-4">
  <div className="flex items-center gap-2 mb-2">
    <span>💎</span>
    <span className="text-gold">בונוס {number}:</span>
  </div>
  <h3 className="text-white font-bold text-lg mb-2">{title}</h3>
  <p className="text-gray-300 text-sm mb-3">{description}</p>
  <p className="text-gold text-sm">(שווי {value} )</p>
</div>
```

---

## Mobile Animation Adjustments

```typescript
// Reduce animation intensity on mobile
const mobileAnimations = {
  fadeUp: {
    hidden: { opacity: 0, y: 20 },  // 20px instead of 30px
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.4 }  // Faster on mobile
    }
  },

  // Disable parallax on mobile
  parallax: {
    // No parallax - static positioning
  },

  // Simpler stagger on mobile
  stagger: {
    staggerChildren: 0.05  // Faster stagger
  }
};

// Check for mobile
const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
```

---

## Mobile Touch Interactions

```css
/* Larger touch targets */
button, a, input, .clickable {
  min-height: 44px;
  min-width: 44px;
}

/* Remove hover effects on touch devices */
@media (hover: none) {
  .hover-effect:hover {
    transform: none;
    box-shadow: none;
  }
}

/* Active states for touch */
button:active {
  transform: scale(0.98);
  opacity: 0.9;
}
```

---

## Responsive Tailwind Classes

```tsx
// Common responsive patterns

// Full width on mobile, auto on desktop
className="w-full lg:w-auto"

// Stacked on mobile, row on desktop
className="flex flex-col lg:flex-row"

// Single column mobile, 2 columns desktop
className="grid grid-cols-1 lg:grid-cols-2"

// Different padding
className="p-4 lg:p-8"

// Different text sizes
className="text-2xl lg:text-4xl"

// Hidden on mobile, visible on desktop
className="hidden lg:block"

// Visible on mobile, hidden on desktop
className="block lg:hidden"
```

---

## Mobile Screenshots Reference

Located in `/screenshots/mobile/`:

| File | Description |
|------|-------------|
| `m-01-hero.png` | Hero section (stacked layout) |
| `m-02-hero2.png` | Hero continued with image |
| `m-03-problem.png` | Problem intro |
| `m-04-stats.png` | Stats cards (full-width, stacked) |
| `m-05-pain.png` | Pain section |
| `m-06-options.png` | 3 bad options (vertical) |
| `m-07-titans.png` | Authority section |
| `m-08-solution.png` | Solution reveal |
| `m-09-program.png` | Program phases |
| `m-10-bonuses.png` | Bonuses (single column) |
| `m-11-bonuses2.png` | More bonuses + value summary |
| `m-12-form.png` | Form section (full-width) |
| `m-13-testimonials.png` | Testimonials |
| `m-14-why.png` | Why section |
| `m-15-final.png` | Final push |
| `m-16-footer.png` | Footer |

---

## Mobile Checklist

- [ ] Touch targets are 44px minimum
- [ ] Font size never below 16px
- [ ] CTA buttons are full-width
- [ ] Form inputs are full-width
- [ ] No horizontal scrolling
- [ ] Animations are reduced/faster
- [ ] Parallax is disabled
- [ ] Images are responsive
- [ ] Cards stack vertically
- [ ] Test on real device (not just browser emulator)
