/** Single-drawing transparency groups are dropped (for Apple's renderer); anything else is kept. Run: node tools/groups-test.ts */
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { drawings, dropSingleDrawingGroups } from '../src/groups.ts';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failed++; };

check('a pattern fill is one drawing', drawings('q 1 0 0 1 680 76 cm /Pattern cs /P1 scn 0 926 m 1300 926 l 1300 0 l h f n Q')?.length === 1);
check('two fills are two drawings', drawings('0 0 m 1 1 l f 2 2 m 3 3 l f')?.length === 2);
check('a gs inside makes the group matter', drawings('/E1 gs 0 0 m 1 1 l f') === null);
check('strings and dictionaries are skipped', drawings('/Span << /ActualText (f S Do) >> BDC BT (f f) Tj ET EMC')?.length === 1);

const doc = await PDFDocument.create();
const ctx = doc.context;
const image = ctx.register(ctx.stream(new Uint8Array(3), { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
const form = (content: string, extra: Record<string, unknown> = {}) => ctx.register(ctx.flateStream(content, {
  Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Group: { Type: 'Group', S: 'Transparency', I: true }, ...extra,
}));
const one = form('0 0 m 10 10 l f');
const img = form('/X1 Do', { Resources: { XObject: { X1: image } } });
const nested = form('/X1 Do', { Resources: { XObject: { X1: one } } });
const two = form('0 0 m 10 10 l f 0 0 m 5 5 l f');
const withCs = form('0 0 m 10 10 l f', { Group: { Type: 'Group', S: 'Transparency', CS: 'DeviceRGB' } });
const dropped = dropSingleDrawingGroups(doc);
const has = (r: typeof one) => (ctx.lookup(r) as PDFRawStream).dict.has(PDFName.of('Group'));
check('one fill and one image lose the group', !has(one) && !has(img), `dropped ${dropped}`);
check('two drawings, a nested form, or a blending color space keep it', has(two) && has(nested) && has(withCs));

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
