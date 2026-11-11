/** WCAG text contrast on synthetic renders. Run: node tools/contrast-test.ts */
import { checkContrast, contrastRatio, formatRatio, isLargeText, type ContrastInput, type RGB } from '../src/contrast.ts';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
};
const near = (a: number | null, b: number, tol = 0.02) => a !== null && Math.abs(a - b) <= tol;
const fmt = (r: { ratio: number | null; background: RGB | null; mixed: boolean; unknown?: string }) =>
  r.ratio === null ? `unknown (${r.unknown})` : `${r.ratio.toFixed(2)} bg ${r.background} mixed ${r.mixed}`;

// Seeded so failures reproduce.
let seed = 7;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

/** An RGBA render. */
const canvas = (w: number, h: number, fill: RGB = [255, 255, 255]) => {
  const px = new Uint8ClampedArray(w * h * 4);
  const set = (x: number, y: number, c: RGB, a = 255) => { const i = (y * w + x) * 4; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = a; };
  const get = (x: number, y: number): RGB => { const i = (y * w + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
  const rect = (x: number, y: number, rw: number, rh: number, c: (x: number, y: number) => RGB) => {
    for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) set(xx, yy, c(xx, yy));
  };
  rect(0, 0, w, h, () => fill);
  return { px, w, h, set, get, rect };
};
type Canvas = ReturnType<typeof canvas>;
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => Math.round(a[i] * t + b[i] * (1 - t))) as RGB;

/** Fake glyphs in a box: 2px solid stems with anti-aliased edges, plus thin stems that are all
 *  anti-aliasing (what small text looks like at 1x). `ink` is the color the glyphs render in. */
const glyphs = (c: Canvas, x: number, y: number, w: number, h: number, ink: RGB) => {
  for (let yy = Math.round(y + h * 0.15); yy < y + h * 0.85; yy++) {
    for (let sx = x + 2; sx + 6 < x + w; sx += 8) {
      c.set(sx, yy, ink); c.set(sx + 1, yy, ink);
      c.set(sx - 1, yy, mix(ink, c.get(sx - 1, yy), 0.2 + rand() * 0.6));
      c.set(sx + 2, yy, mix(ink, c.get(sx + 2, yy), 0.2 + rand() * 0.6));
      c.set(sx + 5, yy, mix(ink, c.get(sx + 5, yy), 0.3 + rand() * 0.5));
    }
  }
};
const text = (id: string, box: ContrastInput['box'], color: RGB, fontSize = 16, fontWeight = 400, alpha?: number): ContrastInput =>
  ({ id, box, color, alpha, fontSize, fontWeight });
const run = (c: Canvas, texts: ContrastInput[], scale = 1) => checkContrast(c.px, c.w, c.h, scale, texts);

const BLACK: RGB = [0, 0, 0], WHITE: RGB = [255, 255, 255], G777: RGB = [0x77, 0x77, 0x77];

// 1. Reference values.
{
  check('black on white is 21:1', contrastRatio(BLACK, WHITE) === 21);
  check('#767676 on white is 4.54:1', contrastRatio([0x76, 0x76, 0x76], WHITE).toFixed(2) === '4.54', contrastRatio([0x76, 0x76, 0x76], WHITE).toFixed(3));
  check('#777 on white is 4.48:1', contrastRatio(G777, WHITE).toFixed(2) === '4.48');
  check('#0000FF on white is 8.59:1', contrastRatio([0, 0, 255], WHITE).toFixed(2) === '8.59');
  check('ratio is symmetric', contrastRatio(WHITE, G777) === contrastRatio(G777, WHITE));
  check('formatRatio truncates', formatRatio(21) === '21:1' && formatRatio(4.54) === '4.5:1' && formatRatio(4.499) === '4.4:1' && formatRatio(3.1) === '3.1:1',
    [21, 4.54, 4.499, 3.1].map((r) => formatRatio(r)).join(' '));
  check('large text thresholds', isLargeText(24, 400) && isLargeText(18.66, 700) && !isLargeText(18.66, 600) && !isLargeText(23.9, 400));
}

// 2. Black text on white, with anti-aliased glyphs: the edges must not pull the background gray.
{
  const c = canvas(400, 100);
  glyphs(c, 20, 20, 300, 24, BLACK);
  const [r] = run(c, [text('a', { x: 20, y: 20, w: 300, h: 24 }, BLACK)]);
  check('black on white passes at 21:1', r.ratio === 21 && r.pass === true && !r.mixed && r.background!.join() === '255,255,255', fmt(r));
}

// 3. #777 on white: fails as 16px body text, passes as large text.
{
  const c = canvas(400, 200);
  glyphs(c, 20, 20, 300, 24, G777);
  glyphs(c, 20, 100, 300, 30, G777);
  const [small, large, bold, semibold] = run(c, [
    text('16', { x: 20, y: 20, w: 300, h: 24 }, G777, 16),
    text('24', { x: 20, y: 100, w: 300, h: 30 }, G777, 24),
    text('19b', { x: 20, y: 100, w: 300, h: 30 }, G777, 19, 700),
    text('19', { x: 20, y: 100, w: 300, h: 30 }, G777, 19, 600),
  ]);
  check('#777 at 16px fails (needs 4.5)', near(small.ratio, 4.48) && small.pass === false && small.required === 4.5, fmt(small));
  check('#777 at 24px passes (needs 3)', near(large.ratio, 4.48) && large.pass === true && large.required === 3 && large.large, fmt(large));
  check('#777 at 19px bold passes, 19px semibold fails', bold.pass === true && semibold.pass === false);
}

// 4. Dense glyphs in the text color do not drag the background toward it.
{
  const c = canvas(200, 60);
  const box = { x: 10, y: 10, w: 160, h: 30 };
  // Solid "ink" over ~40% of the box, in blocks too wide to be anti-aliasing.
  c.rect(10, 10, 160, 30, (x) => (x % 10 < 4 ? G777 : WHITE));
  const [r] = run(c, [text('dense', box, G777)]);
  check('glyph pixels excluded', near(r.ratio, 4.48) && r.background!.join() === '255,255,255', fmt(r));
}

// 5. White text half over a dark photo, half over white: worst case, flagged as mixed.
{
  const c = canvas(300, 80);
  c.rect(0, 0, 150, 80, () => [30 + rand() * 50, 25 + rand() * 50, 35 + rand() * 40].map(Math.round) as RGB);
  glyphs(c, 50, 20, 200, 30, WHITE);
  const [half, photo] = run(c, [
    text('half', { x: 50, y: 20, w: 200, h: 30 }, WHITE),
    text('photo', { x: 10, y: 20, w: 120, h: 30 }, WHITE),
  ]);
  check('half over white: worst case, mixed', near(half.ratio, 1, 0.1) && half.pass === false && half.mixed, fmt(half));
  check('all over the dark photo passes', photo.pass === true && photo.ratio! > 7, fmt(photo));
}

// 6. White text over a gradient: the light end decides, though no single tone covers 15%.
{
  const c = canvas(300, 60);
  c.rect(0, 0, 300, 60, (x) => { const v = Math.round(20 + (x / 299) * 215); return [v, v, v]; });
  glyphs(c, 10, 10, 280, 40, WHITE);
  const [r] = run(c, [text('grad', { x: 10, y: 10, w: 280, h: 40 }, WHITE)]);
  check('gradient: worst end, mixed', r.ratio! < 1.6 && r.mixed && r.pass === false, fmt(r));
}

// 7. Semi-transparent text is blended over the background first.
{
  const c = canvas(300, 120, WHITE);
  c.rect(0, 60, 300, 60, () => [32, 32, 32]);
  glyphs(c, 20, 10, 250, 30, mix(BLACK, WHITE, 0.5)); // black at 50% renders #808080
  glyphs(c, 20, 75, 250, 30, mix(WHITE, [32, 32, 32], 0.6));
  const [onWhite, onDark] = run(c, [
    text('half-black', { x: 20, y: 10, w: 250, h: 30 }, BLACK, 16, 400, 0.5),
    text('white-60', { x: 20, y: 75, w: 250, h: 30 }, WHITE, 16, 400, 0.6),
  ]);
  const expected = contrastRatio([128, 128, 128], WHITE);
  check('black at 50% on white = #808080 on white', near(onWhite.ratio, expected) && onWhite.foreground!.join() === '128,128,128' && onWhite.background!.join() === '255,255,255',
    `${fmt(onWhite)} expected ${expected.toFixed(2)}`);
  const exp2 = contrastRatio(mix(WHITE, [32, 32, 32], 0.6), [32, 32, 32]);
  check('white at 60% on #202020', near(onDark.ratio, exp2) && onDark.background!.join() === '32,32,32', `${fmt(onDark)} expected ${exp2.toFixed(2)}`);
}

// 8. Unknowns.
{
  const c = canvas(100, 100);
  c.rect(40, 40, 6, 6, () => BLACK);
  const [off, empty, covered, invisible, partial] = run(c, [
    text('off', { x: 500, y: 20, w: 50, h: 20 }, BLACK),
    text('empty', { x: 10, y: 10, w: 0, h: 20 }, BLACK),
    text('covered', { x: 40, y: 40, w: 6, h: 6 }, BLACK),
    text('invisible', { x: 10, y: 10, w: 50, h: 20 }, BLACK, 16, 400, 0),
    text('partial', { x: 80, y: 10, w: 50, h: 20 }, BLACK),
  ]);
  check('box off the render is unknown', off.ratio === null && off.pass === null && off.unknown === 'off-render', fmt(off));
  check('zero-size box is unknown', empty.unknown === 'empty');
  check('box filled by glyphs is unknown', covered.unknown === 'covered', fmt(covered));
  check('opacity 0 is unknown', invisible.unknown === 'invisible');
  check('box partly off the render is measured', partial.ratio === 21, fmt(partial));
}

// 9. A large area in the text's own color is background, not glyphs: white text over white is 1:1.
{
  const c = canvas(200, 60);
  const [r] = run(c, [text('ghost', { x: 20, y: 10, w: 150, h: 30 }, WHITE)]);
  check('text color = background reads 1:1', r.ratio === 1 && r.pass === false, fmt(r));
}

// 10. Scale 2: boxes in frame px map onto a 2x render.
{
  const c = canvas(200, 100); // a 100×50 frame at 2x
  c.rect(0, 0, 100, 100, () => [0, 0, 0]);
  glyphs(c, 110, 20, 80, 60, BLACK);
  const [right, left] = run(c, [text('right', { x: 50, y: 5, w: 45, h: 40 }, BLACK), text('left', { x: 2, y: 5, w: 45, h: 40 }, BLACK)], 2);
  check('scale 2 maps boxes to the right pixels', right.ratio === 21 && left.ratio === 1, `${fmt(right)} / ${fmt(left)}`);
}

// 11. Transparent render pixels read as the white page.
{
  const c = canvas(100, 40);
  c.rect(0, 0, 100, 40, () => [0, 0, 0]);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 100; x++) c.px[(y * 100 + x) * 4 + 3] = 0;
  const [r] = run(c, [text('t', { x: 5, y: 5, w: 80, h: 30 }, BLACK)]);
  check('transparent pixels read as white', r.ratio === 21, fmt(r));
}

// 12. Speed: a 1920×1080 frame with a photo and 150 text layers.
{
  const c = canvas(1920, 1080);
  c.rect(0, 0, 960, 1080, () => [rand() * 255, rand() * 255, rand() * 255].map(Math.round) as RGB);
  const texts: ContrastInput[] = [];
  for (let i = 0; i < 150; i++) {
    const x = 20 + (i % 3) * 620, y = 10 + Math.floor(i / 3) * 21, w = 560, h = 20;
    glyphs(c, x, y, w, h, WHITE);
    texts.push(text(`t${i}`, { x, y, w, h }, WHITE));
  }
  texts.push(text('hero', { x: 100, y: 100, w: 1700, h: 600 }, WHITE, 120, 700));
  const t0 = performance.now();
  const res = run(c, texts);
  const ms = performance.now() - t0;
  const t1 = performance.now();
  run(c, texts, 1);
  const warm = performance.now() - t1;
  check('1920×1080, 151 texts under 50 ms', ms < 50 && res.every((r) => r.ratio !== null), `${ms.toFixed(1)} ms cold, ${warm.toFixed(1)} ms warm`);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
