# -*- coding: utf-8 -*-
"""Движок парсинга Яндекс.Карт для веб-интерфейса.

Использует селекторы и логику из parser.py, но вместо print/input
работает через журнал задачи, флаг остановки и ожидание капчи из UI.
Одновременно выполняется одна задача (в браузере одно окно).
"""

import queue
import random
import re
import threading
import time
from collections import deque

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

import db
from parser import build_search_url, is_captcha

BROWSER_CHANNEL = "msedge"
DELAY_MIN, DELAY_MAX = 1.0, 2.2


class Stopped(Exception):
    pass


class Job:
    def __init__(self, job_id: int, params: dict, user_id=None):
        self.id = job_id
        self.params = params
        self.user_id = user_id
        self.stop = threading.Event()
        self.captcha_solved = threading.Event()
        self.logs: deque = deque(maxlen=400)
        self.status = "queued"

    def log(self, msg: str):
        self.logs.append(f"{time.strftime('%H:%M:%S')}  {msg}")

    def check_stop(self):
        if self.stop.is_set():
            raise Stopped()

    def set_status(self, status: str, **fields):
        self.status = status
        db.update_job(self.id, status=status, **fields)


class Runner:
    def __init__(self):
        self.q: queue.Queue = queue.Queue()
        self.jobs: dict[int, Job] = {}
        threading.Thread(target=self._worker, daemon=True).start()

    # ---- публичное API ----
    def submit(self, params: dict, user_id=None) -> int:
        job_id = db.create_job(params, user_id)
        job = Job(job_id, params, user_id)
        job.log("Задача в очереди")
        self.jobs[job_id] = job
        self.q.put(job)
        return job_id

    def get(self, job_id: int):
        return self.jobs.get(job_id)

    def stop(self, job_id: int) -> bool:
        job = self.jobs.get(job_id)
        if not job:
            return False
        job.stop.set()
        job.captcha_solved.set()  # разбудить, если ждём капчу
        return True

    def captcha_done(self, job_id: int) -> bool:
        job = self.jobs.get(job_id)
        if not job:
            return False
        job.captcha_solved.set()
        return True

    # ---- внутреннее ----
    def _worker(self):
        while True:
            job = self.q.get()
            if job.stop.is_set():
                job.set_status("stopped", finished_at=db.now())
                continue
            try:
                self._run(job)
            except Stopped:
                job.log("Остановлено пользователем")
                job.set_status("stopped", finished_at=db.now())
            except Exception as e:  # noqa: BLE001
                job.log(f"Ошибка: {e}")
                job.set_status("error", error=str(e)[:500], finished_at=db.now())
            else:
                job.log("Готово")
                job.set_status("done", finished_at=db.now())

    def _run(self, job: Job):
        p = job.params
        job.set_status("running")
        found = processed = 0

        with sync_playwright() as pw:
            kwargs = {"headless": False}
            try:
                browser = pw.chromium.launch(channel=BROWSER_CHANNEL, **kwargs)
            except Exception as e:  # noqa: BLE001
                job.log(f"Edge не запустился ({e}), пробую Chromium")
                browser = pw.chromium.launch(**kwargs)
            try:
                context = browser.new_context(locale="ru-RU", viewport={"width": 1400, "height": 900})
                page = context.new_page()

                for category in p["categories"]:
                    job.check_stop()
                    links = self._collect_links(job, page, category)
                    db.update_job(job.id, total=db.get_job(job.id)["total"] + len(links))
                    for i, link in enumerate(links, start=1):
                        job.check_stop()
                        org_id = (re.search(r"/org/[^/]+/(\d+)/", link) or [None, ""])[1]
                        if org_id and db.lead_exists(org_id):
                            processed += 1
                            db.update_job(job.id, processed=processed)
                            job.log(f"[{i}/{len(links)}] уже в базе, пропуск")
                            continue
                        try:
                            row = self._parse_org(job, page, link, category)
                        except Stopped:
                            raise
                        except Exception as e:  # noqa: BLE001
                            job.log(f"Ошибка на {link}: {e}")
                            row = None
                        processed += 1
                        if row and (not row["website"] or not p.get("only_no_site", True)):
                            if db.add_lead(job.id, row, responsible_id=job.user_id):
                                found += 1
                                job.log(f"[{i}/{len(links)}] + {row['name']}")
                        elif row:
                            job.log(f"[{i}/{len(links)}] есть сайт — пропуск")
                        db.update_job(job.id, processed=processed, found=found)
                        time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))
            finally:
                browser.close()

    def _wait_captcha(self, job: Job, page, label: str):
        if not is_captcha(page):
            return
        job.log(f"⚠ Капча! Решите её в открытом окне браузера ({label}) и нажмите «Капча пройдена»")
        job.captcha_solved.clear()
        job.set_status("captcha")
        while not job.captcha_solved.wait(timeout=1):
            pass
        job.check_stop()
        job.set_status("running")
        job.log("Продолжаю")

    def _collect_links(self, job: Job, page, category: str) -> list[str]:
        p = job.params
        city = p["city"]
        url = build_search_url(category, city)
        job.log(f"Поиск: «{category}» · {city['name']}")
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
        except Exception as e:  # noqa: BLE001
            job.log(f"Не удалось открыть поиск ({e})")
            return []
        time.sleep(1.5)
        self._wait_captcha(job, page, f"поиск: {category}")
        try:
            page.wait_for_selector("li.search-snippet-view, .search-list-view__list", timeout=10000)
        except PlaywrightTimeoutError:
            job.log("Список результатов пуст или не загрузился")
            return []

        max_results = p["max_results"]
        links: dict[str, None] = {}
        stable, prev = 0, 0
        while len(links) < max_results and stable < 4:
            job.check_stop()
            hrefs = page.eval_on_selector_all(
                'li.search-snippet-view a.link-overlay[href*="/maps/org/"]',
                "els => els.map(e => e.href)",
            )
            for h in hrefs:
                m = re.match(r"^(https?://[^/]+/maps/org/[^/]+/\d+)/?", h)
                if m:
                    links[m.group(1) + "/"] = None
            stable = stable + 1 if len(links) == prev else 0
            prev = len(links)
            page.evaluate(
                """() => {
                    const list = document.querySelector('.search-list-view__list');
                    if (!list) return;
                    const c = list.closest('.scroll__container') || list.parentElement;
                    c.scrollTop = c.scrollHeight;
                }"""
            )
            time.sleep(0.9)
        result = list(links)[:max_results]
        job.log(f"Найдено организаций: {len(result)}")
        return result

    def _parse_org(self, job: Job, page, url: str, category: str):
        city = job.params["city"]
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
        except Exception as e:  # noqa: BLE001
            job.log(f"Не открылась карточка ({e})")
            time.sleep(3)
            return None
        time.sleep(1.4)
        self._wait_captcha(job, page, url)
        try:
            page.wait_for_selector('h1[itemprop="name"]', timeout=8000)
        except Exception:  # noqa: BLE001
            job.log(f"Карточка не загрузилась: {url}")
            return None

        data = page.evaluate(
            """() => {
                const name = document.querySelector('h1[itemprop="name"]')?.textContent?.trim() || '';
                const website = document.querySelector('a.business-urls-view__link')?.href || null;
                const addrEl = document.querySelector('.orgpage-header-view__address')
                    || document.querySelector('.business-contacts-view__address');
                let address = '';
                if (addrEl) {
                    const title = addrEl.getAttribute('title') || addrEl.getAttribute('aria-label');
                    address = title
                        ? title.replace(/\\s*·\\s*/g, ', ').replace(/\\s*на карте.*$/i, '')
                        : addrEl.innerText.replace(/\\n+/g, ', ').trim();
                }
                const phones = [...document.querySelectorAll('span[itemprop="telephone"]')]
                    .map(s => s.textContent.trim());
                const rating = document.querySelector('.business-rating-badge-view__rating-text')?.textContent?.trim() || '';
                const categories = [...document.querySelectorAll('.orgpage-categories-info-view__link')]
                    .map(e => e.textContent.trim());
                const rl = document.querySelector('a[href*="/reviews/"]');
                const reviewsText = rl ? rl.closest('div,span,li')?.textContent || '' : '';
                return { name, website, address, phones, rating, categories, reviewsText };
            }"""
        )
        reviews = re.search(r"(\d+)", data.get("reviewsText") or "")
        org_id = re.search(r"/org/[^/]+/(\d+)/", url)
        return {
            "city": city["name"],
            "category_query": category,
            "name": data.get("name") or "",
            "yandex_category": ", ".join(data.get("categories") or []),
            "phones": "; ".join(data.get("phones") or []),
            "address": data.get("address") or "",
            "rating": data.get("rating") or "",
            "reviews": reviews.group(1) if reviews else "",
            "website": data.get("website") or "",
            "org_id": org_id.group(1) if org_id else url,
            "url": url,
        }
