import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanDocument } from '../src/engine/clean.ts';
import { loadHtml } from '../src/engine/html.ts';

// The form a browser gives each control in the written page: its form="" target, else the form around it.
function owners(html: string): string[] {
  const $ = loadHtml(html);
  return $('input, button, select, textarea')
    .toArray()
    .map((el) => {
      const id = $(el).attr('form');
      const form = id !== undefined ? $(`form[id="${id}"]`) : $(el).closest('form');
      return form.attr('action') ?? '-';
    });
}

describe('forms the parser could not nest keep their controls (finding 28)', () => {
  it('ties the controls of a form placed straight in a table to that form', () => {
    const $ = loadHtml(`<table width="100%"><form action="https://www.paypal.com/cgi-bin/webscr" method="post"><tr><td><input type=hidden name=cmd value="_s-xclick"><input type=submit value="Buy now"></td></tr></form></table>`);
    cleanDocument($, { stripTracking: true });
    const out = $.html();
    assert.match(out, /<form action="https:\/\/www\.paypal\.com\/cgi-bin\/webscr" method="post" id="wbd-form-1"><\/form>/);
    assert.match(out, /<input type="hidden" name="cmd" value="_s-xclick" form="wbd-form-1"><input type="submit" value="Buy now" form="wbd-form-1">/);
    assert.deepEqual(owners(out), ['https://www.paypal.com/cgi-bin/webscr', 'https://www.paypal.com/cgi-bin/webscr']);
  });

  it('follows the form pointer across cells and stops at </form>', () => {
    const cases: Array<[string, string[]]> = [
      [`<table><tr><form action="/search"><td><input name=q></td><td><input type=submit></td></form></tr></table>`, ['/search', '/search']],
      [`<table><tr><td><form action="/a" id="f"><input name=q></td><td><button>Go</button></td></tr></table></form><input name=after>`, ['/a', '/a', '-']],
      [`<table>\n<form action="/x">\n<tr><td><input name=a></td></tr>\n</form>\n<tr><td><select name=b></select></td></tr></table>`, ['/x', '-']],
      [`<table><form action="/y"><!-- </form> --><script>"</form>"</script><tr><td><textarea name=t></form></textarea><input name=a title="</form>"></td></tr></form></table><input name=b>`, ['/y', '/y', '-']],
    ];
    for (const [html, want] of cases) assert.deepEqual(owners(loadHtml(html).html()), want, html);
  });

  it('leaves well-nested forms and controls with their own form attribute alone', () => {
    const html = `<form action="/ok"><table><tr><td><input name=a></td></tr></table></form><table><form action="/z"><tr><td><input name=b form="other"></td></tr></form></table>`;
    const out = loadHtml(html).html();
    assert.doesNotMatch(out, /wbd-form/);
    assert.match(out, /<input name="b" form="other">/);
  });

  it('leaves controls the parser moved out of the form with no form, as browsers do', () => {
    // Misnested formatting tags make the parser move the open block; a moved control loses the
    // form the pointer gave it, and only the ones made after the move keep it.
    const cases: Array<[string, string[]]> = [
      [`<form action="/s"><font size=2><div align=center><input name=q><input type=submit></form></font></div>`, ['-', '-']],
      [`<form action="/s"><a href=#><div><input name=q></form></a></div>`, ['-']],
      [`<table><form action="/s"><tr><td><font><p>Email: <input name=email></font><input type=submit></td></tr></form></table>`, ['-', '/s']],
      [`<table><form action="/s"><tr><td><b><button name=go>Go</b></button></td></tr></form></table>`, ['-']],
      [`<table><form action="/s"><tr><td><b><i><div><input name=x></b><input name=y></div></td></tr></form></table>`, ['-', '/s']],
      [`<table><form action="/s"><tr><td><font><p></font><input name=q></td></tr></form></table>`, ['/s']],
      // The form moved along with its controls, so they keep it.
      [`<font face=Arial><div align=center><table><form action="/f"><tr><td><input name=q></td></tr></table></font></div><input name=after>`, ['/f', '/f']],
    ];
    for (const [html, want] of cases) assert.deepEqual(owners(loadHtml(html).html()), want, html);
  });

  it('reads <script>, <title> and <template> in svg or math as markup', () => {
    const cases: Array<[string, string[]]> = [
      [`<table><form action="/z"><tr><td><svg><script>"</form>"</script></svg><input name=a></td></tr></table>`, ['-']],
      [`<table><form action="/z"><tr><td><math><template></form></template></math><input name=a></td></tr></table>`, ['-']],
      [`<table><form action="/z"><tr><td><div title="</form>"><input name=a></div title="</form>"><input name=b></td></tr></table>`, ['/z', '/z']],
    ];
    for (const [html, want] of cases) assert.deepEqual(owners(loadHtml(html).html()), want, html);
  });

  it('does not reuse an id another element already has', () => {
    const out = loadHtml(`<div id="wbd-form-1"></div><table><form action="/s"><tr><td><input name=q></td></tr></table>`).html();
    assert.match(out, /<form action="\/s" id="wbd-form-2">/);
    assert.match(out, /<input name="q" form="wbd-form-2">/);
  });
});
