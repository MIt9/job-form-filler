# Задача: закрити прогалини з IMPROVEMENTS-2026-11.md

Репо: `/Users/d.bilukcha/work/job-form-filler` (Chrome-розширення + Node bridge/MCP). Спочатку прочитай `CLAUDE.md` та `IMPROVEMENTS-2026-11.md`.

## Правила
- Перед роботою і після неї запускай `npm test`. Усі тести мають проходити.
- Для кожної нової логіки додай тест у `test/` і зареєструй його в `package.json` у скрипті `test`.
- Не додавай тул `submit`. Не послабляй `isTrustedRequest` у мості: ніякого `CORS *` і біндингу на `0.0.0.0`.
- Мінімальний diff. Без нових залежностей.
- Роби по одному пункту й ставай на зелених тестах. Коміти: `feat: ...`, англійською.

## Пункти (від найважливішого)

### 1. #8 — `kind: factual` для питань роботодавця
- Зараз питання Djinni (`extension/content/content.js` ~L543-560, `getDjinniQuizQuestions`) усі мають `humanRequired: true, knockout: true`, навіть фактичні (роки досвіду, PHP, REST, fintech).
- Значення `factual` у коді немає. `kind` ставить лише `server/mcp-server.js` ~L360-363, за ключовими словами.
- Зроби так:
  - Класифікація `kind` у одному місці, через яке проходять і Djinni, і загальні питання.
  - `factual` означає, що відповідь береться з профілю або резюме: роки, стек, так/ні по навичках. Для `factual` не ставити `humanRequired`.
  - `behavioral`, `motivational`, `eeo` та `authorization` лишаються людині.
  - `knockout` залишається як є.
- Задокументуй значення `kind` в описі тулу `get_active_job_form` у `server/mcp-server.js`.
- Тест: питання «Скільки років досвіду з PHP?» дає `factual` без `humanRequired`, а «Розкажіть про випадок, коли ви помилились» дає `behavioral` з `humanRequired`.

### 2. #10 — `get_submission_status` для DOU і Greenhouse
- Файл: `extension/content/content.js` ~L2070 (`getSubmissionStatus`).
- Додай URL-патерни: `?sent` і `#replied-` для `jobs.dou.ua`, `/confirmation` для Greenhouse. Результат: `isSubmitted: true, matchedBy: "url"`.
- Тест на ці URL.
- Подію `form-submitted` у мості додавай, лише якщо це дешево. Інакше пропусти й напиши про це у звіті.

### 3. #4 — стабільні `fieldId`
- Зараз `content.js` ~L1108 дає `field_${index}_...`, а індекс міняється між викликами.
- Зроби id стабільним в межах форми: хеш від label + DOM-шлях. Пошук за label має працювати як раніше.
- Тест: два послідовні скани тієї самої форми, навіть після видалення одного поля з початку, дають однакові id для решти.

### 4. #3 — тест на «злипання» значень
- Додай тест для `injectAIAnswers` (`content.js` ~L1921) з багатополевою картою відповідей, наприклад `"$3,500/month"` і `"No"` у сусідніх полях.
- Перевір, що значення не потрапляють у сусідні поля. Якщо знайдеш баг, виправ корінь.

### 5. #5 — діагностика порту і статус резюме
- `server/bridge-server.js` ~L363: коли порт зайнятий, друкуй PID і команду власника (`lsof -nP -iTCP:PORT -sTCP:LISTEN` через `child_process`). Якщо `lsof` упаде, виведи попереднє повідомлення.
- `autofill_static_fields` має явно повертати `resume: "attached"` або `{ failed: "<reason>" }`.

### 6. #7 — лічильники символів на сторінці
- Коли в поля немає атрибута `maxLength`/`minLength`, прочитай ліміт із лічильника на сторінці (формати на кшталт `0/1000`, «n characters left») у `scanFormFields` (`content.js` ~L961).
- Додай тест на фікстурі.

### 7. #6 — загальний обробник кастомних dropdown
- Кастомні select (наприклад «Where did you hear about us») зараз дають `notFound` і зникають із `get_form_state`.
- Зроби так: клік по тригеру, зчитати опції з DOM, вибрати за текстом. Такі поля мають з'являтись у `get_active_job_form` та `get_form_state`.
- Тест на фікстурі.

## Звіт
Для кожного пункту напиши `done` або `skipped (чому)`. Додай підсумок `npm test`.
