import { describe, expect, it } from "vitest";
import {
  compareHours,
  describeWeek,
  disagreements,
  fromCompact,
  fromSchemaOrg,
  fromText,
  readRange,
  toHoursWeek,
} from "./hours.ts";

const range = (a: string, b: string) => readRange(a, b);

describe("reading a time range the way a restaurant writes it", () => {
  it("takes the close's meridiem unless that would open after the close", () => {
    expect(range("5", "10pm")).toEqual({ interval: ["17:00", "22:00"], inferred: false });
    expect(range("11", "3pm")).toEqual({ interval: ["11:00", "15:00"], inferred: false });
    expect(range("12", "3pm")).toEqual({ interval: ["12:00", "15:00"], inferred: false });
    expect(range("10", "2am")).toEqual({ interval: ["22:00", "02:00"], inferred: false });
    expect(range("6", "11am")).toEqual({ interval: ["06:00", "11:00"], inferred: false });
  });
  it("closes in the evening after a morning opening", () => {
    expect(range("11am", "10")?.interval).toEqual(["11:00", "22:00"]);
    expect(range("9am", "12")?.interval).toEqual(["09:00", "12:00"]);
    expect(range("5pm", "12")?.interval).toEqual(["17:00", "00:00"]);
    expect(range("11:30 a.m.", "2:30 p.m.")?.interval).toEqual(["11:30", "14:30"]);
    expect(range("noon", "midnight")?.interval).toEqual(["12:00", "00:00"]);
  });
  it("reads a 24-hour clock as written", () => {
    expect(range("17:00", "23:00")).toEqual({ interval: ["17:00", "23:00"], inferred: false });
    expect(range("09:30", "24:00")?.interval).toEqual(["09:30", "00:00"]);
  });
  it("guesses with no meridiem at all, and says it guessed", () => {
    expect(range("11", "9")).toEqual({ interval: ["11:00", "21:00"], inferred: true });
    expect(range("5", "10")).toEqual({ interval: ["17:00", "22:00"], inferred: true });
    expect(range("10", "11")).toEqual({ interval: ["10:00", "23:00"], inferred: true });
    expect(range("7", "3")).toEqual({ interval: ["07:00", "15:00"], inferred: true });
  });
});

describe("OpenStreetMap and schema.org's compact hours", () => {
  it("reads rules, lists, split days and closures; a later rule overrides", () => {
    expect(fromCompact("Mo-Th 11:00-23:00; Fr,Sa 11:00-01:00; Su off")?.week).toEqual({
      mon: [["11:00", "23:00"]],
      tue: [["11:00", "23:00"]],
      wed: [["11:00", "23:00"]],
      thu: [["11:00", "23:00"]],
      fri: [["11:00", "01:00"]],
      sat: [["11:00", "01:00"]],
      sun: [],
    });
    expect(fromCompact("Mo-Fr 11:30-14:30,17:00-22:00")?.week["wed"]).toEqual([
      ["11:30", "14:30"],
      ["17:00", "22:00"],
    ]);
    expect(fromCompact("Mo-Su 10:00-20:00; Su 12:00-18:00")?.week["sun"]).toEqual([
      ["12:00", "18:00"],
    ]);
    expect(fromCompact("24/7")?.week["tue"]).toEqual([["00:00", "00:00"]]);
    // a quoted comment is skipped, and the later rule still replaces the earlier one
    expect(fromCompact('Mo-Su 08:00-11:00 "breakfast"; Mo-Su 11:30-23:00')?.week["mon"]).toEqual([
      ["11:30", "23:00"],
    ]);
    expect(fromCompact("Fr-Mo 17:00-24:00")?.week).toMatchObject({
      fri: [["17:00", "00:00"]],
      mon: [["17:00", "00:00"]],
    });
  });
  it("reads a comma after a time as another rule, and a comma between days as a list", () => {
    expect(describeWeek(fromCompact("Mo-Fr 11:00-21:00, Sa-Su 12:00-20:00")!.week)).toBe(
      "Mon–Fri 11:00–21:00; Sat–Sun 12:00–20:00",
    );
    // an additional rule adds to the days it shares with an earlier one
    expect(fromCompact("Mo-Fr 08:00-12:00, We 14:00-18:00")!.week["wed"]).toEqual([
      ["08:00", "12:00"],
      ["14:00", "18:00"],
    ]);
    expect(describeWeek(fromSchemaOrg({ openingHours: "Tu,Th 16:00-20:00" })!.week)).toBe(
      "Tue 16:00–20:00; Thu 16:00–20:00",
    );
    // Squarespace leaves a comma where each empty day would be
    const squarespace = ", Tu 16:00-21:00, We 16:00-21:00, Sa 16:00-21:00, ";
    expect(describeWeek(fromSchemaOrg({ openingHours: squarespace })!.week)).toBe(
      "Tue–Wed 16:00–21:00; Sat 16:00–21:00",
    );
  });
  it("reads the week and sets public holidays aside", () => {
    expect(describeWeek(fromCompact("Mo-Fr 09:00-17:00; PH off")!.week)).toBe(
      "Mon–Fri 09:00–17:00",
    );
    expect(describeWeek(fromCompact("Mo-Sa 10:00-21:00; Su,PH 11:00-18:00")!.week)).toBe(
      "Mon–Sat 10:00–21:00; Sun 11:00–18:00",
    );
  });
  it("declines what it cannot fully read instead of guessing", () => {
    expect(fromCompact("Jan-Mar Mo-Fr 10:00-16:00")).toBeUndefined();
    expect(fromCompact("Mo-Fr sunrise-sunset")).toBeUndefined();
  });
});

describe("schema.org JSON-LD", () => {
  it("prefers openingHoursSpecification, and reads 00:00 to 00:00 as closed", () => {
    const hours = fromSchemaOrg({
      "@type": "Restaurant",
      openingHoursSpecification: [
        {
          "@type": "OpeningHoursSpecification",
          dayOfWeek: ["https://schema.org/Monday", "https://schema.org/Tuesday"],
          opens: "00:00",
          closes: "00:00",
        },
        { dayOfWeek: "Wednesday", opens: "17:00:00", closes: "22:00:00" },
        { dayOfWeek: ["Friday", "Saturday"], opens: "17:00", closes: "23:30" },
      ],
      openingHours: "Mo-Su 09:00-17:00",
    });
    expect(hours).toMatchObject({ from: "jsonld", inferred: false });
    expect(hours?.week).toEqual({
      mon: [],
      tue: [],
      wed: [["17:00", "22:00"]],
      fri: [["17:00", "23:30"]],
      sat: [["17:00", "23:30"]],
    });
  });
  it("reads openingHours strings, one rule per string", () => {
    expect(
      fromSchemaOrg({ openingHours: ["Tu-Th 16:00-21:00", "Fr-Sa 16:00-22:00"] })?.week,
    ).toEqual({
      tue: [["16:00", "21:00"]],
      wed: [["16:00", "21:00"]],
      thu: [["16:00", "21:00"]],
      fri: [["16:00", "22:00"]],
      sat: [["16:00", "22:00"]],
    });
    expect(fromSchemaOrg({ name: "No hours" })).toBeUndefined();
  });
});

describe("hours written in a page's text", () => {
  it("reads a footer schedule, a day per line or a range per line", () => {
    const [found] = fromText(
      "Hours\nMon–Thu 11am–10pm\nFri–Sat 11am–11pm\nSun 12–9pm\n© 2026 Toscana",
    );
    expect(found).toMatchObject({ label: "Hours", inferred: false });
    expect(describeWeek(found!.week)).toBe(
      "Mon–Thu 11:00–22:00; Fri–Sat 11:00–23:00; Sun 12:00–21:00",
    );
  });
  it("pairs days on one line with times on the next, and reads closed days and lists", () => {
    const [found] = fromText(
      "Monday - Thursday\n11:30 AM - 9:00 PM\nFriday & Saturday\n11:30 AM - 10:00 PM\nSunday\nClosed",
    );
    expect(describeWeek(found!.week)).toBe("Mon–Thu 11:30–21:00; Fri–Sat 11:30–22:00; Sun closed");
  });
  it("keeps lunch and dinner as two intervals", () => {
    const [found] = fromText("Lunch: Mon-Fri 11:30-2:30 | Dinner: Mon-Sat 5-10pm");
    expect(found!.week["tue"]).toEqual([
      ["11:30", "14:30"],
      ["17:00", "22:00"],
    ]);
    expect(found!.week["sat"]).toEqual([["17:00", "22:00"]]);
    expect(found!.inferred).toBe(true);
  });
  it("reads a schedule written as one long paragraph, ignoring last-seating notes", () => {
    const [found] = fromText(
      "Hours of Operation:\nDinner: Tuesday, Wednesday and Thursday 5pm to 9pm (Last seating 8:45PM) / Friday and Saturday 5pm to 10pm (Last seating 9:45PM) / Sunday 5pm to 9pm (Last seating 8:45PM)",
    );
    expect(found).toMatchObject({ label: "Hours of Operation:", inferred: false });
    expect(describeWeek(found!.week)).toBe(
      "Tue–Thu 17:00–21:00; Fri–Sat 17:00–22:00; Sun 17:00–21:00",
    );
  });

  it("reads daily schedules, and labels each run of hours with the line above it", () => {
    expect(describeWeek(fromText("Open daily 7am–3pm")[0]!.week)).toBe("Mon–Sun 07:00–15:00");
    const both = fromText("Hours\nMon-Fri 11am-9pm\nHappy Hour\nMon-Fri 4-6pm");
    expect(both.map((hours) => [hours.label, describeWeek(hours.week)])).toEqual([
      ["Hours", "Mon–Fri 11:00–21:00"],
      ["Happy Hour", "Mon–Fri 16:00–18:00"],
    ]);
  });
  it("gives a time written before its days to the days after it", () => {
    const read = (text: string): string => describeWeek(fromText(text)[0]!.week);
    expect(read("11am-9pm Mon-Thu, 11am-10pm Fri-Sat")).toBe(
      "Mon–Thu 11:00–21:00; Fri–Sat 11:00–22:00",
    );
    expect(read("10 AM - 8 PM DAILY")).toBe("Mon–Sun 10:00–20:00");
    expect(read("5:00 p.m. - 10:00 p.m. daily")).toBe("Mon–Sun 17:00–22:00");
    expect(read("7-6 PM EVERY DAY")).toBe("Mon–Sun 07:00–18:00");
    // a closed day named after the schedule is that day, not the schedule's
    expect(read("Tue-Sun 5-10pm\nClosed Mondays")).toBe("Mon closed; Tue–Sun 17:00–22:00");
    expect(read("Mon-Thu 11am-9pm, closed Fri")).toBe("Mon–Thu 11:00–21:00; Fri closed");
  });
  it("reads a widget's day, opening and closing on lines of their own, but not booking slots", () => {
    const [found] = fromText("Monday\n7:00 am\n8:00 pm\nTuesday\n7:00 am\n8:00 pm\nSunday\nClosed");
    expect(describeWeek(found!.week)).toBe("Mon–Tue 07:00–20:00; Sun closed");
    expect(fromText("Reserve a table\n5:00 PM\n5:30 PM\n6:00 PM")).toEqual([]);
    const [hours] = fromText("Hours\nMon-Fri 11am-9pm\nBook a table\n5:00 PM\n5:30 PM");
    expect(describeWeek(hours!.week)).toBe("Mon–Fri 11:00–21:00");
  });
  it("reads one range under an hours heading, or after Open, as every day, and says it guessed", () => {
    for (const text of [
      "HOURS OF OPERATION:\n7:00am -10:30pm\n**All hours are weather permitting.",
      "Middleton, MA 01949\nOpen 7:00am-10:30pm\nLocated right next to Richardson's",
    ]) {
      const [found] = fromText(text);
      expect(describeWeek(found!.week)).toBe("Mon–Sun 07:00–22:30");
      expect(found!.inferred).toBe(true);
    }
    // two ranges for two things, or a range under no hours heading: nothing
    expect(fromText("HOURS\n7:00am - 10:30pm Mini Golf\n9:00am - 10:00pm Batting Cages")).toEqual(
      [],
    );
    expect(fromText("Reserve a table\n5:00 PM - 9:00 PM")).toEqual([]);
    // today's hours are one day's
    expect(fromText("Today’s Hours\n10:00 am–5:00 pm")).toEqual([]);
  });
  it("pairs a column of days with a column of hours, and reads nothing when they differ", () => {
    const columns =
      "hours\nSunday\nMonday\nTuesday\nWednesday\nThursday\nFriday\nSaturday\n11:00 am – 10:00 pm\n11:00 am – 11:00 pm\n11:00 am – 11:00 pm\n11:00 am – 11:00 pm\n11:00 am – 11:00 pm\n11:00 am – 1:00 am\n11:00 am – 1:00 am";
    expect(describeWeek(fromText(columns)[0]!.week)).toBe(
      "Mon–Thu 11:00–23:00; Fri–Sat 11:00–01:00; Sun 11:00–22:00",
    );
    expect(fromText("Hours\nMonday\nTuesday\nWednesday\n11am–9pm\n11am–10pm")).toEqual([]);
    // a list of days sharing one schedule is still a list
    expect(describeWeek(fromText("Mon\nWed\nFri\n5-10pm")[0]!.week)).toBe(
      "Mon 17:00–22:00; Wed 17:00–22:00; Fri 17:00–22:00",
    );
  });
  it("merges a window inside the opening hours, and reads no clock in a street name", () => {
    const [found] = fromText(
      "We're open 6:30 am to 3 pm everyday. Delivery is available daily from 8 am to 2 pm.",
    );
    expect(describeWeek(found!.week)).toBe("Mon–Sun 06:30–15:00");
    // a window past midnight takes in one that overlaps it
    expect(describeWeek(fromText("Thu-Sat 11am-10:15pm\nThu-Sat 11am-1am")[0]!.week)).toBe(
      "Thu–Sat 11:00–01:00",
    );
    const [vester] = fromText("73 Sample St. Springfield, MA 01103\nMonday - Friday : 7am - 6pm");
    expect(vester).toMatchObject({ label: "73 Sample St. Springfield, MA 01103" });
  });
  it("does not read prose, an address or a month as hours", () => {
    expect(
      fromText(
        "We opened on a Monday in 2011 and have served pizza every day since, rain or shine.",
      ),
    ).toEqual([]);
    const [found] = fromText("Mon–Fri 11am–9pm\n12-14 Main St, Springfield");
    expect(describeWeek(found!.week)).toBe("Mon–Fri 11:00–21:00");
    expect(fromText("Monthly specials\nSunny patio seating")).toEqual([]);
  });
});

describe("what the place keeps", () => {
  it("writes one interval per day to hours_week and names the split days", () => {
    const week = fromCompact("Mo-Fr 11:30-14:30,17:00-22:00; Sa 17:00-23:00; Su off")!.week;
    expect(toHoursWeek(week)).toEqual({
      hours_week: { sat: ["17:00", "23:00"], sun: null },
      split: ["mon", "tue", "wed", "thu", "fri"],
    });
  });
  it("names the days two sources disagree on", () => {
    const site = fromCompact("Mo-Th 11:00-22:00; Fr-Sa 11:00-23:00")!.week;
    const osm = fromCompact("Mo-Th 11:00-22:00; Fr 11:00-22:00")!.week;
    expect(disagreements(site, osm)).toEqual(["fri"]);
  });
});

const describeAll = (text: string): string =>
  fromText(text)
    .map((hours) => describeWeek(hours.week))
    .join(" || ");

describe("a closed day stays closed", () => {
  it("before or after the schedule, and whatever the selector of the schedule", () => {
    expect(describeAll("Closed Mondays\nTue-Sun 5-10pm")).toBe("Mon closed; Tue–Sun 17:00–22:00");
    expect(describeAll("Closed Monday & Tuesday\nWed-Sun 11am-9pm")).toBe(
      "Mon–Tue closed; Wed–Sun 11:00–21:00",
    );
    expect(describeAll("Closed Sunday, Monday\nTue-Sat 5pm-10pm")).toBe(
      "Mon closed; Tue–Sat 17:00–22:00; Sun closed",
    );
    expect(describeAll("Open daily 11am-9pm\nClosed Tuesdays")).toBe(
      "Mon 11:00–21:00; Tue closed; Wed–Sun 11:00–21:00",
    );
    expect(describeAll("Daily 11am-9pm, closed Tuesday")).toBe(
      "Mon 11:00–21:00; Tue closed; Wed–Sun 11:00–21:00",
    );
    expect(describeAll("Mon-Sun 7am-3pm\nClosed Mondays")).toBe("Mon closed; Tue–Sun 07:00–15:00");
  });

  it("reads except and but", () => {
    expect(describeAll("Open daily 11am-9pm except Monday")).toBe(
      "Mon closed; Tue–Sun 11:00–21:00",
    );
    expect(describeAll("Open 11am-9pm every day except Tuesdays")).toBe(
      "Mon 11:00–21:00; Tue closed; Wed–Sun 11:00–21:00",
    );
    expect(describeAll("Every day but Sunday 9am-5pm")).toBe("Mon–Sat 09:00–17:00; Sun closed");
    // "but" before other words is only a word
    expect(describeAll("Small but cozy. Open Mon-Fri 9am-5pm")).toBe("Mon–Fri 09:00–17:00");
  });

  it("does not close the days of a schedule for a closed holiday", () => {
    expect(describeAll("Mon-Fri 9am-5pm, closed on holidays")).toBe("Mon–Fri 09:00–17:00");
    expect(describeAll("Hours: Mon-Fri 9-5 (closed 12/25)")).toBe("Mon–Fri 09:00–17:00");
  });
});

describe("hours that are not the week", () => {
  it("does not give a day that it cannot read the hours of the next day", () => {
    expect(describeAll("Monday: By appointment\nTuesday: 9am-5pm")).toBe("Tue 09:00–17:00");
    expect(describeAll("Monday: Varies\nTuesday 9am-5pm\nWednesday 9am-5pm")).toBe(
      "Tue–Wed 09:00–17:00",
    );
    expect(describeAll("Monday: Open 24 hours\nTuesday: 9am-5pm")).toBe(
      "Mon open 24 hours; Tue 09:00–17:00",
    );
  });

  it("keeps a meal or the kitchen with no day of its own in the hours of the days above", () => {
    expect(describeAll("Mon-Fri\nLunch 11am-2pm\nDinner 5pm-10pm")).toBe(
      "Mon–Fri 11:00–14:00, 17:00–22:00",
    );
    // under days with no time of their own, the service is the time of those days
    expect(describeAll("Sat-Sun\nBrunch 10am-2pm")).toBe("Sat–Sun 10:00–14:00");
    expect(describeAll("Tue-Sat 5pm-11pm\nKitchen 5pm-10pm")).toBe("Tue–Sat 17:00–23:00");
    expect(describeAll("Mon-Fri\nHours 9am-5pm")).toBe("Mon–Fri 09:00–17:00");
    expect(fromText("Mon-Fri 9am-5pm\nHours 10am-4pm")[0]!.partial).toBeUndefined();
  });

  it("leaves out a line for a date or an occasion, and says so", () => {
    for (const text of [
      "Mon-Fri 9am-5pm\nNew Year's Eve 8pm-1am",
      "Mon-Fri 9am-5pm\nDec 24: 9am-2pm\nDec 25: Closed",
      "Mon-Fri 9am-5pm\nPrivate events available 11am-3pm",
      // a service or an event with no day of its own is not more opening hours of the days above
      "Mon-Fri 9am-5pm\nHappy hour 6-8pm",
      "Mon-Fri 9am-5pm\nDelivery 6pm-9pm",
      "Mon-Fri 9am-5pm\nLive music 9pm-12am",
      "Mon-Fri 9am-5pm\nBrunch 10am-2pm",
    ]) {
      const [found] = fromText(text);
      expect(describeWeek(found!.week)).toBe("Mon–Fri 09:00–17:00");
      expect(found!.partial).toBe(true);
    }
    const events =
      "Upcoming events\nSat, Oct 18 · 7:00 PM – 10:00 PM\nFri, Oct 24 · 8:00 PM – 11:00 PM";
    expect(fromText(events)).toEqual([]);
  });

  it("reads no hours in a menu, an age, a price or a score", () => {
    for (const text of [
      "Sun-dried tomato pasta 12-14",
      "Starters\nSun-Dried Tomato Flatbread 14\nMon Ami Burger 16\nHappy Hour 4-6pm",
      "Kids Club Saturdays, ages 5-10",
      "Sunday's game: Patriots 21-14",
      "Burgers on Tuesdays $12-14",
    ]) {
      expect(fromText(text)).toEqual([]);
    }
  });

  it("gives each season a schedule of its own, and names it", () => {
    const seasons = fromText("Hours\nSummer: Mon-Sun 10am-8pm\nWinter: Sat-Sun 10am-4pm");
    expect(seasons.map((hours) => [hours.season, describeWeek(hours.week)])).toEqual([
      ["Summer", "Mon–Sun 10:00–20:00"],
      ["Winter", "Sat–Sun 10:00–16:00"],
    ]);
    // the line above the winter schedule is the last line of the summer schedule, not a label
    expect(seasons.map((hours) => hours.label)).toEqual(["Hours", null]);
    expect(fromText("Hours (June-August)\nMon-Sun 7am-10pm")[0]!.season).toBe("June-August");
  });
});

describe("guesses that make sense", () => {
  it("reads a diner's morning, a noon close and a bar's late close", () => {
    expect(range("6", "2")).toEqual({ interval: ["06:00", "14:00"], inferred: true });
    expect(range("5", "1")).toEqual({ interval: ["05:00", "13:00"], inferred: true });
    expect(range("7", "12")).toEqual({ interval: ["07:00", "12:00"], inferred: true });
    expect(range("10", "12")?.interval).toEqual(range("10am", "12")?.interval);
    expect(range("11", "1am")).toEqual({ interval: ["11:00", "01:00"], inferred: true });
    expect(range("12", "1am")).toEqual({ interval: ["12:00", "01:00"], inferred: true });
    expect(range("13", "2")?.interval).toEqual(["13:00", "02:00"]);
    expect(range("09", "5")).toEqual({ interval: ["09:00", "17:00"], inferred: true });
  });

  it("reads 12 midnight and 12 noon as one time, and refuses a score", () => {
    expect(describeAll("Mon-Sat 11am-12 midnight")).toBe("Mon–Sat 11:00–00:00");
    expect(describeAll("Mon-Fri 6am-12 noon")).toBe("Mon–Fri 06:00–12:00");
    expect(range("21", "14")).toBeUndefined();
    expect(range("8:60", "9")).toBeUndefined();
  });
});

describe("more ways to write hours", () => {
  it("reads open 24 hours, 24/7, short day names, weekend and the 9h clock", () => {
    expect(describeAll("Open 24 hours")).toBe("Mon–Sun open 24 hours");
    expect(fromText("Open 24/7")[0]!.inferred).toBe(false);
    expect(describeAll("Mon-Sun: Open 24 hours")).toBe("Mon–Sun open 24 hours");
    expect(describeAll("M-F 9am-5pm\nSat 10am-2pm")).toBe("Mon–Fri 09:00–17:00; Sat 10:00–14:00");
    expect(describeAll("Tu-Th 11am-9pm")).toBe("Tue–Thu 11:00–21:00");
    expect(describeAll("Su-Th 11am-10pm")).toBe("Mon–Thu 11:00–22:00; Sun 11:00–22:00");
    expect(describeAll("Weekend 10am-4pm")).toBe("Sat–Sun 10:00–16:00");
    expect(describeAll("Mon-Fri 9h-17h")).toBe("Mon–Fri 09:00–17:00");
    expect(describeAll("Mon-Fri 00:00-24:00")).toBe("Mon–Fri open 24 hours");
    // 24 hours of notice is not 24 hours open
    expect(fromText("Hours\nOrders need 24 hours notice")).toEqual([]);
  });

  it("reads any dash, a tilde, a full-width colon and text with zero-width spaces", () => {
    for (const text of [
      "Mon−Fri 9am−5pm",
      "Mon‐Fri 9am‐5pm",
      "Mon​-​Fri 9am-5pm",
      "Mon~Fri 9:00~17:00",
      "Mon-Fri 9：00-17：00",
    ]) {
      expect(describeAll(text)).toBe("Mon–Fri 09:00–17:00");
    }
  });
});

const ALL_WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

describe("schema.org and OpenStreetMap, more strictly", () => {
  const spec = (opens: string, closes: string): string =>
    describeWeek(
      fromSchemaOrg({ openingHoursSpecification: { dayOfWeek: ["Monday"], opens, closes } })
        ?.week ?? {},
    );

  it("reads 00:00 to 24:00 as open 24 hours, and an am or a pm in a time", () => {
    expect(spec("00:00", "24:00")).toBe("Mon open 24 hours");
    expect(spec("00:00", "23:59")).toBe("Mon open 24 hours");
    expect(spec("9:00 AM", "5:00 PM")).toBe("Mon 09:00–17:00");
    expect(spec("11:00am", "10:00pm")).toBe("Mon 11:00–22:00");
    expect(spec("09:75", "25:00")).toBe("");
    expect(fromCompact("Mo-Fr 09:75-25:00")).toBeUndefined();
  });

  it("reads the days of a specification written as an @id or a short name", () => {
    for (const dayOfWeek of [{ "@id": "https://schema.org/Monday" }, "Mo"]) {
      const hours = fromSchemaOrg({
        openingHoursSpecification: { dayOfWeek, opens: "09:00", closes: "17:00" },
      });
      expect(describeWeek(hours!.week)).toBe("Mon 09:00–17:00");
    }
  });

  it("picks the season of a date, and leaves a holiday out", () => {
    const record = {
      openingHoursSpecification: [
        {
          dayOfWeek: ALL_WEEK,
          opens: "10:00",
          closes: "20:00",
          validFrom: "2026-06-01",
          validThrough: "2026-08-31",
        },
        {
          dayOfWeek: ["Saturday", "Sunday"],
          opens: "10:00",
          closes: "16:00",
          validFrom: "2026-09-01",
          validThrough: "2027-05-31",
        },
        {
          dayOfWeek: "Thursday",
          opens: "00:00",
          closes: "00:00",
          validFrom: "2026-11-26",
          validThrough: "2026-11-26",
        },
      ],
    };
    const winter = fromSchemaOrg(record, { at: "2026-12-01" });
    expect(describeWeek(winter!.week)).toBe("Sat–Sun 10:00–16:00");
    expect(winter).toMatchObject({ season: "2026-09-01/2027-05-31", partial: true });
    expect(fromSchemaOrg(record)!.season).toBe("2026-06-01/2026-08-31");
  });

  it("reads the openingHours that sites write, and leaves out the rules for dates", () => {
    const read = (openingHours: string | string[]): string =>
      describeWeek(fromSchemaOrg({ openingHours })?.week ?? {});
    expect(read("Monday-Friday 9:00-17:00")).toBe("Mon–Fri 09:00–17:00");
    expect(read("Mo-Fr: 09:00-17:00")).toBe("Mon–Fri 09:00–17:00");
    expect(read("mo-fr 09:00-17:00")).toBe("Mon–Fri 09:00–17:00");
    expect(read("Mo-Fr 9am-5pm")).toBe("Mon–Fri 09:00–17:00");
    expect(read("Mo-Fr 09:00-17:00 Sa 10:00-14:00")).toBe("Mon–Fri 09:00–17:00; Sat 10:00–14:00");
    const dated = fromSchemaOrg({ openingHours: ["Mo-Fr 09:00-17:00", "Dec 25 off"] });
    expect(dated).toMatchObject({ partial: true });
    expect(describeWeek(dated!.week)).toBe("Mon–Fri 09:00–17:00");
    // a rule it cannot read leaves its days unknown: Wednesday is not 09:00-17:00
    expect(describeWeek(fromCompact("Mo-Fr 09:00-17:00; We sunrise-sunset")!.week)).toBe(
      "Mon–Tue 09:00–17:00; Thu–Fri 09:00–17:00",
    );
    expect(describeWeek(fromCompact("Mo-Fr 09:00-17:00, We off")!.week)).toBe(
      "Mon–Tue 09:00–17:00; Wed closed; Thu–Fri 09:00–17:00",
    );
  });
});

describe("comparing a reading with a stored week", () => {
  const stored = {
    mon: [["09:00", "17:00"]],
    tue: [["09:00", "17:00"]],
    sat: [["10:00", "24:00"]],
    sun: [],
  } as const;

  it("compares only the days that the two weeks state", () => {
    expect(compareHours(stored, { mon: [["9:00", "17:00"]], sat: [["10:00", "00:00"]] })).toEqual({
      status: "same",
      days: [],
      added: [],
      skipped: [],
    });
    expect(
      compareHours(stored, { mon: [["09:00", "18:00"]], sun: [["10:00", "14:00"]], fri: [] }),
    ).toEqual({ status: "changed", days: ["mon", "sun"], added: ["fri"], skipped: [] });
    // a closed day and an open day differ
    expect(compareHours(stored, { tue: [] }).days).toEqual(["tue"]);
  });

  it("gives new for a stored week with no day, and leaves out a split day with skipSplit", () => {
    expect(compareHours(undefined, { mon: [["09:00", "17:00"]], sun: [] })).toEqual({
      status: "new",
      days: ["mon", "sun"],
      added: [],
      skipped: [],
    });
    expect(compareHours({}, { wed: [] }).status).toBe("new");
    const split = {
      mon: [
        ["11:30", "14:30"],
        ["17:00", "22:00"],
      ],
    } as const;
    expect(compareHours(stored, split).days).toEqual(["mon"]);
    expect(compareHours(stored, split, { skipSplit: true })).toEqual({
      status: "same",
      days: [],
      added: [],
      skipped: ["mon"],
    });
    // the order of the intervals does not matter
    const lunch = {
      mon: [
        ["17:00", "22:00"],
        ["11:30", "14:30"],
      ],
    } as const;
    expect(compareHours(split, lunch).status).toBe("same");
  });
});
