# CLAUDE.md — Ders-Program- (Advanced Student Assistant)

## Project Overview

A single-file student productivity web application (Gelişmiş Öğrenci Asistanı — "Advanced Student Assistant") written in pure HTML/CSS/Vanilla JavaScript. No build tools, no external dependencies, no backend. Open `index.html` in any browser to run the app.

**Primary language of the UI and code identifiers: Turkish.**

---

## Repository Structure

```
Ders-Program-/
├── index.html    # Entire application (markup + styles + logic, ~2500 lines)
└── README.md     # Minimal title-only readme
```

There is intentionally only one file. Do **not** split it into multiple files unless explicitly asked.

---

## Technology Stack

| Layer      | Technology                              |
|------------|-----------------------------------------|
| Markup     | HTML5                                   |
| Styling    | CSS3 (custom properties, Grid, Flexbox) |
| Logic      | Vanilla JavaScript (ES6+)               |
| Persistence| Browser `localStorage`                  |
| Build tool | None — open directly in a browser       |
| Package mgr| None                                    |
| Tests      | None                                    |

Browser APIs in use: `localStorage`, `FileReader`, Web Audio API, Notification API, Clipboard API, native `Date`.

---

## Running the App

```bash
# Option 1 — open directly
open index.html          # macOS
xdg-open index.html      # Linux

# Option 2 — simple HTTP server (avoids some browser restrictions)
python3 -m http.server 8080
# then visit http://localhost:8080
```

No installation, compilation, or build step is required.

---

## Application Architecture

The entire JavaScript application lives in a single global object `app` defined inside a `<script>` tag at the bottom of `index.html`.

### Data Model (`app.data`)

```js
app.data = {
  theme:      'dark',   // 'dark' | 'light'
  schedule:   [],       // Weekly class entries
  tasks:      [],       // Assignments / exams
  notes:      [],       // Study notes
  gpaRows:    [],       // Grade rows for GPA calculator
  flashcards: [],       // Flashcard deck entries
  habits:     [],       // Habit definitions
  studyLog:   []        // Pomodoro study session log
}
```

### Pomodoro State (`app.pomo`)

Holds timer interval, time remaining, mode (work/short-break/long-break), session counts, etc.

### localStorage Keys

| Key                      | Contents                         |
|--------------------------|----------------------------------|
| `OgrenciAsistaniData_v3` | Main `app.data` (current)        |
| `OgrenciAsistaniData_v2` | Legacy — read for migration only |
| `PomoStats_v2`           | Pomodoro session statistics       |

Data is auto-saved every 30 seconds and on every mutation. Export/import via JSON download/upload.

---

## Code Organization

Sections inside the `<script>` block are delimited by:

```js
// ═════════ SECTION NAME ═════════
```

| Section          | Responsibility                                           |
|------------------|----------------------------------------------------------|
| Init / Core      | `init()`, `loadData()`, `saveData()`, `$()`, theme       |
| UI / Navigation  | `switchTab()`, FAB menu, keyboard shortcuts              |
| Notifications    | `showToast()`, `confirm()`, `showConfetti()`             |
| Schedule         | `addClass()`, `deleteClass()`, `renderScheduleList()`   |
| Tasks / Agenda   | `addTask()`, `toggleTask()`, `deleteTask()`, badge       |
| Notes            | `saveNote()`, `editNote()`, `deleteNote()`, search       |
| Flashcards       | `addFlashcard()`, deck rendering, study session          |
| Habits           | `addHabit()`, toggle day, streak calculation             |
| GPA Calculator   | `initGPA()`, `addGPARow()`, `calculateGPA()`            |
| Pomodoro         | `pomoStart/Pause/Reset()`, display update, notifications |
| Dashboard        | Weekly table, study summary, daily quote                 |
| Utilities        | `escapeHtml()`, `escapeAttr()`, `_playSound()`          |

---

## Key Conventions

### Naming

- **Turkish** for all user-visible strings, variable names, and HTML IDs.
- `camelCase` for JavaScript identifiers.
- `kebab-case` for HTML element IDs.
- Methods prefixed with `_` (e.g., `_playSound()`) are private/internal.
- `$()` is a shorthand for `document.getElementById()`.

### Rendering Pattern

All list rendering follows this pattern:

```js
renderXxxList() {
  const container = this.$('container-id');
  if (!this.data.xxx.length) {
    container.innerHTML = '<p>Empty state message</p>';
    return;
  }
  container.innerHTML = this.data.xxx.map(item => `
    <div ...>${this.escapeHtml(item.field)}</div>
  `).join('');
}
```

Renders are triggered after every data mutation. Use `innerHTML` for bulk DOM updates.

### Event Handling

Events are wired via inline `onclick` attributes pointing to `app.methodName(...)`. Do not introduce `addEventListener` unless there is a clear reason.

### Security

Always escape user-provided content before inserting into HTML:

```js
escapeHtml(str)   // for text node content
escapeAttr(str)   // for HTML attribute values
```

Never skip escaping when rendering user data. This is the primary XSS defense.

### Data Mutations

1. Validate the input.
2. Create the new object and push to the appropriate array.
3. Call `this.saveData()` immediately.
4. Call the corresponding `renderXxx()` method.
5. Show a toast notification for feedback.

### Theme

Themes are toggled by setting `data-theme="dark"` or `data-theme="light"` on `<html>`. All colors are CSS custom properties inside `[data-theme="dark"]` and `[data-theme="light"]` blocks.

---

## UI Layout

| Breakpoint | Navigation style                    |
|------------|-------------------------------------|
| Desktop    | Fixed left sidebar (icon + label)   |
| Mobile     | Bottom tab bar + floating action button (FAB) |

Keyboard shortcuts: `Ctrl+1` through `Ctrl+8` switch tabs; `Space` toggles the Pomodoro timer.

---

## Data Export / Import

- **Export:** `app.exportData()` — downloads `ogrenci-asistani-YYYY-MM-DD.json`
- **Import:** `app.importData()` — reads a JSON file, validates structure, merges into `app.data`, saves

---

## What AI Assistants Should Know

- **Do not add external libraries or a build system** unless explicitly requested.
- **Do not split `index.html`** into separate files.
- **Always escape user input** with `escapeHtml()` / `escapeAttr()` when adding new rendering code.
- **Follow the Turkish naming convention** for new identifiers and UI strings.
- **Use the section-divider comment style** (`// ═════════ NAME ═════════`) when adding new sections.
- **Call `saveData()` after every mutation** — there is no ORM or reactive system; persistence is manual.
- **Render immediately after mutations** — call the relevant `renderXxx()` method right after saving.
- **Use `showToast()`** for user feedback instead of `alert()`.
- **Use `app.confirm()`** for destructive-action confirmations instead of `window.confirm()`.
- The app has **no tests**; verify changes by opening the file in a browser.
- The app is **fully offline-capable** — never add network calls without explicit instruction.
