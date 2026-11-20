// CleanCare's rules, kept apart from the screens so they can be tested on their own (tools/test-rules.js).
// A plain script loaded before the app: everything here is global. It reads the app's `db` and `CLINICS` when
// called, never at load time. Nothing in this file touches the page.

const WEIGHT_TOLERANCE = 0.10;
// Exactly 10% is still within: the 1e-9 absorbs float error (2 kg → 2.2 kg gives 0.10000000000000009)
// Heaviest weight accepted at any checkpoint; the database enforces the same limit (bags_guard)
const MAX_BAG_KG = 50;
const overTolerance = (d) => Math.abs(d) > WEIGHT_TOLERANCE + 1e-9;

// ---------- reward points ----------
// Clinics earn points, never money: points are spent on healthcare supplies. ₹ figures are a reference only.
const CLINIC_POINTS = {
  White: 60,   // sharps: highest hazard
  Yellow: 50,  // infectious / pathological: high treatment cost
  Red: 30,     // contaminated plastics: moderate, some recycling value
  Blue: 20,    // glass / metal: lowest hazard and cost
};
// Points per verified kg. Placeholder values, adjustable; the order reflects hazard and treatment cost, not weight.
const PENALTY_POINTS = -25;     // per mis-sorted bag (colour corrected later, or wrong items found in it)
const POINTS_PER_RUPEE = 10;    // reference only: roughly 10 points ≈ ₹1 of redemption value
const GOVT_FUNDED_SHARE = 0.6;  // share of issued points funded by government; the CBWTF funds the rest

// ---------- inactive clinics ----------
// A visibility nudge, never a penalty: a clinic that hasn't logged a bag for this many days is listed on
// the Monitor and sees a friendly reminder. It doesn't change points.
const INACTIVITY_DAYS = 3;

const STEPS = ['logged', 'collected', 'in_transit', 'received', 'treated'];
const WEIGHED_STEPS = new Set(['logged', 'collected', 'received']);
const stepEvent = (b, step) => (b.events || []).find((e) => e.step === step) || null;
const byTime = (list) => list.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
const withEvent = (b, ...list) => byTime([...(b.events || []), ...list]);

// Mis-sorts found at a later checkpoint are events too, each carrying its own (negative) points:
//   reclassified  {from, to}  the collector or CBWTF corrected the bag's colour
//   contamination {category}  wrong items were mixed into the bag
const PENALTY_STEPS = new Set(['reclassified', 'contamination']);
function sortCheckEvents(bag, check, at, role, actor) {
  const out = [];
  if (check.category && check.category !== bag.category) {
    out.push({ step: 'reclassified', at, role, actor, from: bag.category, to: check.category, points: PENALTY_POINTS });
  }
  if (check.contaminated) {
    out.push({ step: 'contamination', at, role, actor, category: check.category || bag.category, points: PENALTY_POINTS });
  }
  return out;
}
const penaltyEvents = (b) => (b.events || []).filter((e) => PENALTY_STEPS.has(e.step));
// The colour the clinic logged, even if it was corrected later
const loggedCategory = (b) => (b.events || []).find((e) => e.step === 'reclassified')?.from || b.category;

const isToday = (iso) => iso && new Date(iso).toDateString() === new Date().toDateString();

// Latest pickup so far today at this clinic (a bag logged before it and still uncollected was missed)
function lastPickupAt(clinic, now = Date.now()) {
  let last = null;
  for (const b of db.bags) {
    if (b.clinic !== clinic || b.status !== 'collected' || !isToday(b.collectedAt)) continue;
    if (Date.parse(b.collectedAt) > now) continue; // not yet happened (sample data uses fixed clock times)
    if (!last || b.collectedAt > last) last = b.collectedAt;
  }
  return last;
}

const OVERDUE_MS = 24 * 60 * 60 * 1000;
// Flags shared by the Monitor exceptions and the Track timeline
// Weight checks at each handover, against the previous weighed checkpoint:
// collected vs the clinic's weight ("weight"), received at the CBWTF vs pickup ("arrival")
const HANDOVER_FLAGS = { collected: 'weight', received: 'arrival' };
function bagFlags(b, now = Date.now()) {
  const flags = {};
  let prev = null;
  for (const e of b.events || []) {
    if (!WEIGHED_STEPS.has(e.step) || e.weight == null) continue;
    if (prev && prev.weight) {
      const d = (e.weight - prev.weight) / prev.weight;
      if (overTolerance(d)) flags[HANDOVER_FLAGS[e.step]] = { pct: pctStr(d), from: prev.weight, to: e.weight };
    }
    prev = e;
  }
  if (b.status === 'logged') {
    const age = now - Date.parse(b.loggedAt);
    const pickup = lastPickupAt(b.clinic, now);
    if (age > OVERDUE_MS) flags.overdue = { h: Math.floor(age / 3.6e6) };
    else if (pickup && b.loggedAt < pickup) flags.missed = { time: pickup };
  }
  // CPCB 24-hour rule: collected waste must reach the CBWTF within a day
  const collected = stepEvent(b, 'collected');
  if (collected && !stepEvent(b, 'received')) {
    const age = now - Date.parse(collected.at);
    if (age > OVERDUE_MS) flags.stuck = { h: Math.floor(age / 3.6e6) };
  }
  return flags;
}
const pctStr = (d) => `${d > 0 ? '+' : ''}${(d * 100).toFixed(0)}`;

const isThisMonth = (iso, now = new Date()) => {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
};
const happened = (iso) => Date.parse(iso) <= Date.now(); // sample data can hold later clock times

function bagEarning(b) {
  const received = stepEvent(b, 'received');
  const collected = stepEvent(b, 'collected');
  if (!stepEvent(b, 'logged') || !collected || !received || !happened(received.at)) return null;
  const f = bagFlags(b);
  if (f.weight || f.arrival) return null; // weights don't match: unverified, earns nothing
  const kgs = received.weight ?? collected.weight;
  return { at: received.at, category: b.category, kg: kgs, rate: CLINIC_POINTS[b.category], points: Math.round(kgs * CLINIC_POINTS[b.category]) };
}

// Everything the Rewards card needs for one clinic
function clinicPoints(code) {
  const month = { earned: 0, byCat: {}, penalties: [] };
  let allTime = 0;
  for (const b of db.bags) {
    if (b.clinic !== code) continue;
    const e = bagEarning(b);
    if (e) {
      allTime += e.points;
      if (isThisMonth(e.at)) {
        month.earned += e.points;
        const c = month.byCat[e.category] || (month.byCat[e.category] = { kg: 0, points: 0, bags: 0 });
        c.kg += e.kg; c.points += e.points; c.bags++;
      }
    }
    for (const p of penaltyEvents(b)) {
      if (!happened(p.at)) continue;
      allTime += p.points;
      if (isThisMonth(p.at)) month.penalties.push({ b, e: p });
    }
  }
  const spent = (db.redemptions || []).filter((r) => r.clinic === code && r.status !== 'Cancelled').reduce((sum, r) => sum + r.points, 0);
  const deducted = month.penalties.reduce((sum, x) => sum + x.e.points, 0);
  return { ...month, deducted, net: month.earned + deducted, spent, balance: allTime - spent };
}

// All clinics by this month's points (earned minus deductions), highest first; equal points share a rank
function leaderboard() {
  const rows = CLINICS.map((c) => ({ code: c.code, name: c.name, points: clinicPoints(c.code).net }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  rows.forEach((r) => { r.rank = 1 + rows.filter((x) => x.points > r.points).length; });
  return rows;
}

// When each clinic last logged a bag, and whether that's longer ago than INACTIVITY_DAYS (null = never logged)
function clinicActivity(code, now = Date.now()) {
  let last = null;
  for (const b of db.bags) {
    if (b.clinic !== code || Date.parse(b.loggedAt) > now) continue; // sample data can hold later clock times
    if (!last || b.loggedAt > last) last = b.loggedAt;
  }
  const days = last == null ? null : Math.floor((now - Date.parse(last)) / 86400000);
  return { last, days, inactive: last == null || now - Date.parse(last) > INACTIVITY_DAYS * 86400000 };
}
const inactiveClinics = () => CLINICS.map((c) => ({ ...c, ...clinicActivity(c.code) })).filter((c) => c.inactive)
  .sort((a, b) => (b.days ?? Infinity) - (a.days ?? Infinity)); // never logged first, then the longest quiet
