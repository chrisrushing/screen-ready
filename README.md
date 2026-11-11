<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="Screen Ready" width="440">
  </picture>
</p>

<p align="center"><strong>PDFs screen readers can follow, straight from your Figma frames.</strong><br>
Free, open source, and nothing ever leaves your file.</p>

<p align="center"><img src="assets/cover-1920x960.png" alt="Screen Ready turns a design into a tagged PDF: a heading, a paragraph, a chart with a description, and a list, each tagged and numbered in reading order." width="820"></p>

---

## Why I made this

Hi, I'm Chris. I design reports, decks and one-pagers, and they almost always ship as PDFs.

While I was finishing a long report, I needed it to work for people who use screen readers. I
assumed Figma could do that. It can't: its PDFs look right, but they *read* wrong. A screen reader
hears the footer before the headline, every chart label as a loose word ("81K… 79K… October to
December…"), and no headings to jump between. The usual fix is to rebuild the whole thing by hand
in another app, after the design is "done."

I went looking for a plugin that fixes this properly and didn't find one. So I built one on the
side, with Claude as my pair, while I kept designing.

Screen Ready is that plugin. It reads your frames the way you built them, works out the structure,
lets you check it, and exports a PDF that's properly tagged to the PDF/UA standard. I'm giving it
away because every designer who exports a PDF should be able to make it accessible without becoming
a PDF expert.

## What it does

**1. Review.** Headings, reading order, images, charts, tables and lists are suggested for you, from
your type styles and how your layers are arranged. A short list shows only what needs a person: an
image without a description, a heading that skips a level, text that's hard to see. Most fixes are
one click.

**2. Preview.** Hear what a screen reader will say, page by page, before you export.

**3. Export.** One tagged PDF, plus a friendly accessibility report to keep with it.

Along the way it quietly handles the messy stuff real files are full of:

- 🦶 Footers and page numbers are skipped, even when they swap sides on facing pages
- 📊 Charts and diagrams are read as one picture, with a description drafted from their own labels
- 🧩 A headline set one layer per line, a drop cap, or a "$" + "120" + "K" is read as one thing
- 👻 Hidden, cropped, or see-through text stays quiet
- 📋 Tables keep their headers; bullets drawn as little dots still make a list
- 🌍 Each passage is read in its own language, including right-to-left scripts
- 🗜️ Images are compressed with quality presets, so accessible doesn't mean huge

## For the best reading

You don't have to change how you work, but these help:

- Use **auto layout** for columns and stacks.
- **Keep things together**: a chart's title and source inside its frame, a caption with its photo.
- Use **text styles** for headings.
- Keep words as **live text**, not outlines.
- **Name images** for what they show ("Map of Europe" becomes the draft description).
- **Hide** anything that shouldn't be read.

## Private by design

Everything runs inside Figma. The plugin has no network access, so your designs and their words
never leave your file.

## Run it yourself

Requires Node 22 or later.

```bash
npm install
npm run build
```

Then in Figma: **Plugins → Development → Import plugin from manifest…** and pick `manifest.json`.
`npm run watch` rebuilds as you edit.

```bash
npm test
```

The main test (`tools/stress-test.ts`) reads eleven deliberately awkward frames, captured from Figma
the way the plugin sees them, and checks what a screen reader would hear. `tools/edge-cases-test.ts`
tags real Figma exports in `samples/stress/`. The PDF/UA checks use [veraPDF](https://verapdf.org)
when it's installed in `tools/vendor/`, and are skipped otherwise.

<details>
<summary>Where things live</summary>

| | |
|---|---|
| `src/code.ts` | Reads frames and layers from Figma |
| `src/ui.ts`, `src/ui.html` | The panel: review, preview, export |
| `src/tagger.ts` | Turns Figma's PDF export into a tagged PDF |
| `src/suggest.ts`, `src/order.ts` | Heading suggestions and reading order |
| `src/structures.ts`, `src/charts.ts`, `src/diagrams.ts`, `src/joins.ts` | Tables, lists, charts, diagrams, text split across layers |
| `src/checks.ts`, `src/contrast.ts` | Content checks and contrast |
| `src/compress.ts`, `src/slim.ts` | Image compression and vector slimming |

</details>

## Found a file it reads wrong?

That's the most useful thing you can share. Open an issue with what you expected to hear and what
you heard instead (a screenshot of the layers helps a lot). Every awkward file makes the plugin
better for everyone.

## Thanks

Built by Chris Rushing with Claude, while at [SpecterOps](https://specterops.io), with their
blessing to share it.

Icons from [Lucide](https://lucide.dev). MIT licensed; see [LICENSE](LICENSE).
