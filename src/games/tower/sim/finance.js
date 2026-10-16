/**
 * The Finance window's numbers (issue #18): where the money came from and where it went, by
 * source, for a quarter.
 *
 * `HELP.txt` § Finance Window: *"the Finance window is where you see where your money is coming
 * from and going to"* and *"a balance sheet of your revenues and expenditures for the current
 * quarter"*. The original's own income captions are `STR 1007` ("Income from Office", "Income from
 * Hotel", "Income from Condo sale", "Income from Restaurant", "Income from Fast Food", "Income from
 * Retail Shop", "Income from Movie Theater", "Income from Party Hall") and are used as they are.
 * The expense captions are not in the recovered strings; they are ours (`spec/DEVIATIONS.md` A81).
 *
 * **A quarter is the ledger's cycle.** `specs/TIME.md` § 2533 rolls the ledgers every third day
 * (`day % 3 == 0`), and `sim/clock.js` makes a quarter exactly three days, so "the cycle since the
 * last rollover" and "this quarter" are the same span. The statement reads the open cycle
 * (`'current'`) or the one that just ended (`'previous'`, kept whole by `rollLedgers`).
 *
 * **It must add up.** `opening + income - upkeep + other == closing`, always - that is the test
 * (`test/finance.test.js`, against a real driven tower), and `discrepancy` is the number that says
 * so. The operating buckets alone do not: construction, a new film, a bomb's ransom, a fire's
 * helicopter and a basement's buried treasure all move cash outside them, which is why
 * `sim/economy.js` carries an `other` ledger beside income and expense. Pure, read-only.
 */
import { EXPENSE_BUCKETS, INCOME_BUCKETS, OTHER_BUCKETS, OTHER_SIGN } from './economy.js';
import { calendarOf } from './clock.js';

/** Income captions, in the order the original lists them (`STR 1007`). A hotel is one line, three buckets. */
export const INCOME_LINES = [
  { key: 'office', label: 'Income from Office', buckets: ['office'] },
  { key: 'hotel', label: 'Income from Hotel', buckets: ['hotelSingle', 'hotelTwin', 'hotelSuite'] },
  { key: 'condo', label: 'Income from Condo sale', buckets: ['condo'] },
  { key: 'restaurant', label: 'Income from Restaurant', buckets: ['restaurant'] },
  { key: 'fastFood', label: 'Income from Fast Food', buckets: ['fastFood'] },
  { key: 'retail', label: 'Income from Retail Shop', buckets: ['retail'] },
  { key: 'cinema', label: 'Income from Movie Theater', buckets: ['cinema'] },
  { key: 'partyHall', label: 'Income from Party Hall', buckets: ['partyHall'] },
];

/** Upkeep captions: one per `EXPENSE_BUCKETS` entry (ours - see the header). */
export const UPKEEP_LINES = [
  { key: 'elevatorStandard', label: 'Standard elevators', buckets: ['elevatorStandard'] },
  { key: 'elevatorExpress', label: 'Express elevators', buckets: ['elevatorExpress'] },
  { key: 'elevatorService', label: 'Service elevators', buckets: ['elevatorService'] },
  { key: 'escalator', label: 'Escalators', buckets: ['escalator'] },
  { key: 'stairs', label: 'Stairs', buckets: ['stairs'] },
  { key: 'security', label: 'Security', buckets: ['security'] },
  { key: 'housekeeping', label: 'Housekeeping', buckets: ['housekeeping'] },
  { key: 'recyclingCenter', label: 'Recycling Centers', buckets: ['recyclingCenter'] },
  { key: 'metroStation', label: 'Metro Station', buckets: ['metroStation'] },
  { key: 'parkingRamp', label: 'Parking Ramps', buckets: ['parkingRamp'] },
  // A55: the formula the spec calls parking's is charged to the lobby in play.
  { key: 'parking', label: 'Lobby and parking upkeep', buckets: ['parking'] },
];

/** The lines for every other movement of cash, signed by {@link OTHER_SIGN}. */
export const OTHER_LINES = [
  { key: 'construction', label: 'Construction', buckets: ['construction'] },
  { key: 'films', label: 'New movies', buckets: ['films'] },
  { key: 'ransom', label: 'Ransom paid to the bomber', buckets: ['ransom'] },
  { key: 'helicopter', label: 'Emergency fire crew', buckets: ['helicopter'] },
  { key: 'treasure', label: 'Buried treasure', buckets: ['treasure'] },
  { key: 'capLost', label: 'Income over the cash limit', buckets: ['capLost'] },
  { key: 'unclassifiedIncome', label: 'Other income', buckets: ['unclassifiedIncome'] },
  { key: 'unclassifiedExpense', label: 'Other expenses', buckets: ['unclassifiedExpense'] },
];

const sum = (source, buckets, sign = 1) =>
  buckets.reduce((total, key) => total + sign * (source?.[key] ?? 0), 0);

/**
 * The statement for one quarter.
 *
 * @param {object} tower
 * @param {'current'|'previous'} which
 * @returns {object|null} `null` for `'previous'` before the first rollover
 */
export function financeStatement(tower, which = 'current') {
  let source;
  if (which === 'previous') {
    const q = tower.previousQuarter;
    if (!q) return null;
    source = { startDay: q.startDay, opening: q.openingCash, closing: q.closingCash, income: q.income, expense: q.expense, other: q.other };
  } else {
    source = {
      startDay: tower.cycleStartDay ?? 0, opening: tower.cycleBaseCash ?? 0, closing: tower.cash,
      income: tower.incomeLedger, expense: tower.expenseLedger, other: tower.otherLedger,
    };
  }

  const income = INCOME_LINES.map((l) => ({ key: l.key, label: l.label, amount: sum(source.income, l.buckets) }));
  const upkeep = UPKEEP_LINES.map((l) => ({ key: l.key, label: l.label, amount: sum(source.expense, l.buckets) }));
  const other = OTHER_LINES.map((l) => ({
    key: l.key, label: l.label, amount: sum(source.other, l.buckets, OTHER_SIGN[l.buckets[0]]),
  }));

  const total = (lines) => lines.reduce((t, l) => t + l.amount, 0);
  const incomeTotal = total(income);
  const upkeepTotal = total(upkeep);
  const otherTotal = total(other);
  const net = incomeTotal - upkeepTotal + otherTotal;
  const cal = calendarOf(source.startDay);

  return {
    which,
    year: cal.year,
    quarter: cal.quarter,
    startDay: source.startDay,
    openingCash: source.opening,
    closingCash: source.closing,
    income: { lines: income, total: incomeTotal },
    upkeep: { lines: upkeep, total: upkeepTotal },
    other: { lines: other, total: otherTotal },
    /** Income less upkeep: what the tower itself earned, before anything the owner chose to spend. */
    operating: incomeTotal - upkeepTotal,
    net,
    /** `closing - (opening + net)`: zero when every dollar is accounted for. */
    discrepancy: source.closing - (source.opening + net),
  };
}

/** The buckets this module knows how to present; a test asserts none of the ledger's is left out. */
export const PRESENTED_BUCKETS = {
  income: INCOME_LINES.flatMap((l) => l.buckets),
  expense: UPKEEP_LINES.flatMap((l) => l.buckets),
  other: OTHER_LINES.flatMap((l) => l.buckets),
};
export const LEDGER_BUCKETS = { income: INCOME_BUCKETS, expense: EXPENSE_BUCKETS, other: OTHER_BUCKETS };
