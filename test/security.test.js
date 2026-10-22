/**
 * Text a user controls, landing somewhere it could become code: a shared
 * survey's name in the page's own <head>, and an owner's name in a CSV a
 * broker opens in a spreadsheet.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { rewritePreview } from '../app/lib/preview.js'
import { passwordResetEmail, verificationEmail } from '../app/lib/email.js'
import { csvCell } from '../src/lib/csv.ts'

const PAGE = `<html><head><title>Land Quotient</title>
<meta property="og:title" content="Land Quotient">
<meta name="description" content="Map it.">
</head></html>`

describe('share-link previews', () => {
  test('a survey name cannot close the attribute it is written into', () => {
    const name = '0;url=https://evil.example$2 http-equiv=refresh x=$2'
    const html = rewritePreview(PAGE, { title: name, description: `"><script>x</script>$'` })
    assert.ok(!/<meta[^>]* http-equiv/.test(html.replace(/content="[^"]*"/g, 'content=""')), 'nothing escapes into the tag')
    assert.match(html, /<meta property="og:title" content="0;url=https:\/\/evil\.example\$2 http-equiv=refresh x=\$2">/)
    assert.match(html, /<title>0;url=https:\/\/evil\.example\$2 http-equiv=refresh x=\$2<\/title>/)
    assert.ok(!html.includes('<script>'))
  })
})

describe('account emails', () => {
  test('a name is text in the HTML part, never markup', () => {
    for (const make of [verificationEmail, passwordResetEmail]) {
      const mail = make({ name: '<a href="https://evil.example">Click</a>', url: 'https://landquotient.com/?verify=abc&x=1' })
      assert.ok(!mail.html.includes('<a href="https://evil.example">'))
      assert.match(mail.html, /&lt;a href=&quot;https:\/\/evil\.example&quot;&gt;/)
      assert.match(mail.html, /href="https:\/\/landquotient\.com\/\?verify=abc&amp;x=1"/)
    }
  })
})

describe('CSV cells', () => {
  test('text that a spreadsheet would run as a formula is kept as text', () => {
    assert.equal(csvCell('=HYPERLINK("https://evil.example","Owner")'), `"'=HYPERLINK(""https://evil.example"",""Owner"")"`)
    assert.equal(csvCell('+1-555'), "'+1-555")
    assert.equal(csvCell('-cmd'), "'-cmd")
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)")
    assert.equal(csvCell('\tTabbed'), "'\tTabbed")
  })

  test('ordinary values are as they were', () => {
    assert.equal(csvCell(-12.5), '-12.5', 'a negative number stays a number')
    assert.equal(csvCell(null), '')
    assert.equal(csvCell(undefined), '')
    assert.equal(csvCell('Smith, John & Mary'), '"Smith, John & Mary"')
    assert.equal(csvCell('Line\r\nbreak'), '"Line\r\nbreak"')
    assert.equal(csvCell('Birch Partners'), 'Birch Partners')
  })
})
