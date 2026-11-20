// Checks the rules in rules.js (exceptions, the CPCB 24-hour rule, weight checks, reward points, leaderboard,
// inactive clinics) on a fixed clock. Run from the repo root: deno run --allow-read tools/test-rules.js
const NOW = Date.parse("2026-11-20T06:30:00Z"); // midday in India, same date in UTC
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
globalThis.CLINICS = [{ code: "AAA", name: "Alpha Clinic" }, { code: "BBB", name: "Beta Lab" }, { code: "CCC", name: "Gamma Dental" }];
globalThis.db = { bags: [], redemptions: [] };

const src = await Deno.readTextFile(new URL("../rules.js", import.meta.url));
const R = new Function(`${src}\nreturn { bagFlags, bagEarning, clinicPoints, leaderboard, clinicActivity, inactiveClinics,
  sortCheckEvents, loggedCategory, overTolerance, PENALTY_POINTS, CLINIC_POINTS };`)();

const h = (hours) => new RealDate(NOW - hours * 3.6e6).toISOString();
// A bag from its handovers: [step, hoursAgo, weight?]
function bag(id, clinic, category, steps, extra = {}) {
  const events = steps.map(([step, ago, weight]) => ({ step, at: h(ago), weight }));
  const at = (s) => events.find((e) => e.step === s)?.at ?? null;
  return { id, clinic, category, weight: events[0].weight, loggedAt: at("logged"), collectedAt: at("collected"),
    status: at("collected") ? "collected" : "logged", events, ...extra };
}
let n = 0;
const assert = (ok, what) => { if (!ok) throw new Error("FAILED: " + what); n++; console.log("ok  " + what); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Weight checks at each handover (10% tolerance)
assert(eq(R.bagFlags(bag("A1", "AAA", "Red", [["logged", 5, 2], ["collected", 4, 2.2]])), {}), "weight: +10% is within tolerance");
assert(!R.overTolerance((1.1 - 1) / 1) && !R.overTolerance((0.9 - 1) / 1) && R.overTolerance(0.11), "weight: exactly ±10% passes despite float error, 11% does not");
assert(R.bagFlags(bag("A2", "AAA", "Red", [["logged", 5, 2], ["collected", 4, 2.24]])).weight?.pct === "+12", "weight: +12% at pickup flagged");
assert(R.bagFlags(bag("A3", "AAA", "Red", [["logged", 5, 2], ["collected", 4, 2], ["received", 3, 1.5]])).arrival?.pct === "-25", "weight: -25% on arrival at the CBWTF flagged");

// Uncollected bags: overdue after 24 h, otherwise missed if a later pickup happened at the same clinic today
db.bags = [bag("B1", "BBB", "Yellow", [["logged", 25, 1]])];
assert(eq(R.bagFlags(db.bags[0]), { overdue: { h: 25 } }), "overdue: uncollected for 25 h");
db.bags = [bag("B2", "BBB", "Yellow", [["logged", 4, 1]]), bag("B3", "BBB", "Red", [["logged", 3, 1], ["collected", 2, 1]])];
assert(R.bagFlags(db.bags[0]).missed?.time === h(2), "missed: logged before today's pickup and left behind");
assert(eq(R.bagFlags(bag("B4", "BBB", "Red", [["logged", 1, 1]])), {}), "missed: a bag logged after the pickup is not missed");

// CPCB 24-hour rule: collected waste must reach the CBWTF within a day
assert(eq(R.bagFlags(bag("C1", "CCC", "Blue", [["logged", 30, 1], ["collected", 26, 1]])), { stuck: { h: 26 } }), "24-hour rule: not received 26 h after pickup");
assert(eq(R.bagFlags(bag("C2", "CCC", "Blue", [["logged", 30, 1], ["collected", 26, 1], ["received", 2, 1]])), {}), "24-hour rule: cleared once received");

// Points: kg at the CBWTF x colour rate, only for a verified chain that has happened
const white = bag("D1", "AAA", "White", [["logged", 6, 2], ["collected", 5, 2], ["received", 1, 2]]);
assert(R.bagEarning(white)?.points === 2 * R.CLINIC_POINTS.White, "points: 2 kg White verified earns 120");
assert(R.bagEarning(bag("D2", "AAA", "White", [["logged", 6, 2], ["collected", 5, 3], ["received", 1, 3]])) === null, "points: weight mismatch earns nothing");
assert(R.bagEarning(bag("D3", "AAA", "White", [["logged", 6, 2], ["collected", 5, 2]])) === null, "points: not yet received earns nothing");
assert(R.bagEarning(bag("D4", "AAA", "White", [["logged", 6, 2], ["collected", 5, 2], ["received", -1, 2]])) === null, "points: a receipt in the future earns nothing");

// Mis-sorts are events with their own penalty
const ev = R.sortCheckEvents({ category: "Red" }, { category: "Yellow", contaminated: true }, h(0), "collector", "COL-01");
assert(eq(ev.map((e) => [e.step, e.points]), [["reclassified", -25], ["contamination", -25]]), "mis-sort: colour fix and contamination each cost 25");
assert(R.sortCheckEvents({ category: "Red" }, { category: "Red" }, h(0)).length === 0, "mis-sort: a confirmed colour costs nothing");
assert(R.loggedCategory({ category: "Yellow", events: [{ step: "reclassified", from: "Red", to: "Yellow" }] }) === "Red", "mis-sort: the clinic's original colour is kept");

// Balance = earned + penalties - redemptions (cancelled ones refunded); leaderboard ties share a rank
const fined = bag("E1", "BBB", "Yellow", [["logged", 6, 2], ["collected", 5, 2], ["received", 1, 2]]);
fined.events.push({ step: "reclassified", at: h(1), from: "Red", to: "Yellow", points: R.PENALTY_POINTS });
db.bags = [white, fined];
db.redemptions = [{ clinic: "AAA", points: 50, status: "Requested" }, { clinic: "AAA", points: 999, status: "Cancelled" }];
const pa = R.clinicPoints("AAA"), pb = R.clinicPoints("BBB");
assert(pa.earned === 120 && pa.spent === 50 && pa.balance === 70, "balance: 120 earned - 50 spent, cancelled ignored");
assert(pb.earned === 100 && pb.deducted === -25 && pb.net === 75, "balance: 100 earned - 25 mis-sort = 75 this month");
const lb = R.leaderboard();
assert(eq(lb.map((r) => [r.code, r.rank]), [["AAA", 1], ["BBB", 2], ["CCC", 3]]), "leaderboard: ordered by this month's net points");
db.bags = [];
assert(R.leaderboard().every((r) => r.rank === 1), "leaderboard: equal points share rank 1");

// Inactive clinics: no bag for more than 3 days, or never
db.bags = [bag("F1", "AAA", "Red", [["logged", 24 * 2, 1]]), bag("F2", "BBB", "Red", [["logged", 24 * 4, 1]])];
assert(!R.clinicActivity("AAA").inactive && R.clinicActivity("BBB").inactive, "inactive: 2 days is fine, 4 days is flagged");
assert(eq(R.inactiveClinics().map((c) => [c.code, c.days]), [["CCC", null], ["BBB", 4]]), "inactive: never-logged clinics listed first");

console.log(`all ${n} checks passed`);
