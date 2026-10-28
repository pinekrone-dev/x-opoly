/**
 * The owner filters: held ten years or more, likely free and clear, and
 * mailing out of state — read from the sale date and mailing address a
 * county record carries, by the same rules in the browser and in SQL.
 */
import assert from 'node:assert/strict'
import test, { before, describe } from 'node:test'

import { DatabaseSync } from 'node:sqlite'

import { getParcel, marketSummary, putParcels, sealMarket, searchParcels, tagOwners } from '../app/lib/parcels.js'
import { nodeAdapter } from '../app/lib/sql.js'
import { mailingState, mailingZip, ownerTraits, saleYear, yearOf } from '../src/lib/owners.ts'

const NOW = new Date().getUTCFullYear()

describe('reading the record', () => {
  test('a sale year counts only when the value is shaped like a date', () => {
    assert.equal(yearOf('2004-12-09'), 2004)
    assert.equal(yearOf('2005-05'), 2005, "Hennepin's year and month")
    assert.equal(yearOf('09-25-1996'), 1996, "Travis's deed date")
    assert.equal(yearOf('S08851'), null, "Austin's subdivision code")
    assert.equal(yearOf('Old City 1'), null, "DC's neighbourhood")
    assert.equal(yearOf(''), null)
    assert.equal(saleYear({ sd: 'S08851', dd: '04-04-2007' }), 2007, 'sd first, then dd')
    assert.equal(saleYear({ sy: 1988, sd: '2020-01-01' }), 1988, 'a published year wins')
  })

  test('the mailing state comes from the ZIP, however the county writes the state', () => {
    assert.equal(mailingState('12250 W Van Buren St, Avondale AZ 85323'), 'AZ')
    assert.equal(mailingState('20 Enterprise Ste 125, Aliso Viejo CA 92656'), 'CA')
    assert.equal(mailingState('1802 Bay St Se, Washington Dc 20003-2509'), 'DC')
    assert.equal(mailingState('697 Linden Ave, Rahway, N J 07065'), 'NJ')
    assert.equal(mailingState('13042 Old Myford Rd Irvine 92602-2304'), 'CA', 'Orange County writes no state')
    assert.equal(mailingState('Po Box 182571, Columbus OH 43218'), 'OH')
    assert.equal(mailingState('Austin IRS, Austin TX 73301'), 'TX', '733 is Texas, not Oklahoma')
    assert.equal(mailingState('Suite 200'), null)
    assert.equal(mailingZip('Lot 1234567'), null, 'seven digits are not a ZIP')
  })

  test('the card reading says what the record cannot', () => {
    const none = ownerTraits({}, 'phoenix-az')
    assert.equal(none.held10, null, 'no sale date is not "held under ten years"')
    assert.equal(none.outOfState, null)
    const old = ownerTraits({ sd: `${NOW - 31}-03-01`, ma: '1 Elm St, Reno NV 89501' }, 'phoenix-az')
    assert.equal(old.held10, true)
    assert.equal(old.freeClear, true)
    assert.equal(old.heldYears, 31)
    assert.equal(old.mailState, 'NV')
    assert.equal(old.outOfState, true)
    const recent = ownerTraits({ sd: `${NOW - 2}-03-01`, ma: '1 Elm St, Mesa AZ 85201' }, 'phoenix-az')
    assert.equal(recent.held10, false)
    assert.equal(recent.outOfState, false)
  })
})

describe('the filters, in SQL', () => {
  let db
  const P = (id, sd, ma) => ({ id, ad: `${id} Main St`, ow: 'Owner', at: 'Residential', mv: 100000 + id, ac: 0.2, sd, ma, bb: [-112.1, 33.4, -112.09, 33.41] })
  before(async () => {
    db = nodeAdapter(new DatabaseSync(':memory:'))
    await db.migrate()
    await putParcels(db, 'phoenix-az', [
      P(1, `${NOW - 40}-06-01`, '1 Elm St, Phoenix AZ 85001'), // held long, free and clear, in state
      P(2, `${NOW - 12}-06-01`, '2 Elm St, Aliso Viejo CA 92656'), // held ten, out of state
      P(3, `${NOW - 1}-06-01`, '3 Elm St, Reno NV 89501-1234'), // recent, out of state
      P(4, '', 'Po Box 9, Mesa AZ 85201'), // no sale date
      P(5, `${NOW - 35}-01-01`, 'General Delivery'), // no ZIP to read
    ])
    await sealMarket(db, 'phoenix-az', { keys: ['id', 'ad', 'ow', 'mv', 'ac'] })
  })

  const ids = async (owners) => {
    const found = await searchParcels(db, 'phoenix-az', { owners })
    return found.ids.map(Number).sort()
  }

  test('held ten years or more', async () => {
    assert.deepEqual(await ids(['held10']), [1, 2, 5])
  })

  test('likely free and clear: bought thirty or more years ago', async () => {
    assert.deepEqual(await ids(['freeClear']), [1, 5])
  })

  test('out of state, by ZIP; an address with no ZIP is left out', async () => {
    assert.deepEqual(await ids(['outOfState']), [2, 3])
  })

  test('the filters combine', async () => {
    assert.deepEqual(await ids(['held10', 'outOfState']), [2])
  })

  test('a market whose state cannot be placed matches nothing, not everything', async () => {
    await putParcels(db, 'somewhere', [P(9, `${NOW - 40}-01-01`, '1 Elm St, Phoenix AZ 85001')])
    await sealMarket(db, 'somewhere', { keys: ['id'] })
    const found = await searchParcels(db, 'somewhere', { owners: ['outOfState'] })
    assert.equal(found.count, 0)
  })
})

describe('the tagging pass, and the filters on its columns', () => {
  let db
  const P = (id, sd, ma, dd) => ({ id, ad: `${id} Main St`, ow: 'Owner', at: 'Residential', mv: 100000 + id, ac: 0.2, sd, dd, ma, bb: [-112.1, 33.4, -112.09, 33.41] })
  before(async () => {
    db = nodeAdapter(new DatabaseSync(':memory:'))
    await db.migrate()
    await putParcels(db, 'austin-tx', [
      P(1, 'S08851', '7106 Ritchie Dr, Austin TX 78724', '09-25-1996'), // Travis: sd is a subdivision
      P(2, 'S08851', '5 Oak Ln, Denver CO 80206-2761', `01-02-${NOW - 3}`),
      P(3, '', 'General Delivery', ''), // nothing to read: no write
      P(4, `${NOW - 11}-05-05`, 'Po Box 1, Tulsa OK 74101'),
    ])
    await sealMarket(db, 'austin-tx', { keys: ['id', 'ad', 'ow', 'mv', 'ac'] })
  })

  test('a market is not owner-tagged until a pass reaches its end', async () => {
    assert.equal((await marketSummary(db, 'austin-tx')).otagged, false)
    const first = await tagOwners(db, 'austin-tx', { budget: 2 })
    assert.equal(first.done, false)
    assert.equal(first.changed, 2)
    const rest = await tagOwners(db, 'austin-tx', { budget: 5 })
    assert.equal(rest.done, true)
    assert.equal(rest.changed, 1, 'the parcel with nothing to read is not written')
    assert.equal((await marketSummary(db, 'austin-tx')).otagged, true)
    const again = await tagOwners(db, 'austin-tx')
    assert.equal(again.already, true, 'a finished market costs one read')
  })

  test('the columns hold what the record says', async () => {
    const one = await getParcel(db, 'austin-tx', 1)
    assert.equal(one.sy, 1996)
    assert.equal(one.ms, 'TX')
    const two = await getParcel(db, 'austin-tx', 2)
    assert.equal(two.ms, 'CO')
    const three = await getParcel(db, 'austin-tx', 3)
    assert.equal(three.sy, undefined)
  })

  test('the filters read the columns, and agree with the record-reading SQL', async () => {
    const ids = async (owners) => (await searchParcels(db, 'austin-tx', { owners })).ids.map(Number).sort()
    assert.deepEqual(await ids(['held10']), [1, 4])
    assert.deepEqual(await ids(['freeClear']), [1])
    assert.deepEqual(await ids(['outOfState']), [2, 4])
    assert.deepEqual(await ids(['held10', 'outOfState']), [4])
  })
})
