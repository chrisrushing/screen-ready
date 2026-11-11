# Screen Ready: Community listing

## Name
Screen Ready

## Tagline (short description, under 100 characters)
Export your frames as PDFs that screen readers can follow: tagged, ordered and described.

## Description

Most PDFs exported from a design tool look right but read wrong. A screen reader hears the footer
first, every chart label as a loose word, and no headings to jump between. Screen Ready fixes that
inside Figma: it reads your frames, suggests the structure, and exports a tagged PDF built to the
PDF/UA-1 standard (ISO 14289-1).

**How it works**

1. **Review.** Headings, reading order, images, charts, tables and lists are suggested for you. A
   short list shows only what needs a person: an image without a description, a heading that skips a
   level, low contrast. Most fixes are one click.
2. **Preview.** Hear what a screen reader will say, page by page, before you export.
3. **Export.** One tagged PDF, plus an accessibility report to keep with it.

**What it handles for you**

- Headings from your type scale and text styles, with a clean outline and bookmarks
- Reading order from your layers: auto layout, columns, cards, layers placed over other layers
- Footers, page numbers and decoration skipped automatically
- Charts and diagrams read as one figure, with alt text drafted from their own labels
- Tables with header rows and columns, lists (including bullets drawn as shapes)
- Logos and images named for what they show get draft alt text you approve
- Links kept and named, citations linked to their sources
- Languages marked per passage, including right-to-left scripts
- Image compression with quality presets, so accessible doesn't mean huge

**Private by design.** Everything runs inside Figma. Nothing is uploaded; the plugin has no network
access.

**Free and open.** Built at SpecterOps in the spirit of open source.

## Tags
accessibility, PDF, a11y, screen reader, export, WCAG, PDF/UA, documents

## Support / contact
specterops.io

## Notes for reviewers
- No network access (`networkAccess.allowedDomains: ["none"]`).
- Stores roles and alt text as plugin data on the layers they describe, and file-wide choices on the
  document root. A per-person setting ("read the page as soon as it opens") uses clientStorage.
