# Section Components

## Hero Section

### Props (from Copy JSON)

```typescript
interface HeroProps {
  tagline: string;
  welcomeLine: string;
  headline: string;
  subheadline: string;
  ctaText: string;
  heroImage?: string;
}
```

### Component

```tsx
import { motion } from 'framer-motion';
import Image from 'next/image';

export const Hero = ({ tagline, welcomeLine, headline, subheadline, ctaText, heroImage }: HeroProps) => (
  <section className="min-h-screen bg-bg-primary flex flex-col lg:flex-row items-center justify-center px-4 lg:px-16 py-12 lg:py-24">
    {/* Content */}
    <motion.div
      className="flex-1 text-center lg:text-right"
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
    >
      {/* Tagline */}
      <p className="text-sm text-gray-400 mb-2">{tagline}</p>

      {/* Welcome Line */}
      <h2 className="text-lg lg:text-xl text-gold mb-1">{welcomeLine}</h2>

      {/* Headline */}
      <h1 className="text-3xl lg:text-6xl font-extrabold mb-4 leading-tight">
        <span className="text-gold">{headline.split(' ')[0]}</span>
        <br />
        <span className="text-white">{headline.split(' ').slice(1).join(' ')}</span>
      </h1>

      {/* Subheadline */}
      <p className="text-base lg:text-lg text-gray-300 mb-6 max-w-xl mx-auto lg:mx-0">
        {subheadline}
      </p>

      {/* CTA Button */}
      <motion.button
        className="w-full lg:w-auto bg-cta-yellow text-black py-4 px-8 rounded-lg font-bold text-lg lg:text-xl"
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
      >
        {ctaText}
      </motion.button>
    </motion.div>

    {/* Hero Image */}
    {heroImage && (
      <motion.div
        className="flex-1 mt-8 lg:mt-0"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, delay: 0.3 }}
      >
        <Image
          src={heroImage}
          alt="Hero"
          width={600}
          height={400}
          className="rounded-2xl"
          priority
        />
      </motion.div>
    )}
  </section>
);
```

---

## Problem Section

### Props

```typescript
interface ProblemProps {
  sectionTitle: string;
  intro: string;
  statistics: { emoji: string; text: string }[];
  pillars: string[];
}
```

### Component

```tsx
export const Problem = ({ sectionTitle, intro, statistics, pillars }: ProblemProps) => (
  <section className="bg-bg-secondary py-12 lg:py-24 px-4 lg:px-16">
    <motion.div
      className="max-w-4xl mx-auto"
      variants={staggerContainer}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true }}
    >
      {/* Section Title */}
      <h2 className="text-gold text-xl lg:text-2xl font-bold mb-4 text-right">
        {sectionTitle}
      </h2>

      {/* Intro */}
      <p className="text-white text-lg lg:text-xl mb-8 text-right">
        {intro}
      </p>

      {/* Statistics */}
      <div className="space-y-4 mb-8">
        {statistics.map((stat, i) => (
          <motion.div
            key={i}
            variants={staggerItem}
            className="border border-gold rounded-lg p-4 flex items-start gap-3"
          >
            <span className="text-xl">{stat.emoji}</span>
            <p className="text-white text-right flex-1">{stat.text}</p>
          </motion.div>
        ))}
      </div>

      {/* Pillars */}
      <div className="flex flex-col lg:flex-row gap-4">
        {pillars.map((pillar, i) => (
          <motion.div
            key={i}
            variants={staggerItem}
            className="flex-1 bg-bg-card border border-border-subtle rounded-xl p-6 text-center"
          >
            <p className="text-gold font-semibold">{pillar}</p>
          </motion.div>
        ))}
      </div>
    </motion.div>
  </section>
);
```

---

## Pain Section (3 Bad Options)

### Props

```typescript
interface PainProps {
  headline: string;
  explanation: string;
  badOptions: { title: string; consequence: string }[];
  highlightedQuote: string;
}
```

### Component

```tsx
export const Pain = ({ headline, explanation, badOptions, highlightedQuote }: PainProps) => (
  <section className="bg-bg-primary py-12 lg:py-24 px-4 lg:px-16">
    <motion.div
      className="max-w-5xl mx-auto"
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true }}
    >
      {/* Headline */}
      <h2 className="text-white text-2xl lg:text-4xl font-bold mb-6 text-center">
        {headline}
      </h2>

      {/* Explanation */}
      <p className="text-gray-300 text-lg mb-12 text-center max-w-3xl mx-auto">
        {explanation}
      </p>

      {/* 3 Bad Options */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-12">
        {badOptions.map((option, i) => (
          <motion.div
            key={i}
            className="bg-bg-card border border-red-900/50 rounded-xl p-6"
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.1 }}
          >
            <h3 className="text-white font-bold text-lg mb-2 text-right">
              {option.title}
            </h3>
            <p className="text-red-400 text-right">
              = {option.consequence}
            </p>
          </motion.div>
        ))}
      </div>

      {/* Highlighted Quote */}
      <motion.div
        className="bg-bg-card border border-gold rounded-2xl p-8 text-center"
        initial={{ opacity: 0, scale: 0.95 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true }}
      >
        <p className="text-gold text-xl lg:text-2xl font-semibold">
          "{highlightedQuote}"
        </p>
      </motion.div>
    </motion.div>
  </section>
);
```

---

## Authority Section (Founders)

### Props

```typescript
interface AuthorityProps {
  headline: string;
  founders: {
    name: string;
    title: string;
    credentials: string[];
    currentRole: string;
  }[];
  mission: string;
}
```

### Component

```tsx
export const Authority = ({ headline, founders, mission }: AuthorityProps) => (
  <section className="bg-bg-secondary py-12 lg:py-24 px-4 lg:px-16">
    <motion.div className="max-w-5xl mx-auto">
      {/* Headline */}
      <h2 className="text-gold text-2xl lg:text-4xl font-bold mb-12 text-center">
        {headline}
      </h2>

      {/* Founders Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-12">
        {founders.map((founder, i) => (
          <motion.div
            key={i}
            className="bg-bg-card border border-gold rounded-2xl p-6 lg:p-8"
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.2 }}
          >
            <h3 className="text-gold text-xl font-bold mb-1">{founder.name}</h3>
            <p className="text-gray-400 mb-4">{founder.title}</p>

            <ul className="space-y-2 mb-4">
              {founder.credentials.map((cred, j) => (
                <li key={j} className="text-white text-sm flex gap-2">
                  <span className="text-gold">•</span>
                  {cred}
                </li>
              ))}
            </ul>

            <p className="text-gray-300 text-sm italic">
              {founder.currentRole}
            </p>
          </motion.div>
        ))}
      </div>

      {/* Mission */}
      <motion.div
        className="text-center"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
      >
        <p className="text-white text-lg lg:text-xl max-w-3xl mx-auto">
          {mission}
        </p>
      </motion.div>
    </motion.div>
  </section>
);
```

---

## Bonuses Section

### Props

```typescript
interface BonusesProps {
  headline: string;
  subheadline: string;
  bonuses: {
    number: number;
    emoji: string;
    name: string;
    description: string;
    value: string;
  }[];
  totalValue: string;
  freeText: string;
}
```

### Component

```tsx
export const Bonuses = ({ headline, subheadline, bonuses, totalValue, freeText }: BonusesProps) => (
  <section className="bg-bg-primary py-12 lg:py-24 px-4 lg:px-16">
    <motion.div className="max-w-4xl mx-auto">
      {/* Header */}
      <h2 className="text-gold text-2xl lg:text-4xl font-bold mb-2 text-center">
        {headline}
      </h2>
      <p className="text-white text-lg mb-12 text-center">{subheadline}</p>

      {/* Bonus Cards */}
      <div className="space-y-6 mb-12">
        {bonuses.map((bonus, i) => (
          <motion.div
            key={i}
            className="border border-gold rounded-xl p-5 lg:p-6"
            initial={{ opacity: 0, x: -30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.1 }}
            whileHover={{ boxShadow: "0 0 20px rgba(212, 175, 55, 0.3)" }}
          >
            <div className="flex items-center gap-2 mb-2">
              <span>{bonus.emoji}</span>
              <span className="text-gold font-semibold">בונוס {bonus.number}:</span>
            </div>
            <h3 className="text-white font-bold text-lg mb-2">{bonus.name}</h3>
            <p className="text-gray-300 text-sm mb-3">{bonus.description}</p>
            <p className="text-gold text-sm">(שווי {bonus.value} )</p>
          </motion.div>
        ))}
      </div>

      {/* Total Value */}
      <motion.div
        className="bg-bg-card border border-gold rounded-2xl p-8 text-center"
        initial={{ opacity: 0, scale: 0.95 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true }}
      >
        <p className="text-gray-300 mb-2">שווי כולל:</p>
        <p className="text-gold text-4xl font-bold mb-2">{totalValue} </p>
        <p className="text-white text-xl">{freeText}</p>
      </motion.div>
    </motion.div>
  </section>
);
```

---

## CTA Form Section

### Props

```typescript
interface CTAFormProps {
  formIntro: string;
  formFields: string[];
  consentText: string;
  ctaText: string;
  scarcityText: string;
  webhookUrl?: string;
}
```

### Component

```tsx
export const CTAForm = ({ formIntro, formFields, consentText, ctaText, scarcityText }: CTAFormProps) => (
  <section className="bg-bg-secondary py-12 lg:py-24 px-4 lg:px-16">
    <motion.div
      className="max-w-lg mx-auto"
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
    >
      <div className="border border-gold rounded-2xl p-6 lg:p-8">
        {/* Form Intro */}
        <p className="text-white text-center mb-6">{formIntro}</p>

        {/* Form */}
        <form className="space-y-4">
          {formFields.map((field, i) => (
            <input
              key={i}
              type={field.includes('מייל') ? 'email' : field.includes('טלפון') ? 'tel' : 'text'}
              placeholder={field}
              className="w-full bg-transparent border border-gray-600 rounded-lg px-4 py-3 text-white text-right placeholder:text-gray-500 focus:border-gold focus:outline-none transition-colors"
              dir={field.includes('טלפון') ? 'ltr' : 'rtl'}
            />
          ))}

          {/* Consent */}
          <label className="flex items-start gap-2 text-sm text-gray-400 cursor-pointer">
            <input type="checkbox" className="mt-1 accent-gold" required />
            <span>{consentText}</span>
          </label>

          {/* CTA Button */}
          <motion.button
            type="submit"
            className="w-full bg-cta-yellow text-black py-4 rounded-lg font-bold text-lg"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            {ctaText}
          </motion.button>
        </form>

        {/* Scarcity Text */}
        <p className="text-xs text-gray-500 mt-4 text-center">
          {scarcityText}
        </p>
      </div>
    </motion.div>
  </section>
);
```

---

## Testimonials Section

### Props

```typescript
interface TestimonialsProps {
  headline: string;
  testimonials: {
    name: string;
    title: string;
    hook: string;
    story: string;
    resultsTitle: string;
    results: string[];
  }[];
}
```

### Component

```tsx
export const Testimonials = ({ headline, testimonials }: TestimonialsProps) => (
  <section className="bg-bg-primary py-12 lg:py-24 px-4 lg:px-16">
    <motion.div className="max-w-5xl mx-auto">
      <h2 className="text-gold text-2xl lg:text-4xl font-bold mb-12 text-center">
        {headline}
      </h2>

      <div className="space-y-8">
        {testimonials.map((testimonial, i) => (
          <motion.div
            key={i}
            className="bg-bg-card border border-gold rounded-2xl p-6 lg:p-8"
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.2 }}
          >
            {/* Header */}
            <h3 className="text-gold text-xl font-bold">{testimonial.name}</h3>
            <p className="text-gray-400 mb-2">{testimonial.title}</p>
            <p className="text-white font-semibold mb-4">"{testimonial.hook}"</p>

            {/* Story */}
            <p className="text-gray-300 mb-6">{testimonial.story}</p>

            {/* Results */}
            <p className="text-gold font-semibold mb-2">{testimonial.resultsTitle}</p>
            <ul className="space-y-1">
              {testimonial.results.map((result, j) => (
                <li key={j} className="text-white">{result}</li>
              ))}
            </ul>
          </motion.div>
        ))}
      </div>
    </motion.div>
  </section>
);
```

---

## Urgency Quote Section

### Props

```typescript
interface UrgencyQuoteProps {
  quote: string;
  emoji: string;
}
```

### Component

```tsx
export const UrgencyQuote = ({ quote, emoji }: UrgencyQuoteProps) => (
  <section className="bg-bg-secondary py-16 lg:py-24 px-4 lg:px-16">
    <motion.div
      className="max-w-4xl mx-auto text-center"
      initial={{ opacity: 0, scale: 0.95 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={{ once: true }}
    >
      <p className="text-white text-2xl lg:text-4xl font-bold leading-relaxed">
        {quote.split('\n').map((line, i) => (
          <span key={i}>
            {line}
            {i < quote.split('\n').length - 1 && <br />}
          </span>
        ))}
        <span className="ml-2">{emoji}</span>
      </p>
    </motion.div>
  </section>
);
```
