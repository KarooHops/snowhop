// SnowHop demo mode: stands in for SnowHop's server so visitors can try every step of the site.
// Bookings, payments, credit, accounts and chat messages stay in this browser tab. Nothing is sent or charged.
// Demo mode is on while config.js has `demo: true`.
(() => {
  const cfg = window.SNOWHOP || {};
  const TZ = cfg.timezone || "America/Denver";
  const OWNER = cfg.ownerName || "Ethan";
  const SET = {
    cap: 10, daysAhead: 14, cutoffHour: 24, lateHour: 18, lateMultiplier: 2, radius: 10, cancelHours: 12,
    pricing: { base: 30, corner: 40, next_day_discount: 10 },
    packs: [{ pay: 50, credit: 60 }, { pay: 75, credit: 90 }, { pay: 100, credit: 120 }, { pay: 200, credit: 250 }],
    saltNotice: "Salt can harm grass, plants and concrete less than a year old. Ethan keeps salt off lawn edges, but some can still reach nearby grass.",
  };
  const REPLY = "This is a demo, so your message didn't go to anyone. On your own KarooHops site, questions like this come straight to you, and you answer them from your owner page.";

  const KEY = "snowhop:demo";
  const saved = (() => { try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (e) { return null; } })();
  const st = Object.assign({ customers: {}, tokens: {}, bookings: [], credit: {}, threads: [] }, saved || {});
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* private mode: keep it in memory */ } };
  let realReviews = null;

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const nowIso = () => new Date().toISOString();
  const money = (n) => "$" + (Number(n) || 0);
  const fmtPhone = (d) => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  const ok = (d) => Object.assign({ ok: true }, d || {});
  const fail = (error, message) => ({ ok: false, error, message });

  // ---- dates, in the business's time zone ----
  const parts = (d) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).map((p) => [p.type, p.value]));
  const today = () => { const p = parts(new Date()); return `${p.year}-${p.month}-${p.day}`; };
  const hourNow = () => Number(parts(new Date()).hour) % 24;
  const addDays = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  function midnight(day) { // the moment a day starts in the business's time zone
    const [y, m, d] = day.split("-").map(Number), want = Date.UTC(y, m - 1, d);
    let t = want;
    for (let i = 0; i < 3; i++) { const p = parts(new Date(t)); t -= Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - want; }
    return t;
  }
  const cancelUntil = (day) => new Date(midnight(day) - SET.cancelHours * 3600e3).toISOString();

  // ---- credit ----
  const balance = (ph) => (st.credit[ph] || []).reduce((s, r) => s + r.amount, 0);
  const usedTotal = (ph) => (st.credit[ph] || []).filter((r) => r.kind === "used").reduce((s, r) => s - r.amount, 0);
  function ledger(ph, amount, kind, b, note, paid) {
    (st.credit[ph] = st.credit[ph] || []).push({ amount, kind, at: nowIso(), booking: b ? b.id : null, date: b ? b.date : null, note: note || null, paid: paid == null ? null : paid });
  }
  const back = (b) => Math.max((b.credit_used || 0) + (b.pay_status === "paid" ? (b.paid_amount || 0) : 0), 0);
  const due = (b) => (b.pay_status === "paid" ? 0 : Math.max(b.price - (b.credit_used || 0), 0));
  const unpaid = (b) => (b.pay_status || "unpaid") === "unpaid";
  function applyCredit(ph) { // credit pays for upcoming unpaid visits, earliest first
    let bal = balance(ph), used = 0;
    const list = st.bookings.filter((b) => b.phone === ph && b.status === "booked" && unpaid(b) && b.date >= today()).sort((a, b) => (a.date < b.date ? -1 : 1));
    for (const b of list) {
      if (bal <= 0) break;
      const use = Math.min(bal, b.price - (b.credit_used || 0));
      if (use <= 0) continue;
      ledger(ph, -use, "used", b);
      b.credit_used = (b.credit_used || 0) + use;
      if (b.credit_used >= b.price) Object.assign(b, { pay_status: "paid", paid_amount: 0, pay_plan: null });
      bal -= use; used += use;
    }
    return used;
  }
  const busyDay = (ph, day) => st.bookings.some((b) => b.phone === ph && b.date === day && b.status !== "canceled");
  function reprice(ph, day) { // next-day discount follows the visit before it
    for (const b of st.bookings) {
      if (b.phone !== ph || b.date !== day || b.status !== "booked" || !unpaid(b)) continue;
      const off = busyDay(ph, addDays(day, -1)) ? SET.pricing.next_day_discount : 0, price = (b.base_price - off) * (b.multiplier || 1);
      const extra = Math.max((b.credit_used || 0) - price, 0);
      if (extra) ledger(ph, extra, "returned", b, "Visit price went down");
      Object.assign(b, { discount: off, price, credit_used: (b.credit_used || 0) - extra });
      if (b.credit_used && b.credit_used >= price) Object.assign(b, { pay_status: "paid", paid_amount: 0, pay_plan: null });
    }
    applyCredit(ph);
  }

  // ---- views ----
  const taken = (day) => st.bookings.filter((b) => b.date === day && b.status !== "canceled").length;
  function availability() {
    const t = today(), hr = hourNow(), days = [];
    for (let n = 0; n <= SET.daysAhead; n++) {
      const date = addDays(t, n), left = Math.max(SET.cap - taken(date), 0), closed = n === 0 && hr >= SET.cutoffHour;
      days.push({ date, left, open: left > 0 && !closed, closed, late: n === 0 && !closed && hr >= SET.lateHour, cancel_until: cancelUntil(date) });
    }
    return { today: t, cap: SET.cap, cutoff_hour: SET.cutoffHour, late_hour: SET.lateHour, late_multiplier: SET.lateMultiplier, salt_notice: SET.saltNotice,
      radius_miles: SET.radius, payments_enabled: true, cancel_hours_before: SET.cancelHours, credit_packs: SET.packs, pricing: SET.pricing, days };
  }
  const visit = (b) => ({ id: b.id, date: b.date, price: b.price, base_price: b.base_price, discount: b.discount, multiplier: b.multiplier || 1, corner_lot: b.corner_lot,
    salt: b.salt, notes: b.notes, status: b.status, pay_choice: b.pay_choice || "later", pay_plan: b.pay_plan || null, pay_status: b.pay_status || "unpaid",
    paid_method: b.paid_method || null, paid_amount: b.paid_amount == null ? null : b.paid_amount, paid_online: !!b.paid_online, credit_used: b.credit_used || 0,
    cancel_credit: b.cancel_credit || 0, due: due(b), back: back(b), cancel_until: cancelUntil(b.date) });
  function me(ph) {
    const c = st.customers[ph], mine = st.bookings.filter((b) => b.phone === ph).sort((a, b) => (a.date < b.date ? 1 : -1));
    return {
      today: today(),
      customer: { name: c.name, phone: c.phone, street: c.street, city: c.city, zip: c.zip, corner_lot: c.corner_lot },
      credit: balance(ph),
      credit_log: (st.credit[ph] || []).slice().reverse().slice(0, 12).map((r) => ({ amount: r.amount, kind: r.kind, at: r.at, date: r.date })),
      bookings: mine.map(visit),
      review: c.review || null,
      can_review: mine.some((b) => b.status !== "canceled" && b.date <= today()),
    };
  }
  function withReview(rv) { // the visitor's review, shown only to them, on top of the real reviews
    const base = realReviews || { count: 0, average: 0, stars: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }, last_season: 0, items: [] };
    const stars = Object.assign({}, base.stars), count = (base.count || 0) + 1;
    stars[rv.rating] = (stars[rv.rating] || 0) + 1;
    return Object.assign({}, base, { count, stars, average: Math.round((((base.average || 0) * (base.count || 0) + rv.rating) / count) * 10) / 10,
      items: (rv.comment ? [{ name: rv.name, rating: rv.rating, comment: rv.comment, date: today() }] : []).concat(base.items || []) });
  }
  function session(ph) { const tok = "demo_" + uid().replace(/-/g, ""); st.tokens[tok] = ph; return tok; }

  // ---- support chat ----
  function thread(t, seen) {
    const unread = t.messages.filter((m) => m.from === "owner" && (!t.seen_at || m.at > t.seen_at)).length;
    const v = { id: t.id, name: t.name, phone: t.phone, status: t.status, created_at: t.created_at, has_account: !!t.customer, unread, messages: t.messages.map((m) => Object.assign({}, m)) };
    if (seen) t.seen_at = nowIso();
    return v;
  }
  function addMessage(t, body) {
    t.messages.push({ from: "customer", body, at: nowIso() });
    t.status = "open";
    if (!t.replied) { t.replied = true; t.messages.push({ from: "owner", body: REPLY, at: new Date(Date.now() + 1000).toISOString() }); }
  }
  function support(a, body) {
    const msg = typeof body.message === "string" ? body.message.trim() : "";
    const who = st.tokens[body.token];
    if (a === "support_start") {
      if (body.company) return fail("bad_request", "Something was missing. Please try again.");
      if (!msg || msg.length > 1000) return fail("message", "Type your question (up to 1,000 characters).");
      const mine = who ? st.threads.filter((t) => t.customer === who) : [];
      if (mine.length) { const t = mine[mine.length - 1]; addMessage(t, msg); return ok({ thread: thread(t, true) }); }
      let name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 80), phone = String(body.phone || "").replace(/\D/g, "");
      if (who) { name = name || st.customers[who].name; phone = phone || st.customers[who].phone; }
      if (!name) return fail("name", "Add your name.");
      if (phone.length !== 10) return fail("phone", "Enter a 10-digit phone number.");
      const t = { id: uid(), key: "chat_" + uid().replace(/-/g, ""), customer: who || null, name, phone, status: "open", created_at: nowIso(), messages: [] };
      addMessage(t, msg);
      st.threads.push(t);
      return ok({ chat: t.key, thread: thread(t, true) });
    }
    const t = body.chat ? st.threads.find((x) => x.key === body.chat) : who ? st.threads.filter((x) => x.customer === who).pop() : null;
    if (!t) return fail("not_found", "We couldn't find that conversation.");
    if (a === "support_get") return ok({ thread: thread(t, body.seen === true) });
    if (!msg || msg.length > 1000) return fail("message", "Type your question (up to 1,000 characters).");
    addMessage(t, msg);
    return ok({ thread: thread(t, true) });
  }

  // ---- the stand-in server ----
  function handle(a, body, url) {
    const fn = /snow-credit/.test(url) ? "credit" : "book";
    if (a === "support_start" || a === "support_get" || a === "support_send") return support(a, body);
    if (a === "availability") return ok(availability());
    if (a === "check_area") return ok({ status: "ok", miles: 3, radius: SET.radius });
    if (a === "signup") {
      const ph = String(body.phone || "");
      if (st.customers[ph]) return fail("phone_taken", "That number already has an account. Sign in with your PIN.");
      st.customers[ph] = { name: String(body.name || ""), phone: ph, street: body.street, city: body.city, zip: body.zip, corner_lot: !!body.corner, pin: String(body.pin || "") };
      return ok(Object.assign({ token: session(ph) }, me(ph)));
    }
    if (a === "login") {
      const c = st.customers[String(body.phone || "")];
      if (!c || c.pin !== String(body.pin || "")) return fail("bad_login", "That phone number and PIN don't match. Demo accounts only last in the browser tab where you made them.");
      return ok(Object.assign({ token: session(c.phone) }, me(c.phone)));
    }
    if (a === "logout") { delete st.tokens[body.token]; return ok(); }
    const who = st.tokens[body.token];
    if (!who || !st.customers[who]) return fail("signed_out", "Please sign in again.");
    const c = st.customers[who];
    if (a === "me") return ok(me(who));
    if (a === "update_me") {
      Object.assign(c, { name: body.name, street: body.street, city: body.city, zip: body.zip, corner_lot: !!body.corner });
      return ok(me(who));
    }
    if (a === "book") {
      const day = body.date, slot = availability().days.find((x) => x.date === day);
      if (!slot) return fail("bad_date", "Pick a day in the next two weeks.");
      if (body.salt && !body.salt_ack) return fail("salt_ack", "Check the box to confirm you've read the salt note.");
      if (busyDay(who, day)) return fail("already_booked", "You're already booked that day.");
      const choice = body.pay_choice || "later", plan = choice === "now" ? null : body.pay_plan || null;
      if (!["now", "later"].includes(choice) || ![null, "cash", "tap", "cashapp", "online"].includes(plan)) return fail("pay_choice", "Pick how you'd like to pay.");
      if (!slot.open) return fail("full", "That day just filled up. Pick another day.");
      const base = c.corner_lot ? SET.pricing.corner : SET.pricing.base, off = busyDay(who, addDays(day, -1)) ? SET.pricing.next_day_discount : 0;
      const mult = slot.late ? SET.lateMultiplier : 1, total = (base - off) * mult;
      if (Number.isInteger(body.quoted_price) && body.quoted_price !== total) return fail("price_changed", "The price just changed. Check the new total and tap Book again.");
      const b = { id: uid(), phone: who, date: day, base_price: base, discount: off, price: total, multiplier: mult, corner_lot: c.corner_lot, salt: !!body.salt,
        notes: body.notes || null, status: "booked", pay_choice: choice, pay_plan: plan, pay_status: "unpaid", paid_method: null, paid_online: false,
        name: c.name, street: c.street, city: c.city, zip: c.zip, credit_used: 0, cancel_credit: 0 };
      st.bookings.push(b);
      const use = Math.min(Math.max(balance(who), 0), total);
      if (use) {
        ledger(who, -use, "used", b);
        b.credit_used = use;
        if (use >= total) Object.assign(b, { pay_status: "paid", paid_amount: 0, pay_choice: "later", pay_plan: null });
      }
      reprice(who, day);
      reprice(who, addDays(day, 1));
      return ok(Object.assign({ booking: Object.assign(visit(b), { phone: who, name: b.name, street: b.street, city: b.city, zip: b.zip }) }, me(who)));
    }
    if (a === "pay") {
      const b = st.bookings.find((x) => x.id === body.id && x.phone === who);
      if (!b) return fail("not_found", "We couldn't find that.");
      if (b.status === "canceled") return fail("not_payable", "This visit can't be paid online.");
      const amount = due(b);
      if (!unpaid(b) || amount <= 0) return fail("already_paid", "This visit is already paid.");
      Object.assign(b, { pay_status: "paid", paid_method: "card", paid_online: true, paid_amount: amount, paid_at: nowIso(), pay_plan: null });
      return ok(Object.assign({ demo: true, booking: Object.assign(visit(b), { phone: who, name: b.name, street: b.street, city: b.city, zip: b.zip }),
        notice: `Demo: paid ${money(amount)}. Real customers pay on Stripe's secure checkout page here. Nothing was charged.` }, me(who)));
    }
    if (a === "buy_credit") {
      if (fn !== "credit") return fail("bad_request", "Something was missing. Please try again.");
      const pk = SET.packs.find((x) => x.pay === body.pay);
      if (!pk) return fail("pack", "Pick one of the credit packs.");
      ledger(who, pk.credit, "purchase", null, `Bought $${pk.credit} credit for $${pk.pay}`, pk.pay);
      const used = applyCredit(who);
      return ok(Object.assign({ demo: true, purchase: { amount: pk.credit, paid: pk.pay },
        notice: `Demo: ${money(pk.credit)} credit added${used ? ", and it's already paying for your upcoming visits" : ""}. Real customers pay ${money(pk.pay)} on Stripe's secure checkout page. Nothing was charged.` }, me(who)));
    }
    if (a === "credit_confirm") return ok(Object.assign({ purchase: null }, me(who)));
    if (a === "cancel") {
      const b = st.bookings.find((x) => x.id === body.id && x.phone === who);
      if (!b || b.status === "canceled") return fail("not_found", "We couldn't find that.");
      if (b.status !== "booked") return fail("past", `That visit can't be changed online. Call or text ${OWNER}.`);
      if (Date.now() >= Date.parse(cancelUntil(b.date))) return fail("cancel_closed", `It's too late to cancel this visit online. Call or text ${OWNER} at ${fmtPhone(String(cfg.phone || "3039939110"))}.`);
      const credited = back(b);
      if (credited) ledger(who, credited, "cancel", b);
      Object.assign(b, { status: "canceled", canceled_by: "customer", cancel_credit: credited });
      const before = usedTotal(who);
      reprice(who, addDays(b.date, 1));
      return ok(Object.assign({ credited, applied: Math.min(usedTotal(who) - before, credited) }, me(who)));
    }
    if (a === "review") {
      if (!me(who).can_review) return fail("not_eligible", "Reviews open up after your first visit.");
      const p = c.name.trim().split(/\s+/), rating = Math.max(1, Math.min(5, Math.round(Number(body.rating) || 5)));
      c.review = { rating, comment: String(body.comment || "").trim() || null, name: p[0] + (p.length > 1 ? ` ${p[p.length - 1][0].toUpperCase()}.` : ""), visible: true };
      return ok(Object.assign({ reviews: withReview(c.review) }, me(who)));
    }
    return fail("bad_request", "Something was missing. Please try again.");
  }

  window.SnowHopDemo = {
    async call(action, data, url) {
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 250)); // feels like a real server
      const res = handle(action, data || {}, String(url || ""));
      save();
      return JSON.parse(JSON.stringify(res));
    },
    setReviews(r) { realReviews = r; },
  };
})();
