# Animation Presets & Patterns

## Framer Motion Presets

### Basic Animations

```typescript
// Fade Up (most common - for sections)
export const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: "easeOut" as const }
  }
};

// Fade In (for images, cards)
export const fadeIn = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 0.5 }
  }
};

// Scale Up (for CTAs, important elements)
export const scaleUp = {
  hidden: { opacity: 0, scale: 0.9 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.5, ease: "easeOut" as const }
  }
};

// Slide from Side (RTL aware - from right)
export const slideFromRight = {
  hidden: { opacity: 0, x: -50 }, // Negative = from right in RTL
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.6, ease: "easeOut" as const }
  }
};
```

### Container Animations

```typescript
// Stagger Children (for lists, benefits)
export const staggerContainer = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.2
    }
  }
};

// Stagger Item (children of stagger container)
export const staggerItem = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4 }
  }
};
```

### Scroll Triggers

```typescript
// Use with whileInView
export const scrollReveal = {
  initial: "hidden",
  whileInView: "visible",
  viewport: { once: true, margin: "-100px" }
};

// With delay
export const scrollRevealWithDelay = (delay: number) => ({
  initial: "hidden",
  whileInView: "visible",
  viewport: { once: true },
  transition: { delay }
});
```

---

## Micro-Interactions

### Button States

```typescript
// Button hover
export const buttonHover = {
  scale: 1.02,
  transition: { duration: 0.2 }
};

// Button tap
export const buttonTap = {
  scale: 0.98
};

// CTA Pulse (for important buttons)
export const ctaPulse = {
  scale: [1, 1.02, 1],
  transition: {
    duration: 2,
    repeat: Infinity,
    ease: "easeInOut" as const
  }
};
```

### Card States

```typescript
// Card hover
export const cardHover = {
  y: -5,
  boxShadow: "0 20px 40px rgba(0, 0, 0, 0.2)",
  transition: { duration: 0.3 }
};

// Gold border glow on hover
export const goldBorderHover = {
  boxShadow: "0 0 20px rgba(212, 175, 55, 0.4)",
  borderColor: "#e5c158",
  transition: { duration: 0.3 }
};
```

### Gold Glow Animation

```typescript
export const goldGlow = {
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

---

## Text Animations

### Word-by-Word Reveal

```typescript
export const wordReveal = {
  hidden: { opacity: 0, y: 20 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: {
      delay: i * 0.1,
      duration: 0.5
    }
  })
};

// Usage
const words = headline.split(" ");
{words.map((word, i) => (
  <motion.span
    key={i}
    custom={i}
    variants={wordReveal}
    initial="hidden"
    animate="visible"
  >
    {word}{" "}
  </motion.span>
))}
```

### Typewriter Effect

```typescript
export const typewriter = {
  hidden: { width: 0 },
  visible: {
    width: "100%",
    transition: {
      duration: 2,
      ease: "linear" as const
    }
  }
};
```

### Counter Animation

```typescript
import { useMotionValue, animate } from "framer-motion";

const count = useMotionValue(0);

useEffect(() => {
  const controls = animate(count, targetNumber, {
    duration: 2,
    ease: "easeOut" as const
  });
  return controls.stop;
}, []);
```

---

## Mobile Adjustments

```typescript
// Reduce animation intensity on mobile
export const mobileAnimations = {
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

// Check for reduced motion preference
const prefersReducedMotion = typeof window !== 'undefined' &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
```

---

## Performance Guidelines

```typescript
// ALWAYS check for reduced motion preference
const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

// Rules:
// 1. Use transform and opacity only (GPU accelerated)
// 2. Avoid animating width, height, top, left
// 3. Use will-change sparingly
// 4. Lazy load animations below the fold
// 5. Keep duration under 1s for most animations
// 6. Use ease-out for enter, ease-in for exit

// GOOD
{
  transform: "translateY(20px)",
  opacity: 0
}

// BAD (causes layout recalculation)
{
  top: "20px",
  height: "100px"
}
```

---

## GSAP Integration

For complex scroll effects:

```typescript
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

// Parallax effect
gsap.to(".parallax-element", {
  yPercent: -50,
  ease: "none" as const,
  scrollTrigger: {
    trigger: ".parallax-container",
    start: "top bottom",
    end: "bottom top",
    scrub: true
  }
});

// Counter animation
gsap.to(".counter", {
  textContent: 1000,
  duration: 2,
  ease: "power2.out" as const,
  snap: { textContent: 1 },
  scrollTrigger: {
    trigger: ".counter",
    start: "top 80%"
  }
});
```

---

## Usage Example

```tsx
import { motion } from 'framer-motion';
import { fadeUp, staggerContainer, staggerItem, scrollReveal } from '@/lib/animations';

export const Section = ({ children }) => (
  <motion.section
    variants={fadeUp}
    {...scrollReveal}
  >
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true }}
    >
      {items.map((item, i) => (
        <motion.div key={i} variants={staggerItem}>
          {item}
        </motion.div>
      ))}
    </motion.div>
  </motion.section>
);
```
