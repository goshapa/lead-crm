# -*- coding: utf-8 -*-
"""Хранилище мини-CRM: пользователи, этапы воронки, сделки (лиды),
лента событий, задачи и задачи парсинга.

Если задана переменная окружения DATABASE_URL (или POSTGRES_URL) — работает
с Postgres (облачная версия на Vercel и локальный парсер, пишущий в ту же
базу). Иначе — локальный файл SQLite leads.db.
"""

import json
import os
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
PG = bool(DATABASE_URL)
if PG:
    import psycopg
    from psycopg.rows import dict_row

    IntegrityError = psycopg.IntegrityError
else:
    IntegrityError = sqlite3.IntegrityError

DB_PATH = Path(__file__).with_name("leads.db")
TZ = ZoneInfo(os.environ.get("APP_TZ", "Asia/Tashkent"))
_lock = threading.RLock()
_local = threading.local()

DEFAULT_STAGES = [
    ("Неразобранное", "#99a6b5", "open"),
    ("Первичный контакт", "#8fd3ff", "open"),
    ("Переговоры", "#ffe373", "open"),
    ("Принимают решение", "#ffb470", "open"),
    ("Согласование договора", "#f5a6ff", "open"),
    ("Успешно реализовано", "#9be05a", "won"),
    ("Закрыто и не реализовано", "#d0d6de", "lost"),
]

# соответствие статусов из первой версии сайта этапам воронки (по порядку DEFAULT_STAGES)
_OLD_STATUS_TO_STAGE_IDX = {"new": 0, "called": 1, "interested": 2, "deal": 5, "rejected": 6}

TASK_KINDS = {"call": "Звонок", "meeting": "Встреча", "email": "Письмо", "other": "Задача"}


def now() -> str:
    # время в часовом поясе компании (по умолчанию Ташкент), а не сервера —
    # на Vercel сервер живёт в UTC
    return datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S")


def today():
    return datetime.now(TZ).date()


# ---------- выполнение запросов ----------

def _pg_conn():
    c = getattr(_local, "pg", None)
    if c is None or c.closed:
        # prepare_threshold=None — совместимость с пулером Neon (pgbouncer)
        c = _local.pg = psycopg.connect(DATABASE_URL, autocommit=True, row_factory=dict_row,
                                        prepare_threshold=None)
    return c


def _fetch(cur, mode):
    if mode == "all":
        return [dict(r) for r in cur.fetchall()]
    if mode == "one":
        r = cur.fetchone()
        return dict(r) if r else None
    if mode == "id":
        return cur.fetchone()["id"] if PG else cur.lastrowid
    return cur.rowcount


def _execute(sql: str, args=(), mode=None):
    if PG:
        sql = sql.replace("?", "%s").replace(" LIKE ", " ILIKE ")
        for attempt in (0, 1):
            try:
                return _fetch(_pg_conn().execute(sql, args), mode)
            except psycopg.OperationalError:
                _local.pg = None  # соединение оборвалось (сон Neon, таймаут) — переподключаемся
                if attempt:
                    raise
    with _lock:
        c = sqlite3.connect(DB_PATH, timeout=30)
        c.row_factory = sqlite3.Row
        try:
            c.execute("PRAGMA foreign_keys=ON")
            res = _fetch(c.execute(sql, args), mode)
            c.commit()
            return res
        finally:
            c.close()


def all_(sql: str, args=()) -> list[dict]:
    return _execute(sql, args, "all")


def one(sql: str, args=()):
    return _execute(sql, args, "one")


def run(sql: str, args=()) -> int:
    return _execute(sql, args)


def insert(table: str, data: dict) -> int:
    cols = ", ".join(data)
    marks = ", ".join("?" for _ in data)
    sql = f"INSERT INTO {table} ({cols}) VALUES ({marks})" + (" RETURNING id" if PG else "")
    return _execute(sql, tuple(data.values()), "id")


def update(table: str, row_id: int, data: dict) -> int:
    if not data:
        return 0
    cols = ", ".join(f"{k}=?" for k in data)
    return run(f"UPDATE {table} SET {cols} WHERE id=?", (*data.values(), row_id))


def add_event(lead_id: int, user_id, kind: str, text: str):
    insert("events", {"lead_id": lead_id, "user_id": user_id, "kind": kind, "text": text, "created_at": now()})


# ---------- схема ----------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id {pk},
    name TEXT NOT NULL,
    login TEXT NOT NULL UNIQUE,
    pw_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'manager',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stages (
    id {pk},
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#99a6b5',
    sort INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS jobs (
    id {pk},
    params TEXT NOT NULL,
    status TEXT NOT NULL,
    found INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    user_id INTEGER
);
CREATE TABLE IF NOT EXISTS leads (
    id {pk},
    org_id TEXT UNIQUE,
    job_id INTEGER,
    city TEXT, category_query TEXT, name TEXT,
    yandex_category TEXT, phones TEXT, address TEXT,
    rating TEXT, reviews TEXT, website TEXT, url TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    stage_id INTEGER,
    budget {bigint} NOT NULL DEFAULT 0,
    responsible_id INTEGER,
    contact_person TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    stage_changed_at TEXT,
    closed_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
    id {pk},
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    user_id INTEGER,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
    id {pk},
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    user_id INTEGER,
    created_by INTEGER,
    kind TEXT NOT NULL DEFAULT 'call',
    text TEXT NOT NULL DEFAULT '',
    due_at TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    result TEXT NOT NULL DEFAULT '',
    done_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_lead ON events(lead_id);
CREATE INDEX IF NOT EXISTS ix_tasks_lead ON tasks(lead_id);
CREATE INDEX IF NOT EXISTS ix_tasks_user ON tasks(user_id, done);
CREATE INDEX IF NOT EXISTS ix_leads_stage ON leads(stage_id)
"""


def _migrate_sqlite_v1():
    """Добавляет колонки, которых не было в первой версии сайта (лиды со статусами)."""
    have = {r["name"] for r in all_("PRAGMA table_info(leads)")}
    for name, decl in [
        ("stage_id", "INTEGER"), ("budget", "INTEGER NOT NULL DEFAULT 0"), ("responsible_id", "INTEGER"),
        ("contact_person", "TEXT NOT NULL DEFAULT ''"), ("email", "TEXT NOT NULL DEFAULT ''"),
        ("tags", "TEXT NOT NULL DEFAULT ''"), ("source", "TEXT NOT NULL DEFAULT ''"),
        ("stage_changed_at", "TEXT"), ("closed_at", "TEXT"),
    ]:
        if name not in have:
            run(f"ALTER TABLE leads ADD COLUMN {name} {decl}")
    if "user_id" not in {r["name"] for r in all_("PRAGMA table_info(jobs)")}:
        run("ALTER TABLE jobs ADD COLUMN user_id INTEGER")


def init(stop_stale_jobs: bool = True):
    schema = _SCHEMA.format(pk="SERIAL PRIMARY KEY" if PG else "INTEGER PRIMARY KEY AUTOINCREMENT",
                            bigint="BIGINT" if PG else "INTEGER")
    if not PG:
        # у старой базы таблица leads без новых колонок — сначала создаём/дополняем таблицы
        for stmt in schema.split(";"):
            if "INDEX" not in stmt:
                run(stmt)
        _migrate_sqlite_v1()
    for stmt in schema.split(";"):
        if stmt.strip():
            run(stmt)

    if one("SELECT COUNT(*) AS n FROM stages")["n"] == 0:
        for i, (name, color, kind) in enumerate(DEFAULT_STAGES):
            insert("stages", {"name": name, "color": color, "sort": i, "kind": kind})

    if not PG:
        stage_ids = [r["id"] for r in stages()]
        for old, idx in _OLD_STATUS_TO_STAGE_IDX.items():
            if idx < len(stage_ids):
                run("UPDATE leads SET stage_id=?, source=CASE WHEN source='' THEN 'Парсер Яндекс.Карт' ELSE source END, "
                    "stage_changed_at=COALESCE(stage_changed_at, updated_at) WHERE stage_id IS NULL AND status=?",
                    (stage_ids[idx], old))
        # заметки из первой версии переносим в ленту
        for r in all_("SELECT id, note, updated_at FROM leads WHERE note<>''"):
            run("INSERT INTO events (lead_id, kind, text, created_at) VALUES (?,?,?,?)",
                (r["id"], "note", r["note"], r["updated_at"]))
            run("UPDATE leads SET note='' WHERE id=?", (r["id"],))

    if stop_stale_jobs:
        # задачи парсинга, оставшиеся «в работе» после перезапуска, помечаем прерванными
        run("UPDATE jobs SET status='stopped', finished_at=? WHERE status IN ('queued','running','captcha')", (now(),))


# ---------- этапы ----------

def stages() -> list[dict]:
    return all_("SELECT * FROM stages ORDER BY sort, id")


def first_stage_id() -> int:
    s = one("SELECT id FROM stages WHERE kind='open' ORDER BY sort, id LIMIT 1") or one("SELECT id FROM stages LIMIT 1")
    return s["id"]


# ---------- задачи парсинга ----------

def create_job(params: dict, user_id=None) -> int:
    return insert("jobs", {"params": json.dumps(params, ensure_ascii=False), "status": "queued",
                           "created_at": now(), "user_id": user_id})


def update_job(job_id: int, **fields):
    update("jobs", job_id, fields)


def get_job(job_id: int):
    j = one("SELECT * FROM jobs WHERE id=?", (job_id,))
    if j:
        j["params"] = json.loads(j["params"])
    return j


def list_jobs(limit: int = 30):
    rows = all_("SELECT * FROM jobs ORDER BY id DESC LIMIT ?", (limit,))
    for r in rows:
        r["params"] = json.loads(r["params"])
    return rows


# ---------- сделки из парсера ----------

def lead_exists(org_id: str) -> bool:
    return one("SELECT 1 AS x FROM leads WHERE org_id=?", (org_id,)) is not None


def add_lead(job_id: int, row: dict, responsible_id=None) -> bool:
    """Добавляет сделку из парсера в первый этап воронки.
    Возвращает False, если такая компания уже есть в базе."""
    ts = now()
    try:
        lead_id = insert("leads", {
            "org_id": row["org_id"], "job_id": job_id, "city": row["city"],
            "category_query": row["category_query"], "name": row["name"],
            "yandex_category": row["yandex_category"], "phones": row["phones"],
            "address": row["address"], "rating": row["rating"], "reviews": row["reviews"],
            "website": row["website"], "url": row["url"],
            "stage_id": first_stage_id(), "responsible_id": responsible_id,
            "source": "Парсер Яндекс.Карт", "stage_changed_at": ts,
            "created_at": ts, "updated_at": ts,
        })
    except IntegrityError:
        return False
    add_event(lead_id, None, "system", f"Сделка создана парсером (поиск «{row['category_query']}», {row['city']})")
    return True
