import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireDm, requireMember } from "./auth";
import {
  CalendarSettings,
  DEFAULT_CALENDAR,
  reconcile,
} from "../components/calendarModel";

/**
 * The campaign's calendar.
 *
 * One document per campaign, and unlike the Notebook it is shared: the
 * date is a fact about the world, not a private note, so every member
 * reads the same one and only the DM writes it. Nothing here is
 * DM-only — there is no secret half of a date — so there is no output
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
