/** Vector slimming: numbers get shorter, nothing else changes. Run: node tools/slim-test.ts */
import { slimContent } from '../src/slim.ts';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
};

const src = [
  '/Span << /MCID 12 /ActualText (Total 1.250000 users) >> BDC',
  'q',
  '1.000000 0.000000 -0.000000 1.000000 120.123456 0.000000 cm',
  '0.000041 0.000000 0.000000 0.000041 0.000000 0.000000 cm',
  '0.011765 0.007843 0.031373 scn',
  '10.123456 20.987654 m',
  '30.004999 40.005001 l',
  '1.000000 2.000000 3.000000 4.000000 5.000000 6.000000 c',
  'h f',
  'BT /F1 1.000000 Tf 12.000000 0.000000 0.000000 12.000000 0.000000 4.000000 Tm',
  '[ (\\t) -80.390612 (\\050 1.234567) -80.390453 ] TJ ET',
  '[3.500000 2.250000] 0.000000 d',
  'Q EMC',
].join('\n');
const out = slimContent(src);

check('marked-content dictionary untouched', out.includes('/Span << /MCID 12 /ActualText (Total 1.250000 users) >> BDC'));
check('identity matrix shortened', out.includes('1 0 0 1 120.123 0 cm'), out.split('\n')[2]);
check('tiny matrix scale kept', out.includes('0.000041 0 0 0.000041 0 0 cm'), out.split('\n')[3]);
check('colors to 4 decimals', out.includes('0.0118 0.0078 0.0314 scn'), out.split('\n')[4]);
check('path points to 2 decimals', out.includes('10.12 20.99 m') && out.includes('30 40.01 l') && out.includes('1 2 3 4 5 6 c'));
check('strings inside text untouched', out.includes('(\\050 1.234567)') && out.includes('(\\t)'));
check('kerning rounded', out.includes('-80.39 (') && out.includes('-80.39 ]'));
check('font size and text matrix', out.includes('/F1 1 Tf 12 0 0 12 0 4 Tm'));
check('dash pattern', out.includes('[3.5 2.25] 0 d'));
check('operators and structure unchanged', out.replace(/[-\d.]+/g, '#') === src.replace(/[-\d.]+/g, '#'));
check('shorter', out.length < src.length * 0.8, `${src.length} → ${out.length}`);

// Inline images are copied byte for byte.
const inline = 'q 1.000000 0 0 1.000000 0 0 cm BI /W 2 /H 1 /BPC 8 /CS /G ID \x00\xff1.000000 EI Q';
check('inline image untouched', slimContent(inline).includes('ID \x00\xff1.000000 EI'));

// A matrix with integer entries: its translation is still the last two operands.
const mat = (s: string) => slimContent(s + ' cm').replace(/\s*cm$/, '').trim();
check('integer entries count toward the matrix', mat('0.000041 0 0 0.000041 100 200') === '0.000041 0 0 0.000041 100 200', mat('0.000041 0 0 0.000041 100 200'));
check('scale keeps precision beside integers', mat('0.0123456 0 0 0.0123456 0 5.5') === '0.0123456 0 0 0.0123456 0 5.5', mat('0.0123456 0 0 0.0123456 0 5.5'));
check('large scale not cut to 3 decimals', mat('1.123456 0 0 -1.123456 0 842').startsWith('1.12346 0 0 -1.12346'), mat('1.123456 0 0 -1.123456 0 842'));
const glued = 'q BI /W 4 /H 1 /BPC 8 /CS /G ID xxEIyy EI Q 1.000000 0 0 1.000000 0 0 cm';
check('EI inside image data does not end the image', slimContent(glued).includes('ID xxEIyy EI') && slimContent(glued).includes('1 0 0 1 0 0 cm'), slimContent(glued));

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
