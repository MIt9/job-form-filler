# Вимоги від реального користувача (career-repo workflow)

Джерело: сесія заповнення вакансій у `~/work/resume` через claude-in-chrome
(Toggl, Wayflyer, Morpho, Adventure Travel 365, memoryOS, iForAI). Мета
цього документа — зафіксувати, чого реально бракує/побоююсь, перш ніж
довірити цьому інструменту production-сабміти замість поточного
claude-in-chrome + ручного читання accessibility tree (дорого по токенах,
але передбачувано).

Дослідження поточного стану коду (2026-09-23): MV3-екстеншн + Node bridge +
MCP server, "0-token + AI hybrid" — Tier 1 (статичні поля) заповнюються
детерміновано, Tier 2 (кастомні питання) — через LLM. Компактний вивід
(`get_active_job_form`), без screenshots, без navigate-тула, без submit-тула.
14 комітів за один день, нуль тестів на DOM-логіку (comboboxes/iframe/upload).

## Критичні вимоги (blocker для довіри production-сабмітам)

### 1. Tier-2 (особисті/behavioral) поля — ніколи не автогенерувати відповідь

У мене задокументований і повторюваний баг (7 разів у двох сесіях,
`feedback_ai-tool-cadence-claim.md` у career-репо): LLM вигадує
cadence/embeddedness claims ("daily", "core part of how I build") або
факти з чужого профілю, коли пише відповідь замість людини.

Приклади реальних Tier-2 питань, які я НЕ маю права заповнювати сам:
- "one decision you made that a reasonable person could disagree with" (Toggl)
- "What about Toggl and this role made you apply? And why now?" (Toggl)
- "Beyond any AI-polished answer, is there something about you..." (Toggl)

**Вимога:** якщо `ANTHROPIC_API_KEY`/`OLLAMA_HOST` заданий, `generateAnswers`
(`server/ai-generator.js`) все одно НЕ повинен автозаповнювати поле,
класифіковане як особисте/behavioral/motivational — тільки повертати його
як "потребує людини", разом із текстом питання. Canned heuristic fallback
(рядки 50-117) для таких полів — гірше за пусте поле, бо виглядає як
реальна відповідь кандидата.

Потрібна явна третя категорія полів (не Tier1 статичне, не Tier2
LLM-generated-ok) — назвемо її **Tier 3 "human-required"**: питання про
мотивацію, конкретний випадок з досвіду, "щось особисте", tradeoff-рішення.
Евристика класифікації: наявність слів "you/your experience/tell us about a
time/why do you/something about you" + відсутність конкретного факту, який
можна дістати зі структурованого профілю.

### 2. Немає submit-тула — має залишитись явно задокументованим рішенням

Підтверджено: жодної SUBMIT-команди немає ні в extension, ні в bridge, ні
в MCP surface. Це збігається з моїм жорстким правилом "ніколи не клікати
фінальний Submit без явного підтвердження користувача в чаті, кожного разу
окремо". Прошу зафіксувати це в README як навмисний security/safety
inv, не як "поки не реалізовано" — щоб майбутній контриб'ютор не додав
`submit_form` як "очевидну відсутню фічу".

### 3. Джерело candidate profile = career-репо, не окремий hardcoded стор

У мене 6 профіль-специфічних резюме
(`~/work/resume/resume/<profession>/resume-dmytro-bilukha.md`) з різним
фреймінгом одних і тих самих фактів (engineering-leadership,
ai-engineering-lead, frontend-platform-architect, fullstack-engineer,
frontend-developer, growth-engineering).

Задокументований баг **cross-profile fact bleed**
(`feedback_cross-profile-fact-bleed.md`): факт/цифра з одного профілю
(наприклад "managed 8-12 engineers, mentored 5+") просочується у заявку під
іншим профілем (frontend-developer), де цього claim'у немає.

**Вимога:** `get_candidate_profile`/`profile-loader.js` повинен приймати
параметр "який профіль зараз активний" і читати факти ЛИШЕ з відповідного
`resume-dmytro-bilukha.md`, а не з єдиного статичного `default-profile.js`.
Інакше цей інструмент відтворить баг, який я вже двічі ловив вручну через
mandatory reviewer-fork pass.

## Функціональні прогалини (реально зустрів цієї сесії)

### 4. Немає navigate(url)

Зараз я щоразу відкриваю вакансію через claude-in-chrome `navigate`, і
тільки тоді tool бачить активний таб (`chrome.tabs.query({active:true})`).
Прийнятно як гібридний workflow — я навігую дешевим інструментом, tool читає
форму — але хочу, щоб це було явно описано в README як "Крок 0: відкрий
вкладку сам/іншим інструментом", а не малося на увазі.

### 5. Async/debounced combobox не підтверджено як оброблений

Реальний кейс: Toggl "Location" — набираєш "Vinnytsia", поле показує
"Loading..." ~1-2с, тоді з'являється dropdown із suggestion'ами
("Vinnytsia, Vinnytsia Oblast, Ukraine" серед 5 схожих). Перша спроба
заповнити текстом напряму (без чекання дропдауна) стерла значення.
`selectComboboxOption` (content.js:115) обробляє MUI/virtual-scroll портали,
але не бачив підтвердження явного очікування debounce-затримки перед тим,
як шукати опції в дропдауні. Прошу explicit `waitForOptions(timeout)` крок
перед вибором.

### 6. Ashby Yes/No toggle-кнопки — це реальний toggle, не select

Пара кнопок `button[data-option="yes"|"no"]`, прив'язана до прихованого
`<input type="checkbox">`. Клік — це TOGGLE, не ідемпотентний вибір:
повторний клік по вже-true кнопці вимикає її. Я через це раз мало не
зіпсував Wayflyer-заявку (`feedback_browser-tool-selection.md` містить
точний JS-патерн: читати `input[type=checkbox].checked` СВІЖО прямо перед
кліком, і перевіряти знову прямо перед фінальним Submit).

**Вимога:** `scanFormFields` має явно класифікувати такі пари як
`type: "toggle-checkbox-pair"` (не generic radio), і `injectAIAnswers` має
читати поточний checked-стан безпосередньо перед записом кожного разу, а не
покладатись на стан, зчитаний раніше в тому ж прогоні.

### 7. Окреме поле cover letter (текст або файл) — не підтверджено

Adventure Travel 365, memoryOS, iForAI — усі мали окреме поле cover letter
(текст або file upload), відмінне від resume upload. Не бачив у описі
можливостей явної підтримки другого файлу/текстового блоку крім резюме.

### 8. Verification після filling — без повторного скану всієї форми

Люблю відсутність screenshots (економія токенів). Хочу дешевий спосіб
підтвердити "Success"/"application submitted" текст сторінки ПІСЛЯ
(ручного) сабміту — щось типу `get_submission_status()`, що читає лише
заголовок/banner-текст, а не пересканує всі поля форми заново.

## Ризик і план довіри

14 комітів за один день (2026-09-23), увесь фікс-лог — DOM edge cases
(combobox/iframe/tab-injection), нуль автотестів на DOM-логіку (тільки
`test/test-profiles.js` — чисто на профілях/генерації відповідей, без
реального браузера). Для production job applications (реальні
роботодавці, не експерименти) хочу спочатку прогнати кілька non-critical
вакансій паралельно зі старим claude-in-chrome workflow і звірити
результат поле-в-поле, перш ніж повністю переходити на цей інструмент.
