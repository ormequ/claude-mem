# Chroma merge-patch: durable drain вместо прямой записи из CLI

Дата: 2026-07-19
Ветка: fork-fixes
Статус: утверждён (пользователь делегировал автономную реализацию)

## Проблема

`adopt_mem` (`scripts/adopt-mem`) запускает **отдельный короткоживущий процесс**
`bun worker-service.cjs adopt`. Он:

1. Пишет `merged_into_project` в SQLite напрямую (WAL разрешает конкурентную
   запись) — успешно.
2. Пытается пропатчить зеркальную метадату в Chroma через
   `ChromaSync.updateMergedIntoProject` → `ChromaMcpManager.getInstance()`
   пытается стать **вторым writer'ом** Chroma → долгоживущий worker уже держит
   эксклюзивный writer-lock → `refusing to start a second writer` → все N
   документов падают (`chromaFailed=N`).

Наблюдаемо каждый мердж:

```
[CHROMA_MCP] ... already owned by PID 39196; refusing to start a second writer
[SYSTEM] Worktree adoption applied {... chromaUpdates=0, chromaFailed=1451}
```

Два дефекта:

- **Косметический, но пугающий:** CLI всегда падает на Chroma-шаге (он
  архитектурно не может выиграть лок при живом worker).
- **Реальная дыра в данных:** «will retry on next run» чинит только фоновая
  адаптация внутри worker, и то через **worktree-сканирование**
  (`selectObsForPatch`). Если worktree удалить сразу после `adopt_mem` (до
  ежечасного тика), периодический скан больше не найдёт его как target → N
  документов **навсегда** остаются без `merged_into_project` в Chroma. Тогда
  семантический поиск, фильтрующий по project в Chroma, не находит усыновлённые
  строки под родительским проектом.

Потери данных в SQLite нет: project-scoped запросы фильтруют через
`project = ? OR merged_into_project = ?`, усыновлённые строки видны под родителем.
Расходится только зеркало в Chroma.

## Решение: dirty-flag колонка + drain в worker

Разорвать связку «CLI пишет в Chroma». Chroma-патч становится исключительно
задачей worker (единственный держатель writer-lock), а координация идёт через
durable-флаг в SQLite — по образцу существующего `synced_at`
(`ensureSyncedAtColumns` + partial index `WHERE synced_at IS NULL`).

### Схема

Расширить `ensureMergedIntoProjectColumns()` в `SessionStore.ts`: добавить в
`observations` и `session_summaries` колонку

```
chroma_merge_synced_at INTEGER   -- NULL = требует Chroma-патча
```

и partial index:

```
CREATE INDEX IF NOT EXISTS idx_observations_merge_unsynced
  ON observations(id) WHERE merged_into_project IS NOT NULL AND chroma_merge_synced_at IS NULL
```

(аналогично для `session_summaries`). Идемпотентно, PRAGMA-guard как у соседних
миграций.

### Запись флага (adoption)

`WorktreeAdoption.ts`: UPDATE, выставляющий `merged_into_project`, одновременно
сбрасывает флаг в NULL и **больше НЕ вызывает** `updateMergedIntoProject`:

```sql
UPDATE observations
   SET merged_into_project = ?, chroma_merge_synced_at = NULL
 WHERE project = ? AND merged_into_project IS NULL
```

Гейт по наличию колонки (как уже сделано для `merged_into_project`), чтобы старая
БД до миграции не падала. `result.chromaUpdates/chromaFailed` из adoption
удаляются (патч теперь асинхронный) — CLI-вывод меняется соответственно (см.
ниже). Прямой вызов Chroma из adoption вырезается целиком → пугающая ошибка
исчезает.

### Drain (worker)

Новый модуль `src/services/sync/ChromaMergeDrain.ts`, экспорт
`drainChromaMergeQueue(store, chromaSync): Promise<{patched, groups}>`:

1. `SELECT id, merged_into_project FROM observations
      WHERE merged_into_project IS NOT NULL AND chroma_merge_synced_at IS NULL`
   (и то же для `session_summaries`), сгруппировать по `merged_into_project`.
2. Для каждой группы вызвать существующий
   `ChromaSync.updateMergedIntoProject(ids, project)` (worker in-process, лок у
   него → проходит).
3. На успех группы — `UPDATE ... SET chroma_merge_synced_at = <epoch>
      WHERE id IN (...)`.

Свойства:
- **Бэкфилл истории бесплатно:** уже усыновлённые строки имеют флаг NULL → в
  первый прогон drain их подхватит. Разовый reconcile из обсуждения покрывается
  тем же механизмом, отдельного кода не требует.
- **Нет зависимости от worktree:** drain работает по SQLite-состоянию, не по
  git-скану. Удаление worktree ничего не ломает.
- **Устойчив к лежачему worker:** флаг durable, дождётся следующего старта/тика.
- **Идемпотентно и батчами:** `updateMergedIntoProject` уже режет на
  `BATCH_SIZE`; флаг снимается только по факту успеха → падение на середине не
  теряет прогресс.
- **No-op безопасен:** если строка ещё не в Chroma (смерджена до первой
  синхронизации), `chroma_get_documents` вернёт пусто, патч — no-op, флаг
  снимается. Нормальный insert-путь `ChromaSync` и так кладёт
  `merged_into_project` из SQLite (`obs.merged_into_project ?? null`), так что
  такая строка попадёт в Chroma уже с меткой.

### Вызовы drain

`worker-service.ts`: после существующей стартовой адаптации — один
`drainChromaMergeQueue`. `AdoptionScheduler.startPeriodicAdoption`: после каждого
adoption-прохода вызывать drain (тот же процесс = лок у него). Ошибки drain
логируются `warn`, не валят worker; флаг остаётся NULL → повтор на следующем тике.

### CLI-вывод

`worker-service.ts` adopt-ветка: убрать строки `Chroma docs updated` /
`Chroma sync failures`. Вместо них — нейтральное:

```
  Chroma patch:         queued (worker applies on next tick)
```

Так вывод честен: CLI больше не претендует патчить Chroma сам.

## Границы / не входит

- Смена `merged_into_project` на другого родителя (повторное усыновление в другой
  проект) вне сценария; т.к. UPDATE гейтится `merged_into_project IS NULL`, второй
  мердж и так не тронет строку — поведение не регрессирует, отдельно не решаем.
- Устранение single-writer-архитектуры Chroma не трогаем — лок остаётся,
  меняем только кто и когда пишет.

## Тесты

- `SessionStore`: миграция добавляет колонку + индекс, идемпотентна на повторном
  init.
- `WorktreeAdoption`: adoption выставляет `merged_into_project` **и** сбрасывает
  `chroma_merge_synced_at` в NULL; Chroma напрямую не дёргается (мок
  ChromaMcpManager не вызывается).
- `ChromaMergeDrain`: (a) группирует dirty-строки по проекту и зовёт
  `updateMergedIntoProject` на группу; (b) снимает флаг только на успех; (c) при
  ошибке группы флаг остаётся NULL; (d) пустая очередь → no-op; (e) бэкфилл:
  предвыставленные строки с NULL-флагом подхватываются.
- `AdoptionScheduler`: тик зовёт drain после adoption.

## Файлы

- `src/services/sqlite/SessionStore.ts` — колонка + индекс в
  `ensureMergedIntoProjectColumns`.
- `src/services/infrastructure/WorktreeAdoption.ts` — флаг в UPDATE, вырезать
  прямой Chroma-вызов и counters.
- `src/services/sync/ChromaMergeDrain.ts` — новый drain.
- `src/services/infrastructure/AdoptionScheduler.ts` — drain после adoption.
- `src/services/worker-service.ts` — стартовый drain + CLI-вывод.
- Тесты в `tests/services/**`.
