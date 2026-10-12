import { describe, expect, it } from "vitest";
import {
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
