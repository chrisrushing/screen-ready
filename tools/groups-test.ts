/**
 * Transparency groups and clip masks are rewritten so Apple's renderer (Preview) blends like the
 * canvas, without changing the picture anywhere else. Run: node tools/groups-test.ts
 */
import { PDFDocument, PDFDict, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { drawings, maskAsClip, simplifyGroups } from '../src/groups.ts';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failed++; };

check('a pattern fill is one drawing', drawings('q 1 0 0 1 680 76 cm /Pattern cs /P1 scn 0 926 m 1300 926 l 1300 0 l h f n Q')?.length === 1);
check('two fills are two drawings', drawings('0 0 m 1 1 l f 2 2 m 3 3 l f')?.length === 2);
check('a gs inside makes the group matter', drawings('/E1 gs 0 0 m 1 1 l f') === null);
check('strings and dictionaries are skipped', drawings('/Span << /ActualText (f S Do) >> BDC BT (f f) Tj ET EMC')?.length === 1);
check("a frame's clip mask becomes a clipping path",
  maskAsClip('q 1 0 0 1 680 76 cm 0 0 0 scn 0 926 m 1300 926 l 1300 0 l 0 0 l 0 926 l h f n Q') === '680 1002 m 1980 1002 l 1980 76 l 680 76 l 680 1002 l h W n');
check('a fading mask (gradient, opacity, stroke) stays a mask',
  maskAsClip('/Sh1 sh') === null && maskAsClip('/E1 gs 0 0 10 10 re f') === null && maskAsClip('0 0 m 10 10 l S') === null);

// A page drawn the way Figma writes it: an art group through a clip mask, with an Overlay grain inside.
const doc = await PDFDocument.create();
const ctx = doc.context;
const page = doc.addPage([100, 100]);
const flate = (content: string, dict: Record<string, unknown>) => ctx.register(ctx.flateStream(content, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 100], ...dict }));
const grain = flate('0.5 g 0 0 100 100 re f', { Group: { Type: 'Group', S: 'Transparency', I: true } });
const art = flate('0 0 1 rg 10 10 50 50 re f /E1 gs /G Do', {
  Group: { Type: 'Group', S: 'Transparency' },
  Resources: { ExtGState: { E1: { BM: 'Overlay', ca: 0.3 } }, XObject: { G: grain } },
});
const clip = flate('0 g 0 0 80 80 re f', { Group: { Type: 'Group', S: 'Transparency' } });
const fade = flate('/Sh1 sh', { Group: { Type: 'Group', S: 'Transparency', CS: 'DeviceGray' } });
const faded = flate('1 0 0 rg 0 0 100 100 re f 0 1 0 rg 0 0 50 50 re f', { Group: { Type: 'Group', S: 'Transparency' } });
page.node.set(PDFName.of('Resources'), ctx.obj({
  ExtGState: { M: { Type: 'ExtGState', SMask: { Type: 'Mask', S: 'Alpha', G: clip } }, F: { Type: 'ExtGState', SMask: { Type: 'Mask', S: 'Luminosity', G: fade } } },
  XObject: { A: art, B: faded },
}));
page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('q /M gs /A Do Q q /F gs /B Do Q')));
const result = simplifyGroups(doc);
const has = (r: typeof art) => (ctx.lookup(r) as PDFRawStream).dict.has(PDFName.of('Group'));
const pageText = Buffer.from(decodePDFRawStream(ctx.lookup(page.node.get(PDFName.of('Contents')) as never) as PDFRawStream).decode()).toString('latin1').replace(/\s+/g, ' ');
check('the clip mask is set as a clip where it was used', pageText.includes('0 0 m 80 0 l 80 80 l 0 80 l h W n /A Do') && pageText.includes('/F gs /B Do'), pageText);
check('the clipped art group is unwrapped, so the grain blends with the page', !has(art), JSON.stringify(result));
check('the one-drawing grain group is unwrapped, keeping its Overlay', !has(grain));
check('a group drawn through a fading mask keeps its group', has(faded));
check('mask groups themselves are untouched', has(clip) && has(fade));

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
