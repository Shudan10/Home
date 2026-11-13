# Family Hub

A family board for [Quick Start Home](https://github.com/Shudan10/Home): the
day at a glance, a shared calendar, reminders, the weather, and the meal
planner it grew out of. Everything is kept on this server — nothing goes to
iCloud, Google or anybody else. iPhones add it as a calendar account, so the
events and reminders are in their own Calendar and Reminders apps, both ways.

Built for an iPad on the kitchen wall in landscape, and for phones.

The project, container and data folder are still called Meal Plan, so existing
installs keep their data; only the name on screen changed.

## The board

- **Overview.** Three rows, on one screen on a landscape iPad: a big clock
  with the date under it and, beside them, everything on today;
  the weather for today and the six days after it; and those same seven days
  beneath it, each with its events, its dinner and its reminders. It is for
  looking — events and dinners are changed on their own tabs — except that a
  reminder can be ticked off there; late reminders wait on today. A busy day scrolls inside its own column. On a phone the rows stack
  and the days become a list. It notices midnight.
- **Keeping fresh.** Whatever tab is showing — the Overview, the calendar, reminders,
  or the week's meal plan — is read again every five minutes while
  it is on screen, and straight away when the app comes back after being away,
  so changes made on a phone reach a board left on any of them. Not while the
  page is hidden, not while a sheet or editor is open, and not the meal library
  or Settings, where a redraw would throw away a search or a half-filled form.
- **The family.** Everyone gets a name and one of ten colours, chosen so no two
  look alike. The colour marks their events and their column of reminders.
  Removing someone keeps their events and reminders; they just become
  everybody's.
- **Calendar events.** Timed or all day, a few days long if need be, for one
  person, several, or the whole family. They repeat every so many days, weeks,
  months or years, with an optional end — and one day of a repeating event
  can be deleted on its own. A monthly event on the 31st skips the months that do not have one, and a
  birthday on 29 February waits for leap years, rather than sliding about.
  An event can have an alert, which goes off on the phones that have the
  calendar account.
- **Reminders.** A column per person on the Reminders tab, one day at a time.
  They work the way the iPhone's Reminders app does, since they are in it too.
  A reminder has a day it is due (or none: then it waits on today's list), and
  can have a time and notes. One that repeats — every so many days, weeks on
  chosen days, months or years — is due one day at a time: ticking it moves it
  on to the next, and one not ticked stays on today's list, marked late. Only
  the latest tick of a repeating one can be taken back. (Stored as "tasks",
  their first name, so the data and backups did not have to change.)
- **Weather.** From [Open-Meteo](https://open-meteo.com), which needs no
  account or key. The town is set once for the house in Settings; only its
  rounded coordinates are sent, and the forecast is cached for 15 minutes.
- **On your iPhone.** The hub is also a CalDAV server, so an iPhone can add it
  as a calendar account. Events and reminders are then in the phone's own
  apps, and adding, changing or ticking them there changes them here. See
  [The calendar account](#the-calendar-account).

## Meals

- **A meal library.** Name, tags, how many it serves, ingredients and method.
  Only the name is required: type "Tacos" in the box above the list and tap
  Add, and the rest can be filled in later by tapping it. Search turns the
  same box into a filter, and Done turns it back.
- **A week at a time.** One meal a day — dinner, which is the one that gets
  planned. Tap a day, pick a meal.
- **A month, or a week.** The calendar shows the shape of a month at a glance,
  and switches to a single week where the names are big enough to read from
  across the kitchen. The button in the header swaps between them and lands on
  the current month or week either way.
- **Random week.** Fills the days. It draws without replacement, so
  a week does not come back as the same dinner four times, and by default it
  only fills blanks — if you have already decided on Friday, Friday is kept.
  Saturday and Sunday can be left out, for households that eat differently at
  the weekend.
- **Weekly limits.** Some things should not come round twice in one week.
  Anything with `taco` in its name is capped at once a week, and the whole
  family counts as one thing: Chicken tacos, Beef tacos and Taco salad are
  different meats, but they are still tacos, and one of them on Tuesday stops
  another appearing on Friday. The rules are a short list at the top of
  `lib/store.js` (`WEEKLY_LIMITS`); adding another is one line.
- **Themes.** Colours — Blue, Black, White, Red, Green, Purple, Orange, Pink
  and Teal — and holidays from New Year's round to Christmas, each with its own
  palette and a small mark of the season. Blue, the default, follows the
  device's light or dark setting; the rest choose for themselves. Saved per
  device, so each phone or iPad in the house can have its own. All of them are
  described in one place, `public/themes.js`.
- **Installs to the home screen.** It is a PWA, so Add to Home Screen gives it
  an icon and no browser chrome.

## Running it

Normally this is installed and managed by the Quick Start Home panel, which
builds the image, sets the password and publishes it. To run it directly:

```bash
docker build -t mealplan .
docker run -d --name mealplan -p 8083:8080 -v mealplan-data:/data mealplan
```

Then open `http://<this machine>:8083`.

### Environment

| Variable | What it does |
| --- | --- |
| `PORT` | Port inside the container. Default `8080`. |
| `MEALPLAN_DATA` | Where the JSON files live. Default `/data`. |
| `MEALPLAN_PASSWORD_HASH` | A `scrypt:salt:hash` value. **Without it there is no password and anyone who can reach the port can change the plan.** |
| `SESSION_SECRET` | Signs session cookies, together with the password hash, so changing the password signs everyone out. Generated per start if unset, which logs everyone out on restart. |
| `MEALPLAN_ALLOWED_HOSTS` | Only matters with no password set: extra names, comma-separated, that the app answers to (`.example.com` allows a whole domain). IP addresses, `localhost`, `*.ts.net`, `*.local` and dotless names are always accepted; anything else is refused, which is what stops a DNS-rebinding page from reaching the plan. |

Generate a password hash:

```bash
node -e "import('./lib/auth.js').then(a=>console.log(a.hashPassword('your password here')))"
```

Colons separate the fields rather than `$` on purpose: Docker Compose
interpolates `$NAME` when it reads an `.env` file, which silently truncated
`$`-separated hashes and made the panel refuse the correct password.

## The calendar account

On the iPhone: Settings → Apps → Calendar → Calendar Accounts → Add Account →
Other → Add CalDAV Account. The server is the hub's address with `/dav/` on the
end, the user name `family`, the password the family password.

Settings shows the address to use: the hub's public one (`https://…/dav/`)
once somebody signed in has opened the hub there, which works anywhere; before
that, the address the page is open at. The hub learns its public address only
from a signed-in visit through the tunnel or Tailscale over https, since the
name a request arrives under is otherwise anybody's to write. At a home
`http://` address the phone first says it cannot connect using SSL; Continue
sets it up without, and the phone then only syncs at home.

Times go out "floating": 10:00 means ten o'clock wherever the phone is.
Repeating events and reminders go as repeat rules rather than copies, so they
carry on as far ahead as the phone looks.

The account has one calendar, Family Hub, for events, and a reminders list per
person plus one for Everyone. Lists are the family: they are made and removed
by adding and removing people here, and cannot be made on the phone. A
colour or order picked for one of them on a phone is kept (in
`settings.json`) and goes to every phone on the account; it does not change
the person's colour in the hub.

- **Whose an event is** goes in brackets after its name, both ways: the hub
  sends Emma's swim as "Swim (Emma)", and "Swim (Emma)" typed on a phone is
  Emma's. Names in brackets that are not all family members stay part of the
  name.
- **Repeats** the hub cannot keep are refused, and the phone says it could not
  save the event: an event on more than one day of the week, or "the second
  Tuesday". Reminders can repeat on several days of the week. One day of a
  repeating event changed on the phone ("this event only") becomes an event of
  its own, with that day taken out of the series.
- **Details the hub has no field for** — a reminder's flag or priority, a
  link, the map pin behind a place — are kept as they came and sent back with
  the rest, so editing in the hub does not lose them.
- **Ticking a repeating reminder** on the phone ticks the one that is due and
  moves it on, the same as in the hub. However the phone saves the tick, the
  hub keeps it as the one reminder, and the phone sees that on its next sync.
- **Sign-in** is HTTP Basic with the family password on every request, under
  the same limit on wrong guesses as the sign-in page. Over a home `http://`
  address that password crosses the home Wi-Fi unencrypted; at the public
  `https://` address it does not. A phone that set the account up at the home
  address only syncs at home, and keeps its changes until it is back.

The protocol is the part of WebDAV and CalDAV the Apple apps use — PROPFIND,
calendar-multiget and calendar-query, PUT, DELETE and MOVE, with ETags and a
ctag per calendar — and not sync-collection, scheduling or sharing. It is in
`lib/caldav.js`, and the iCalendar reading and writing in `lib/ical.js`.

There used to be a read-only calendar link to subscribe to instead. It is
gone; a phone still subscribed to it should delete the subscription, or it
shows the events twice beside the account.

## Data

JSON files in `/data`:

- `meals.json` — the library, an array of meals.
- `plan.json` — `{ "2026-10-26": { "dinner": "<meal id>" } }`, keyed by date.
- `members.json` — the family: names and colours.
- `events.json` — calendar events. A repeating one is stored once, as its rule
  and the days skipped.
- `tasks.json` — reminders, one-off and repeating, with the days each was
  ticked. Events and reminders made on a phone also keep the phone's own name
  for them (`uid`, `href`) and any details the hub has no field for (`extra`).
- `settings.json` — the town, the units, and the hub's public address.

Written to a temp file and renamed over the target, so a crash midway cannot
leave a half-written file that reads back as an empty library. All of them are
plain enough to fix with a text editor, which is the main reason they are not a
database.

## Notes

- Weeks start on Sunday. One constant at the top of `public/app.js`
  (`WEEK_STARTS_ON`) changes that, and nothing else depends on which it is.
- The service worker caches nothing. It exists so iOS treats the page as a real
  home-screen app; a board served stale from a cache is worse than one that
  admits it cannot reach the server.
- An iPhone that already has the app on its home screen keeps the old name
  under the icon until it is removed and added again.
