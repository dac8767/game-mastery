import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireDm, requireMember } from "./auth";

/** A campaign with more scheduled events than this has a different problem. */
const MAX_EVENTS = 500;
import {
  CalendarSettings,
  DEFAULT_CALENDAR,
  reconcile,
} from "../components/calendarModel";
import {
  DEFAULT_WINDOW,
  SCHEDULE_LIMITS,
  reconcileWindow,
  slotsOf,
  slotKey,
} from "../components/scheduleModel";

/**
 * The campaign's calendar.
 *
 * One document per campaign, and unlike the Notebook it is shared: the
 * date is a fact about the world, not a private note, so every member
 * reads the same one and only the GM writes it. Nothing here is
 * GM-only — there is no secret half of a date — so there is no output
 * shaping, just the authority check on the writes.
 *
 * The rules live in components/calendarModel.ts and are IMPORTED rather
 * than restated here. Convex bundles what it imports, so a pure,
 * dependency-free module can be shared across the boundary — and it has
 * to be, because "days per week" and "the day names" describing the
 * same thing is exactly the pair that drifts when two copies of the
 * reconciliation exist. The client clamp is so the form behaves; this
 * one runs because a mutation is a public API and nothing stops a
 * caller sending thirty thousand days per week.
 */

export const getCalendar = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.campaignId);
    const row = await ctx.db
      .query("calendars")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .unique();

    if (!row) return { ...DEFAULT_CALENDAR, exists: false };

    // Reconciled on the way out too: a row written before a limit
    // changed, or edited by hand in the dashboard, still has to render.
    return {
      ...reconcile({
        daysPerWeek: row.daysPerWeek,
        dayNames: row.dayNames,
        daysPerMonth: row.daysPerMonth,
        monthsPerYear: row.monthsPerYear,
        monthNames: row.monthNames,
        currentYear: row.currentYear,
        currentMonth: row.currentMonth,
        currentDay: row.currentDay,
        ageName: row.ageName,
        eraAbbr: row.eraAbbr,
      }),
      exists: true,
    };
  },
});

export const saveCalendar = mutation({
  args: {
    campaignId: v.id("campaigns"),
    daysPerWeek: v.number(),
    dayNames: v.array(v.string()),
    daysPerMonth: v.number(),
    monthsPerYear: v.number(),
    monthNames: v.array(v.string()),
    currentYear: v.number(),
    currentMonth: v.number(),
    currentDay: v.number(),
    ageName: v.optional(v.string()),
    eraAbbr: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);

    const { campaignId, ...settings } = args;
    const clean = reconcile(settings as CalendarSettings);
    // One more bound the shared model has no reason to care about: a
    // name is a label, not a document.
    const doc = {
      campaignId,
      ...clean,
      dayNames: clean.dayNames.map((n) => n.slice(0, 40)),
      monthNames: clean.monthNames.map((n) => n.slice(0, 40)),
      ageName: (clean.ageName ?? "").slice(0, 60),
      eraAbbr: (clean.eraAbbr ?? "").slice(0, 12),
    };

    const existing = await ctx.db
      .query("calendars")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return;
    }
    await ctx.db.insert("calendars", doc);
  },
});

/**
 * Move the date without touching the shape of the calendar.
 *
 * Separate from saveCalendar because advancing a day at the table is
 * the common action and should not require sending — or being able to
 * accidentally rewrite — every month name.
 */
export const setCurrentDate = mutation({
  args: {
    campaignId: v.id("campaigns"),
    year: v.number(),
    month: v.number(),
    day: v.number(),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);

    const existing = await ctx.db
      .query("calendars")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .unique();

    // No row yet means the calendar is still the defaults; seeding it
    // here is what gives the date somewhere to live.
    const shape: CalendarSettings = existing
      ? {
          daysPerWeek: existing.daysPerWeek,
          dayNames: existing.dayNames,
          daysPerMonth: existing.daysPerMonth,
          monthsPerYear: existing.monthsPerYear,
          monthNames: existing.monthNames,
          ageName: existing.ageName,
          eraAbbr: existing.eraAbbr,
          currentYear: args.year,
          currentMonth: args.month,
          currentDay: args.day,
        }
      : {
          ...DEFAULT_CALENDAR,
          currentYear: args.year,
          currentMonth: args.month,
          currentDay: args.day,
        };

    const clean = reconcile(shape);
    const patch = {
      currentYear: clean.currentYear,
      currentMonth: clean.currentMonth,
      currentDay: clean.currentDay,
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return;
    }
    await ctx.db.insert("calendars", { campaignId: args.campaignId, ...clean });
  },
});

// ---------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------

const repeatValidator = v.union(
  v.literal("once"),
  v.literal("weekly"),
  v.literal("monthly"),
  v.literal("yearly"),
  v.literal("everyNDays")
);

/**
 * Every event in the campaign, unexpanded.
 *
 * A repeating event is one row plus a rule, so the browser decides what
 * lands on a given day — see components/calendarModel.ts. Sending the
 * rules rather than the occurrences is also what makes flicking through
 * months free: no query per month, and no way for the grid to disagree
 * with itself about a year it has not fetched.
 */
export const listEvents = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.campaignId);
    return await ctx.db
      .query("calendarEvents")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(MAX_EVENTS);
  },
});

/** GM: put something on a day, or change it. */
export const saveEvent = mutation({
  args: {
    eventId: v.optional(v.id("calendarEvents")),
    campaignId: v.id("campaigns"),
    title: v.string(),
    notes: v.optional(v.string()),
    year: v.number(),
    month: v.number(),
    day: v.number(),
    repeat: repeatValidator,
    intervalDays: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    const { eventId, ...fields } = args;

    const title = fields.title.trim();
    if (!title) throw new Error("An event needs a name");

    // An interval is only meaningful for the rule that reads it, and a
    // zero would either repeat every day or divide by nothing.
    const intervalDays =
      fields.repeat === "everyNDays"
        ? Math.max(1, Math.round(Number(fields.intervalDays) || 1))
        : undefined;

    const doc = { ...fields, title, intervalDays };

    if (eventId) {
      const existing = await ctx.db.get(eventId);
      if (!existing || existing.campaignId !== args.campaignId) {
        throw new Error("Event not found in this campaign");
      }
      await ctx.db.replace(eventId, doc);
      return eventId;
    }
    return await ctx.db.insert("calendarEvents", doc);
  },
});

export const deleteEvent = mutation({
  args: { eventId: v.id("calendarEvents") },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event) return;
    await requireDm(ctx, event.campaignId);
    await ctx.db.delete(args.eventId);
  },
});

// ---------------------------------------------------------------------
// The Scheduler
// ---------------------------------------------------------------------
//
// Real-world dates, in the file about in-world ones. They are together
// because convex/_generated/api.d.ts is committed and can only be
// rebuilt by `npx convex dev`, which a sandboxed session cannot reach —
// so a NEW module here would leave the checked-in codegen stale and the
// generated-api guard red until someone with network access ran it. The
// two halves share nothing but the file: a session is scheduled on the
// 25th of August, never on the 10th of Autumn.

/**
 * When are we playing next.
 *
 * The GM offers days and hours; everyone marks the cells that work.
 * Nothing here is GM-only in the sense the NPC screen means it — the
 * whole point is that the group sees each other's answers — so there
 * is no output shaping, only the authority check on who may move the
 * goalposts.
 *
 * The window's rules live in components/scheduleModel.ts and are
 * imported rather than restated, for the same reason the calendar's
 * are: two copies of "an end before the start is not a grid" drift.
 */

/** A group larger than this has a different problem than scheduling. */
const MAX_RESPONDENTS = 60;

export const getSchedule = query({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    const { userId, isDm } = await requireMember(ctx, args.campaignId);
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new Error("Campaign not found");

    const row = await ctx.db
      .query("schedules")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .unique();

    const window = reconcileWindow(
      row
        ? {
            days: row.days,
            startMinute: row.startMinute,
            endMinute: row.endMinute,
            slotMinutes: row.slotMinutes,
          }
        : DEFAULT_WINDOW
    );

    // Everyone who could answer, whether or not they have. "Who hasn't
    // put their times in" is half of what the tool is for, and it
    // cannot be answered from the rows that exist.
    const members = await ctx.db
      .query("campaignMembers")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(MAX_RESPONDENTS);

    const answers = await ctx.db
      .query("availability")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(MAX_RESPONDENTS);
    const byUser = new Map(answers.map((a) => [a.userId, a]));

    // Only cells still inside the window count. A day the GM withdrew
    // leaves everyone's marks on it behind, and counting them would
    // report agreement on a date nobody is being offered.
    const live = new Set<string>();
    for (const day of window.days) {
      for (const minute of slotsOf(window)) live.add(slotKey(day, minute));
    }

    const respondents = [];
    for (const m of members) {
      const person = await ctx.db.get(m.userId);
      const answer = byUser.get(m.userId);
      respondents.push({
        userId: m.userId,
        name: person?.name ?? person?.email ?? "Someone",
        isDm: campaign.dmId === m.userId,
        answered: Boolean(answer),
        slots: (answer?.slots ?? []).filter((s) => live.has(s)),
      });
    }

    return {
      ...window,
      isDm,
      youId: userId,
      respondents,
    };
  },
});

/** GM: choose the days and the hours on offer. */
export const setWindow = mutation({
  args: {
    campaignId: v.id("campaigns"),
    days: v.array(v.string()),
    startMinute: v.number(),
    endMinute: v.number(),
    slotMinutes: v.number(),
  },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);

    const { campaignId, ...w } = args;
    const clean = reconcileWindow(w);

    const existing = await ctx.db
      .query("schedules")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, clean);
      return;
    }
    await ctx.db.insert("schedules", { campaignId, ...clean });
  },
});

/**
 * Anyone: replace your own availability.
 *
 * Yours and only yours — the userId comes from the session rather than
 * the arguments, so there is no shape of call that marks someone
 * else's evening free.
 *
 * An empty list is stored rather than deleted. "None of these work"
 * and "hasn't answered" are different answers, and the second is the
 * one the GM chases.
 */
export const setAvailability = mutation({
  args: {
    campaignId: v.id("campaigns"),
    slots: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireMember(ctx, args.campaignId);

    const row = await ctx.db
      .query("schedules")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .unique();
    if (!row) throw new Error("No days have been offered yet.");

    const window = reconcileWindow({
      days: row.days,
      startMinute: row.startMinute,
      endMinute: row.endMinute,
      slotMinutes: row.slotMinutes,
    });

    // Bounded by the grid rather than by a number: the only slots that
    // can be stored are the ones the GM is actually offering, so a
    // hand-made call cannot fill the table with keys nothing renders.
    const live = new Set<string>();
    for (const day of window.days) {
      for (const minute of slotsOf(window)) live.add(slotKey(day, minute));
    }
    const slots = [...new Set(args.slots)].filter((s) => live.has(s));

    const existing = await ctx.db
      .query("availability")
      .withIndex("by_campaign_user", (q) =>
        q.eq("campaignId", args.campaignId).eq("userId", userId)
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { slots });
      return;
    }
    await ctx.db.insert("availability", {
      campaignId: args.campaignId,
      userId,
      slots,
    });
  },
});

/** GM: clear everyone's answers, to ask again about new days. */
export const clearAllAvailability = mutation({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, args) => {
    await requireDm(ctx, args.campaignId);
    const rows = await ctx.db
      .query("availability")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(SCHEDULE_LIMITS.days * 4);
    for (const row of rows) await ctx.db.delete(row._id);
  },
});
