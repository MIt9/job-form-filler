# Задача (раунд 2): тести і прогалини з IMPROVEMENTS-2026-11.md

Репо: `/Users/d.bilukcha/work/job-form-filler` (Chrome-розширення + Node bridge/MCP). Спочатку прочитай `CLAUDE.md` та `IMPROVEMENTS-2026-11.md`.

## Стан після коміту `3f070fd`
Код уже є, але **без нових тестів**:
- `classifyQuestionKind` у `server/human-questions.js`; `humanRequired = kind !== "factual"` (Djinni і загальні питання).
- `getSubmissionStatus` (`extension/content/content.js`): DOU (`?sent`, `#replied-`) і Greenhouse (`/confirmation`).
- Стабільні `fieldId` через `stableFieldHash(label + '|' + stableDomPath(el))` (`field_`, `checkbox_group_`, `radio_group_`, `toggle_pair_`).
- `server/bridge-server.js`: вивід `lsof` при зайнятому порті.
- `autofill_static_fields` повертає `resume: "attached" | {failed: reason}`.

## Правила
- Перед роботою і після неї запускай `npm test`. Усі тести мають проходити.
- Кожен новий тест-файл реєструй у `package.json` у скрипті `test`.
- Не додавай тул `submit`. Не послабляй `isTrustedRequest` у мості: ніякого `CORS *` і біндингу на `0.0.0.0`.
- Мінімальний diff. Без нових залежностей.
- Один пункт — один коміт, англійською, `feat:` або `test:`. Не додавай цей файл у коміти.

## Пункти (по порядку)

### A. Тести для вже зробленого (код не змінювати, лише якщо тест виявив баг)
1. **`kind`.** «Скільки років досвіду з PHP?» дає `factual`, `humanRequired` не ставиться. «Розкажіть про випадок, коли ви помилились» дає `behavioral` і `humanRequired: true`. Додай ще по одному прикладу для `motivational`, `authorization` та `eeo`. Перевір, що Djinni-питання про роки досвіду більше не `humanRequired`, а `knockout` лишається.
2. **`getSubmissionStatus`.** URL-кейси:
   - `https://jobs.dou.ua/...?sent` і `...#replied-123` дають `isSubmitted: true, matchedBy: "url"`.
   - `https://boards.greenhouse.io/x/jobs/1/confirmation` теж дає `isSubmitted: true`.
   - `https://jobs.dou.ua/...` без `?sent` і не-DOU URL з `?sent` дають `isSubmitted: false`.
3. **Стабільні `fieldId`.** Два послідовні скани тієї самої форми дають однакові id. Видали перше поле з DOM, і id решти не змінились. Два поля з однаковим label мають різні id.
4. **Autofill і резюме.** `resume: "attached"` при успіху, `{failed: ...}` при невдачі. Перевір, що `bridge-server` при зайнятому порті не падає, навіть коли `lsof` недоступний.

### B. #3 — тест на «злипання» значень
- `injectAIAnswers` (`content.js` ~L1921), багатополева карта відповідей: `"$3,500/month"` в одне поле, `"No"` у сусіднє (радіо чи select).
- Перевір, що значення не потрапляють у сусідні поля. У стару помилку виходило `"$3,500/monthNo"`. Якщо знайдеш баг, виправ корінь у шляху `injectAIAnswers`.

### C. #7 — лічильники символів на сторінці
- У `scanFormFields` (`content.js` ~L961): коли в поля немає `maxLength`/`minLength`, прочитай ліміт із лічильника поруч (`0/1000`, «n characters left», «Max 500 characters»).
- Атрибут має пріоритет над лічильником.
- Тест на фікстурі з кількома форматами лічильників.
- `fill_job_form` відмовляє зрозумілою помилкою, якщо текст довший (вже є для атрибута, див. `content.js` ~L1945). Тест на лічильник теж.

### D. #6 — загальний обробник кастомних dropdown
- Кастомні select («Where did you hear about us» та подібні) зараз дають `notFound` і зникають із `get_form_state`.
- Алгоритм: клік по тригеру, зчитати опції з DOM, вибрати за текстом. Фінальний Submit не чіпати.
- Такі поля мають з'являтись у `get_active_job_form` (з `options`) і в `get_form_state`.
- Тест на фікстурі: поле з'являється з опціями, `fill_job_form` обирає вказану, `get_form_state` показує обране значення. Для невідомої опції — зрозуміла помилка зі списком доступних (за зразком `didYouMean`).

### E. Необов'язково, якщо дешево
- Подія `form-submitted` у мості, яку агент може прочитати. Інакше пропусти й напиши про це у звіті.

## Звіт
Для кожного пункту напиши `done` або `skipped (чому)`. Додай підсумок `npm test` до і після.
