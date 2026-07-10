# Nest.APStudy Design System

## Direction

Nest uses a product-led academic identity. Marketing surfaces follow the device color scheme: Parchment Light in light mode and Nest Dark in dark mode. Restrained gold emphasis and the existing type system keep both modes recognizably Nest. Authenticated product pages continue to support the existing theme system.

The landing-page direction is “Campus field guide”: confident product imagery, spacious hierarchy, factual copy, and varied section rhythm. It preserves the current Nest identity while borrowing conversion clarity and decisive product scale from the approved Todoist and Apple Education references.

## Color

- Brand navy: use the existing Nest dark surface family (`#0a0f22`, `#0d1328`, `#101730`) throughout the landing page when the device prefers dark mode, and for the final CTA in light mode.
- Brand gold: use the existing Nest accent (`#D4AF37`) for primary actions and small emphasis, not large decorative fills.
- Daylight surfaces: use the existing Parchment Light surface family for the landing narrative and product previews when the device prefers light mode.
- Product states: continue using semantic theme tokens from `static/css/themes.css`.
- Text must meet WCAG AA; muted text should remain a darker tint of its surface rather than low-contrast gray.

## Typography

- Display: Space Grotesk, preserved as an existing brand choice.
- Body: Inter.
- Technical/meta: IBM Plex Mono, used sparingly for genuine data or status content rather than repeated section eyebrows.
- Display letter spacing must not be tighter than `-0.04em`; the landing hero remains below 96px.
- Balance headings and keep body copy within 65–75 characters per line.

## Shape and Elevation

- Controls: 6px radius.
- Cards: 12px radius.
- Panels: 16–18px radius only when the larger container needs separation.
- Use either a clear border or a short, restrained shadow. Do not pair thin borders with wide decorative shadows.
- Pills are reserved for tags and compact status labels.

## Layout

- Reading width: 760px.
- Standard content width: 1120px.
- Wide product demonstrations: up to 1280px.
- Marketing sections alternate dense product proof with generous breathing room; avoid identical feature-card grids.
- Responsive layouts collapse naturally without horizontal scrolling or hidden primary actions.

## Motion

- Use exponential ease-out curves for purposeful transitions.
- Landing motion is limited to the hero entrance, brisk outcome rotator, university marquee, tabs, and FAQ.
- Content is visible without JavaScript. Reduced-motion mode removes cycling and continuous movement.

## Components

- Primary CTA: gold on navy or navy on bright surfaces, minimum 48px target.
- Secondary CTA: solid text or outlined treatment with equal keyboard visibility.
- Product tour: accessible tablist with one active product demonstration.
- University proof: semantic university names with compact, decorative letter marks and an `aria-hidden` duplicate track.
- FAQ: numbered single-open accordion with explicit button/region relationships.
- Onboarding: five-stage desktop stepper and compact mobile progress treatment, preserving existing form behavior.
